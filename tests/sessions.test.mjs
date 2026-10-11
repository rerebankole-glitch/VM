import test from "node:test";
import assert from "node:assert/strict";
import { getEntry } from "../app/catalog.js";
import { bundledSource } from "../app/sources.js";
import { SessionStore, SESSION_LIMIT_BYTES, canRememberSession, sessionMetadata, validateSession } from "../app/sessions.js";

const machine = {
    memoryMB: 32, vgaMB: 4, bootOrder: "auto", nicType: "ne2k", netBackend: "none",
    customRelayUrl: "", acpi: false, sound: false, disableJit: false, instantBoot: true, diskMode: "auto",
};
const active = () => ({ osId: "kolibrios", machine: { ...machine }, source: bundledSource(getEntry("kolibrios")), diskMode: "none" });
const metadata = () => sessionMetadata(active(), "0.5.471", 32, 1_800_000_000_000);

test("session metadata contains enough exact configuration to reopen a built-in machine", () => {
    const original = active();
    const saved = sessionMetadata(original, "0.5.471", 32);
    assert.equal(validateSession(saved, "0.5.471"), saved);
    assert.equal(saved.osId, original.osId);
    assert.deepEqual(saved.machine, original.machine);
    original.machine.memoryMB = 512;
    assert.equal(saved.machine.memoryMB, 32, "metadata must not follow later form changes");
    assert.equal(Object.hasOwn(saved.source, "file"), false);
});

test("only automatically reopenable sources without an extra disk can be remembered", () => {
    assert.equal(canRememberSession(active()), true);
    assert.equal(canRememberSession(null), false);
    const withDisk = { ...active(), diskMode: "new" };
    assert.equal(canRememberSession(withDisk), false);
    const withFile = { ...active(), source: { kind: "file", file: {}, sizeBytes: 2000 } };
    assert.equal(canRememberSession(withFile), false);
    assert.throws(() => sessionMetadata(withFile, "0.5.471", 32), /local ISO|Download state/);
    const withUrl = { ...active(), source: { kind: "url", url: "https://example.org/image.iso", sizeBytes: 2000, acceptRanges: true } };
    assert.equal(canRememberSession(withUrl), true);
    withUrl.source.acceptRanges = false;
    assert.equal(canRememberSession(withUrl), false);
});

test("bad versions, sizes and dates are rejected before boot", () => {
    for (const values of [
        { version: 2 }, { coreVersion: "0.0.1" }, { osId: "made-up-os" },
        { bytes: 0 }, { bytes: -1 }, { bytes: SESSION_LIMIT_BYTES + 1 }, { createdAt: NaN },
    ]) assert.throws(() => validateSession({ ...metadata(), ...values }, "0.5.471"));
    assert.throws(() => validateSession(null, "0.5.471"));
});

test("invalid RAM, video, devices and machine flags cannot enter a resumed VM", () => {
    for (const values of [
        { memoryMB: 99999 }, { vgaMB: 99999 }, { bootOrder: "magic" }, { netBackend: "magic" },
        { nicType: "magic" }, { sound: "true" }, { customRelayUrl: null },
    ]) assert.throws(() => validateSession({ ...metadata(), machine: { ...machine, ...values } }, "0.5.471"), /machine settings/);
});

test("bundled image URLs and sizes must still match the catalogue", () => {
    const saved = metadata();
    assert.throws(() => validateSession({ ...saved, source: { ...saved.source, url: "https://example.org/replacement.iso" } }, "0.5.471"), /changed/);
    assert.throws(() => validateSession({ ...saved, source: { ...saved.source, sizeBytes: 10 } }, "0.5.471"), /changed/);
    assert.throws(() => validateSession({ ...saved, source: { ...saved.source, device: "cdrom" } }, "0.5.471"), /image configuration/);
});

test("streamed session sources must use HTTP(S), a verified size and the same device", () => {
    const source = { kind: "url", label: "Mint legacy", url: "https://example.org/mint.iso", device: "cdrom", acceptRanges: true, sizeBytes: 2_000_000_000 };
    const saved = { ...metadata(), osId: "mint-19.3-xfce-32", source };
    assert.equal(validateSession(saved, "0.5.471"), saved);
    for (const url of ["javascript:alert(1)", "file:///private.iso", "https://private:secret@example.org/image.iso", "http://"]) {
        assert.throws(() => validateSession({ ...saved, source: { ...source, url } }, "0.5.471"), /URL/);
    }
    assert.throws(() => validateSession({ ...saved, source: { ...source, sizeBytes: 0 } }, "0.5.471"), /cannot be reopened/);
});

test("storage-disabled browsers can run but cannot save/read a local session", async () => {
    const store = new SessionStore({ indexedDB: null, storage: null });
    assert.equal(store.supported, false);
    await assert.rejects(store.summary(), /unavailable/);
    await assert.rejects(store.read(), /unavailable/);
    await assert.rejects(store.clear(), /unavailable/);
});

test("size and quota guards run before opening or writing a browser database", async () => {
    let opened = false;
    const store = new SessionStore({
        indexedDB: { open() { opened = true; throw new Error("should not open"); } },
        storage: { async estimate() { return { quota: 100, usage: 99 }; } },
    });
    await assert.rejects(store.save({ bytes: 0 }, new ArrayBuffer(0)), /limit/);
    await assert.rejects(store.save({ bytes: SESSION_LIMIT_BYTES + 1 }, new ArrayBuffer(32)), /limit/);
    await assert.rejects(store.save({ bytes: 32 }, new ArrayBuffer(32)), /Not enough free/);
    assert.equal(opened, false);
});


test("filesystem guests cannot accidentally opt into unsupported local persistence", () => {
    assert.equal(canRememberSession({ diskMode: "none", source: { kind: "filesystem" } }), false);
    assert.throws(() => validateSession({ osId: "alpine-browser", source: { kind: "bundled" } }, "0.5.471"), /does not yet support/);
});

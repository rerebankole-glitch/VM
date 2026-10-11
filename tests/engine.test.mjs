import test from "node:test";
import assert from "node:assert/strict";
import { VmEngine } from "../app/engine.js";

const config = { image: { url: "fixture.iso" }, device: "cdrom", memoryMB: 32, vgaMB: 4, bootOrder: 0, sound: false };
class FakeV86 {
    static instances = [];
    constructor(options) {
        this.options = options;
        this.events = new Map();
        this.calls = [];
        this.failSave = false;
        this.failRestore = false;
        FakeV86.instances.push(this);
    }
    add_listener(name, callback) { this.events.set(name, callback); }
    emit(name, detail) { this.events.get(name)?.(detail); }
    keyboard_set_enabled(value) { this.keyboard = value; }
    mouse_set_enabled(value) { this.mouse = value; }
    async run() { this.calls.push("run"); this.emit("emulator-started"); }
    async stop() { this.calls.push("stop"); this.emit("emulator-stopped"); }
    async destroy() { this.calls.push("destroy"); this.emit("emulator-stopped"); }
    async save_state() { this.calls.push("save"); if (this.failSave) throw new Error("save failed"); return new ArrayBuffer(16); }
    async restore_state() { this.calls.push("restore"); if (this.failRestore) throw new Error("restore failed"); }
    async keyboard_send_text(text) { assert.equal(this.keyboard, true); this.calls.push(`text:${text}`); }
    keyboard_send_scancodes() {}
}

async function fixture(run, options = {}) {
    const previous = globalThis.window;
    globalThis.window = { V86: FakeV86 };
    FakeV86.instances = [];
    const statuses = [];
    const engine = new VmEngine({ container: {}, hooks: { onState: (status) => statuses.push(status) }, ...options });
    try { await run({ engine, statuses }); }
    finally { await engine.destroy(); if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
}

async function boot(engine, extra = {}) {
    const pending = engine.boot({ ...config, ...extra });
    const instance = FakeV86.instances.at(-1);
    instance.emit("emulator-ready");
    await pending;
    return instance;
}

test("boot is readiness-bounded, starts explicitly and never captures input automatically", async () => {
    await fixture(async ({ engine, statuses }) => {
        let settled = false;
        const pending = engine.boot(config).then(() => { settled = true; });
        const instance = FakeV86.instances[0];
        await Promise.resolve();
        assert.equal(settled, false);
        assert.equal(instance.options.autostart, false, "a late load must not start an orphan CPU");
        assert.equal(instance.keyboard, false);
        assert.equal(instance.mouse, false);
        instance.emit("emulator-ready");
        await pending;
        assert.equal(engine.isRunning, true);
        assert.deepEqual(instance.calls, ["run"]);
        assert.deepEqual(statuses, ["loading", "ready", "running"]);
    });
});

test("a restoring boot stays stopped until explicitly resumed", async () => {
    await fixture(async ({ engine }) => {
        const instance = await boot(engine, { autostart: false });
        assert.equal(engine.state, "ready");
        assert.deepEqual(instance.calls, []);
        await engine.restoreState(new ArrayBuffer(16));
        assert.deepEqual(instance.calls, ["restore"]);
        await engine.run();
        assert.equal(engine.isRunning, true);
    });
});

test("download errors settle initialization instead of leaving Boot permanently busy", async () => {
    await fixture(async ({ engine }) => {
        const pending = engine.boot(config);
        FakeV86.instances[0].emit("download-error", { file_name: "fixture.iso" });
        await assert.rejects(pending, /Could not load fixture.iso/);
        assert.equal(engine.state, "error");
    });
});

test("an initialization timeout is not an unbounded wait", async () => {
    await fixture(async ({ engine }) => {
        await assert.rejects(engine.boot(config), /initialize in time/);
        assert.equal(engine.state, "error");
    }, { startupTimeoutMs: 10 });
});

test("destroy cancels a pending boot and stale events cannot affect another machine", async () => {
    await fixture(async ({ engine, statuses }) => {
        const pending = engine.boot(config);
        const rejected = assert.rejects(pending, /cancelled/);
        const old = FakeV86.instances[0];
        await engine.destroy();
        await rejected;
        const current = await boot(engine);
        const before = [...statuses];
        old.emit("emulator-ready");
        old.emit("emulator-stopped");
        old.emit("download-error", { file_name: "old.iso" });
        assert.deepEqual(statuses, before);
        assert.equal(engine.v86, current);
        assert.equal(engine.isRunning, true);
    });
});

test("saving and restoring running CPUs pause before the snapshot and resume afterwards", async () => {
    await fixture(async ({ engine }) => {
        const instance = await boot(engine);
        instance.calls = [];
        const buffer = await engine.saveState();
        assert.equal(buffer.byteLength, 16);
        assert.deepEqual(instance.calls, ["stop", "save", "run"]);
        instance.calls = [];
        await engine.restoreState(buffer);
        assert.deepEqual(instance.calls, ["stop", "restore", "run"]);
    });
});

test("failed snapshots resume a previously running CPU but preserve an already paused one", async () => {
    await fixture(async ({ engine }) => {
        const instance = await boot(engine);
        instance.failSave = true;
        instance.calls = [];
        await assert.rejects(engine.saveState(), /save failed/);
        assert.deepEqual(instance.calls, ["stop", "save", "run"]);
        instance.failRestore = true;
        instance.calls = [];
        await assert.rejects(engine.restoreState(new ArrayBuffer(16)), /restore failed/);
        assert.deepEqual(instance.calls, ["stop", "restore", "run"]);
        await engine.pause();
        instance.failSave = false;
        instance.calls = [];
        await engine.saveState();
        assert.deepEqual(instance.calls, ["save"]);
        assert.equal(engine.state, "paused");
    });
});

test("pointer lock uses the supplied viewport and handles raw-movement rejection", async () => {
    await fixture(async ({ engine }) => {
        const calls = [];
        await engine.lockMouse({ async requestPointerLock(options) { calls.push(options); if (options) throw new Error("not supported"); } });
        assert.deepEqual(calls, [{ unadjustedMovement: true }, undefined]);
        await assert.rejects(engine.lockMouse({}), /not supported/);
    });
});


test("reviewed text works with host input disabled and does not leave the adapter capturing", async () => {
    await fixture(async ({ engine }) => {
        const instance = await boot(engine);
        instance.calls = [];
        await engine.sendText("A\r\n\t");
        assert.deepEqual(instance.calls, ["text:A", "text:\n", "text: ", "text: ", "text: ", "text: "]);
        assert.equal(engine.keyboardEnabled, false);
        assert.equal(instance.keyboard, false);
        await assert.rejects(engine.sendText("not ASCII: café"), /US-ASCII/);
        await assert.rejects(engine.sendText("a".repeat(5001)), /5,000/);
        engine.setKeyboardEnabled(true);
        await engine.sendText("a");
        assert.equal(engine.keyboardEnabled, true, "preserve already focused guest input");
        await engine.pause();
        await assert.rejects(engine.sendText("a"), /Resume/);
    });
});


test("demand-loaded Linux boots its kernel from the 9p filesystem, not a fake ISO descriptor", async () => {
    await fixture(async ({ engine }) => {
        const filesystem = { baseurl: "assets/guest/rootfs/", basefs: { url: "assets/guest/fs.json" } };
        const instance = await boot(engine, { image: undefined, device: "filesystem", filesystem, cmdline: "root=host9p" });
        assert.deepEqual(instance.options.filesystem, filesystem);
        assert.equal(instance.options.bzimage_initrd_from_filesystem, true);
        assert.equal(instance.options.cmdline, "root=host9p");
        assert.equal(instance.options.cdrom, undefined);
        assert.equal(instance.options.hda, undefined);
        assert.equal(engine.isRunning, true);
    });
});

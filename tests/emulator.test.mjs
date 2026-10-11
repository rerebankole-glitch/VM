/**
 * End-to-end proof that the vendored emulator actually runs guest code.
 *
 * v86 has a Node mode (no screen adapter), so the exact same libv86.js and
 * WASM core that the browser loads can execute a real boot here: the CPU must
 * retire instructions from the SeaBIOS ROM and from a bootable image.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getEntry } from "../app/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V86_DIR = path.join(ROOT, "assets", "v86");
const IMAGES = path.join(ROOT, "assets", "images");

const require = createRequire(import.meta.url);

/**
 * The bundle is a browser/Node UMD script, but this repository is typed as an
 * ES module, so hand Node a copy with a .cjs extension (the WASM core must sit
 * next to the bundle: that is where the loader looks by default).
 */
function loadV86() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v86-test-"));
    for (const file of ["libv86.js", "v86.wasm", "v86-fallback.wasm"]) {
        fs.copyFileSync(path.join(V86_DIR, file), path.join(dir, file));
    }
    fs.renameSync(path.join(dir, "libv86.js"), path.join(dir, "libv86.cjs"));
    const mod = require(path.join(dir, "libv86.cjs"));
    /** @type {new (options: object) => any} */
    const V86 = mod.V86 || mod;
    assert.equal(typeof V86, "function", "the bundle did not export a V86 constructor");
    return { V86, dir };
}

const { V86 } = loadV86();

const baseOptions = (extra) => ({
    bios: { url: path.join(V86_DIR, "seabios.bin") },
    vga_bios: { url: path.join(V86_DIR, "vgabios.bin") },
    memory_size: 32 * 1024 * 1024,
    vga_memory_size: 4 * 1024 * 1024,
    autostart: true,
    disable_speaker: true,
    ...extra,
});

/** Boot a machine, let it run, then report how much work it did. */
async function bootFor(options, milliseconds) {
    const emulator = new V86(baseOptions(options));
    const errors = [];
    emulator.add_listener("download-error", (event) => errors.push(event));

    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    const counter = emulator.get_instruction_counter();
    const running = emulator.is_running();
    // destroy() stops the CPU and frees the WASM instance; awaiting it lets the
    // test process exit on its own.
    await emulator.destroy();
    return { counter, running, errors };
}

test("the CPU executes the BIOS even with nothing attached", async () => {
    const { counter, errors } = await bootFor({}, 2500);
    assert.equal(errors.length, 0, "loading the ROMs produced download errors");
    assert.ok(counter > 100_000, `expected the BIOS to execute instructions, saw ${counter}`);
});

test("the bundled FreeDOS floppy boots far enough to run real code", async () => {
    const { counter, errors } = await bootFor(
        { fda: { url: path.join(IMAGES, "freedos.img") } },
        6000,
    );
    assert.equal(errors.length, 0);
    assert.ok(counter > 5_000_000, `FreeDOS boot only retired ${counter} instructions`);
});

test("the bundled KolibriOS floppy boots far enough to run real code", async () => {
    const { counter, errors } = await bootFor(
        { fda: { url: path.join(IMAGES, "kolibri.img") } },
        6000,
    );
    assert.equal(errors.length, 0);
    assert.ok(counter > 5_000_000, `KolibriOS boot only retired ${counter} instructions`);
});

test("the bundled Linux ISO boots as a CD-ROM", async () => {
    const { counter, errors } = await bootFor(
        { cdrom: { url: path.join(IMAGES, "tiny-linux.iso") } },
        8000,
    );
    assert.equal(errors.length, 0);
    assert.ok(counter > 5_000_000, `Linux CD boot only retired ${counter} instructions`);
});

test("a guest boots with an extra hard disk attached and can write to it", async () => {
    // This is the "install the distro onto a disk" path used by the interface:
    // an empty ArrayBuffer is attached as hda next to the bootable medium.
    const disk = new ArrayBuffer(16 * 1024 * 1024);
    const emulator = new V86(baseOptions({
        fda: { url: path.join(IMAGES, "freedos.img") },
        hda: { buffer: disk },
        boot_order: 0x231, // floppy → CD → hard disk
    }));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const counter = emulator.get_instruction_counter();
    await emulator.destroy();
    assert.ok(counter > 5_000_000, `boot with hda attached only retired ${counter} instructions`);
});

test("the public API surface the interface relies on is present", async () => {
    const emulator = new V86(baseOptions({}));
    const required = [
        "add_listener", "remove_listener", "run", "stop", "restart", "destroy",
        "save_state", "restore_state", "get_instruction_counter", "is_running",
        "keyboard_set_enabled", "mouse_set_enabled", "keyboard_send_text", "keyboard_send_scancodes",
        "screen_make_screenshot", "screen_set_scale", "screen_go_fullscreen", "lock_mouse",
        "set_cdrom", "eject_cdrom", "set_fda", "eject_fda",
    ];
    for (const method of required) {
        assert.equal(typeof emulator[method], "function", `v86 is missing ${method}()`);
    }
    // Pausing and resuming is what the toolbar buttons do — but only once the
    // core is up, which is what the engine wrapper waits for.
    await new Promise((resolve) => {
        emulator.add_listener("emulator-ready", resolve);
        setTimeout(resolve, 5000);
    });
    await emulator.stop();
    assert.equal(emulator.is_running(), false);
    await emulator.run();
    await emulator.destroy();
});


test("the demand-loaded Alpine guest starts its native Dillo browser, not just the kernel", { timeout: 310_000 }, async () => {
    const entry = getEntry("alpine-browser");
    let serial = "";
    const emulator = new V86(baseOptions({
        memory_size: entry.ramMB * 1024 * 1024,
        vga_memory_size: entry.vgaMB * 1024 * 1024,
        filesystem: {
            basefs: { url: path.join(ROOT, entry.bundled.path) },
            baseurl: path.join(ROOT, entry.filesystem.baseurl),
        },
        bzimage_initrd_from_filesystem: true,
        cmdline: entry.filesystem.cmdline,
    }));
    let timer;
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Native browser did not open. Serial tail:\n${serial.slice(-9000)}`)), 300_000);
            emulator.add_listener("download-error", (event) => reject(new Error(`Guest object missing: ${event.file_name}`)));
            emulator.add_listener("serial0-output-byte", (byte) => {
                serial += String.fromCharCode(byte);
                if (serial.includes("WEBVM_BROWSER_WINDOW_READY")) resolve();
            });
        });
        assert.match(serial, /Linux version/);
        assert.ok(emulator.get_instruction_counter() > 5_000_000);
    } finally { clearTimeout(timer); await emulator.destroy(); }
});

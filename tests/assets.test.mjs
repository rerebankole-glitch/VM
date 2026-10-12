import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V86_DIR = path.join(ROOT, "assets", "v86");
const IMAGES_DIR = path.join(ROOT, "assets", "images");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("v86 build is vendored with everything the app loads", () => {
    const required = [
        "libv86.js",
        "v86.wasm",
        "v86-fallback.wasm",
        "seabios.bin",
        "vgabios.bin",
        "LICENSE-v86.txt",
        "COPYING.LESSER",
        "VERSION",
    ];
    for (const file of required) {
        const full = path.join(V86_DIR, file);
        assert.ok(fs.existsSync(full), `missing assets/v86/${file} — run npm run vendor`);
        assert.ok(fs.statSync(full).size > 0, `assets/v86/${file} is empty`);
    }
});

test("the wasm core is a real WebAssembly module and matches its version", () => {
    const wasm = fs.readFileSync(path.join(V86_DIR, "v86.wasm"));
    // Magic number \0asm
    assert.equal(wasm.subarray(0, 4).toString("binary"), "\0asm");
    const version = fs.readFileSync(path.join(V86_DIR, "VERSION"), "utf8").trim();
    assert.match(version, /^\d+\.\d+\.\d+$/, "VERSION should hold a plain semver");
    assert.ok(fs.statSync(path.join(V86_DIR, "libv86.js")).size > 100_000);
});

test("the bundle exports V86 for browsers and Node", () => {
    const source = fs.readFileSync(path.join(V86_DIR, "libv86.js"), "utf8");
    assert.ok(source.includes("window.V86") || source.includes('window["V86"]'), "browser global missing");
    assert.ok(source.includes('module.exports["V86"]') || source.includes("exports.V86"), "CommonJS export missing");
});

test("the 64-bit v86_64 core is vendored next to the 32-bit emulator", () => {
    const dir = path.join(ROOT, "assets", "v86_64");
    for (const file of ["libv86.js", "v86.wasm", "v86-fallback.wasm", "v86-mem64.wasm", "VERSION"]) {
        const full = path.join(dir, file);
        assert.ok(fs.existsSync(full), `missing assets/v86_64/${file}`);
        assert.ok(fs.statSync(full).size > 0, `assets/v86_64/${file} is empty`);
    }
    const wasm = fs.readFileSync(path.join(dir, "v86.wasm"));
    assert.equal(wasm.subarray(0, 4).toString("binary"), "\0asm");
    assert.ok(wasm.length > 1_000_000, "v86_64 wasm is too small");
    const source = fs.readFileSync(path.join(dir, "libv86.js"), "utf8");
    assert.ok(source.includes("window.V86") || source.includes('window["V86"]'));
    assert.ok(fs.statSync(path.join(dir, "libv86.js")).size > 100_000);
});

test("demo images match their recorded checksums", () => {
    const sumsPath = path.join(IMAGES_DIR, "SHA256SUMS");
    assert.ok(fs.existsSync(sumsPath), "assets/images/SHA256SUMS is missing");

    const lines = fs.readFileSync(sumsPath, "utf8").trim().split("\n");
    assert.ok(lines.length >= 3, "expected at least three demo images");

    for (const line of lines) {
        const [expected, name] = line.trim().split(/\s+/);
        const file = path.join(IMAGES_DIR, name);
        assert.ok(fs.existsSync(file), `missing assets/images/${name}`);
        assert.equal(sha256(file), expected, `checksum mismatch for ${name}`);
    }
});

test("vendored assets stay bounded, including every on-demand filesystem file", () => {
    const files = [];
    const walk = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, item.name);
            if (item.isDirectory()) walk(file);
            else files.push(file);
        }
    };
    for (const dir of ["assets/v86", "assets/v86_64", "assets/images"]) walk(path.join(ROOT, dir));
    const total = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
    assert.ok(total < 110 * 1024 * 1024, `vendored assets are ${(total / 1e6).toFixed(1)} MB — too big to commit`);
    assert.ok(files.length < 5000, "the static guest must not become an unbounded generated dataset");
});

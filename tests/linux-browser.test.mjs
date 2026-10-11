import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getEntry } from "../app/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "assets/images/alpine-browser");
const index = JSON.parse(fs.readFileSync(path.join(DIR, "fs.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));

function nodeAt(name) {
    let children = index.fsroot, node;
    for (const part of name.split("/").filter(Boolean)) {
        assert.ok(Array.isArray(children), `missing directory in ${name}`);
        node = children.find((item) => item[0] === part);
        assert.ok(node, `missing guest file ${name}`);
        children = node[6];
    }
    return node;
}

function allFiles(nodes) {
    return nodes.flatMap((node) => Array.isArray(node[6]) ? allFiles(node[6]) : (node[3] & 0xf000) === 0x8000 ? [node] : []);
}

test("the Linux desktop ships its kernel, browser, window manager and real local pages", () => {
    assert.equal(index.version, 3, "the index must match the vendored v86 filesystem API");
    assert.match(manifest.alpineVersion, /^3\.23\./);
    assert.equal(manifest.architecture, "x86");
    for (const file of ["/boot/vmlinuz-virt", "/boot/initramfs-virt", "/usr/bin/dillo", "/usr/bin/fluxbox",
        "/usr/bin/Xorg", "/usr/bin/xterm", "/root/.xinitrc", "/opt/webvm/welcome.html", "/opt/webvm/test.html",
        "/opt/webvm/licenses/GPL-3.0-or-later.txt"]) {
        nodeAt(file);
    }
    assert.ok(manifest.packages.some((name) => /^dillo-3\./.test(name)));
    assert.ok(manifest.packages.some((name) => /^linux-virt-/.test(name)));
    assert.equal(getEntry("alpine-browser").sizeBytes, manifest.compressedBytes);
});

test("every regular filesystem object exists, is compressed and cannot escape its directory", () => {
    const files = allFiles(index.fsroot);
    assert.ok(files.length > 100, "expected a genuine Linux userspace, not a placeholder");
    for (const node of files) {
        assert.match(node[6], /^[a-f0-9]{10}\.bin\.zst$/, `unsafe/missing object for ${node[0]}`);
        const bytes = fs.readFileSync(path.join(DIR, "rootfs", node[6]));
        assert.deepEqual([...bytes.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd], "object must be real Zstandard data");
    }
});

test("the Linux payload has exact deployed checksums and a corresponding-source release", () => {
    const lines = fs.readFileSync(path.join(DIR, "SHA256SUMS"), "utf8").trim().split("\n");
    const names = new Set();
    for (const line of lines) {
        const [hash, name] = line.split(/\s+/);
        assert.match(name, /^(?:fs\.json|manifest\.json|rootfs\/[a-f0-9]{10}\.bin\.zst)$/);
        const bytes = fs.readFileSync(path.join(DIR, name));
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), hash, name);
        names.add(name);
    }
    assert.ok(names.has("fs.json"));
    assert.ok(names.has("manifest.json"));
    for (const file of fs.readdirSync(path.join(DIR, "rootfs"))) assert.ok(names.has(`rootfs/${file}`));
    assert.match(manifest.v86ToolsCommit, /^[a-f0-9]{40}$/);
    assert.match(manifest.sourceUrl, /^https:\/\/github\.com\/rerebankole-glitch\/VM\/releases\/download\/alpine-browser-sources-[a-z0-9-]+\/alpine-browser-sources\.tar\.zst$/);
    assert.match(manifest.apkDatabase, /P:dillo\n/);
});

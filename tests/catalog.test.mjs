import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CATALOG, CASPER_LIVE, RELAY_IDS, UNSUPPORTED, getEntry, groupedCatalog } from "../app/catalog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every catalogue entry is complete and unique", () => {
    const ids = new Set();
    for (const entry of CATALOG) {
        assert.ok(entry.id, "entry without id");
        assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
        ids.add(entry.id);

        for (const field of ["name", "version", "family", "desktop", "arch", "status", "summary"]) {
            assert.equal(typeof entry[field], "string", `${entry.id}.${field} should be a string`);
            assert.ok(entry[field].length > 0, `${entry.id}.${field} is empty`);
        }

        assert.ok(["instant", "works", "tricky"].includes(entry.status), `${entry.id} has an odd status`);
        assert.ok(Number.isFinite(entry.ramMB) && entry.ramMB >= 16, `${entry.id} needs a sane ramMB`);
        assert.ok([16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192].includes(entry.ramMB), `${entry.id} ramMB must be a v86 memory size`);
        assert.ok(Array.isArray(entry.notes), `${entry.id}.notes should be a list`);
    }
});

test("the three requested distributions are present with a 32-bit release", () => {
    for (const needle of ["mx", "lubuntu", "mint"]) {
        const entry = CATALOG.find((item) => item.id.includes(needle));
        assert.ok(entry, `no catalogue entry for ${needle}`);
        assert.equal(entry.arch, "i386", `${needle} must be a 32-bit release`);
        assert.ok(entry.links.some((link) => link.url.includes(".iso") || link.kind === "page"), `${needle} needs a download link`);
    }
});

test("ubuntu and mint are first-class 32-bit live guests with direct kernel boot", () => {
    const ubuntu = getEntry("ubuntu-18.04.5-i386");
    const mint = getEntry("mint-19.3-xfce-32");
    const lubuntu = getEntry("lubuntu-18.04.5-i386");
    for (const entry of [ubuntu, mint, lubuntu]) {
        assert.ok(entry, "missing ubuntu-family catalogue entry");
        assert.equal(entry.arch, "i386");
        assert.equal(entry.device, "cdrom");
        assert.deepEqual(entry.live.kernel, CASPER_LIVE.kernel);
        assert.match(entry.live.cmdline, /boot=casper/);
        assert.match(entry.live.cmdline, /console=ttyS0/);
        assert.equal(entry.bootOrder, "cd");
        assert.equal(entry.acpi, false);
        assert.ok(entry.links.some((link) => link.kind === "direct" && /\.iso(\/download)?$/.test(link.url)));
    }
    assert.ok(ubuntu.legacy && mint.legacy);
    assert.ok(RELAY_IDS.includes(ubuntu.id) && RELAY_IDS.includes(mint.id));
    assert.equal(new Set(CATALOG.map((entry) => entry.id)).size, CATALOG.length, "duplicate catalogue ids");
});

test("instant entries ship an image that really exists on disk", () => {
    const instant = CATALOG.filter((entry) => entry.status === "instant");
    assert.ok(instant.length >= 3, "expected at least three built-in systems");

    for (const entry of instant) {
        assert.ok(entry.bundled?.path, `${entry.id} has no bundled path`);
        const file = path.join(ROOT, entry.bundled.path);
        assert.ok(fs.existsSync(file), `missing ${entry.bundled.path}`);
        if (entry.filesystem) {
            const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "manifest.json"), "utf8"));
            assert.equal(manifest.compressedBytes, entry.sizeBytes, "catalogue size should describe the compressed Linux payload");
        } else {
            assert.equal(fs.statSync(file).size, entry.sizeBytes, `${entry.id}: recorded size does not match the file`);
        }
        assert.equal(entry.bundled.fileName, entry.bundled.path.split("/").pop());
        assert.ok(["cdrom", "fda", "hda", "filesystem"].includes(entry.device), `${entry.id} has an unsupported device`);
    }
});

test("non-bundled entries link to downloadable images", () => {
    for (const entry of CATALOG.filter((item) => item.status !== "instant")) {
        assert.ok(entry.links.length > 0, `${entry.id} has no links`);
        for (const link of entry.links) {
            assert.match(link.url, /^https?:\/\//, `${entry.id}: ${link.url} is not a web link`);
            assert.ok(["direct", "page"].includes(link.kind), `${entry.id}: link kind should be direct or page`);
        }
        // Entries whose file names rotate (Debian point releases, Tiny Core
        // versions, Alpine builds) may link to a download page or folder listing
        // instead of a single file — but then it must be a download location.
        const direct = entry.links.some((link) => link.kind === "direct");
        const listing = entry.links.some(
            (link) => link.url.endsWith("/") || /download/i.test(link.url),
        );
        assert.ok(direct || listing, `${entry.id} needs a direct file, a folder listing or a download page`);
        assert.ok(entry.sizeBytes > 1024, `${entry.id} needs a plausible size`);
    }

    // The three distributions this project exists for must be one click away.
    for (const needle of ["mx", "lubuntu", "mint"]) {
        const entry = CATALOG.find((item) => item.id.includes(needle));
        assert.ok(
            entry.links.some((link) => link.kind === "direct" && /\.iso(\/download)?$/.test(link.url)),
            `${needle} should link straight at its .iso file`,
        );
    }
});

test("64-bit releases are listed as blocked, never as bootable", () => {
    assert.ok(UNSUPPORTED.length >= 3);
    for (const item of UNSUPPORTED) {
        assert.equal(item.status, "blocked");
        assert.ok(item.reason.length > 20, `${item.id} needs an explanation`);
        assert.ok(!CATALOG.some((entry) => entry.id === item.id), `${item.id} must not also be bootable`);
    }
    // 64-bit guests are allowed only when they opt into the v86_64 core.
    // Official v86 has no long mode — do not list amd64 desktops as bootable.
    for (const entry of CATALOG) {
        if (entry.emulator === "v86_64") {
            assert.match(entry.arch, /x86_64/, `${entry.id} uses v86_64 but is not x86_64`);
            assert.equal(entry.requiresLongMode, true);
            continue;
        }
        assert.ok(!/x86_64|amd64|x64/.test(entry.arch), `${entry.id} claims a 64-bit architecture without emulator: v86_64`);
    }
});

test("catalogue lookups and grouping behave", () => {
    assert.equal(getEntry("tiny-linux")?.id, "tiny-linux");
    assert.equal(getEntry("does-not-exist"), null);
    const groups = groupedCatalog();
    assert.equal(groups.instant.length + groups.bootable.length, CATALOG.length);
    assert.ok(groups.bootable.every((entry) => entry.status !== "instant"));
});


test("the featured Linux really has a graphical browser and the full-browser candidate stays honest", () => {
    const builtIn = getEntry("alpine-browser");
    assert.equal(builtIn.family, "Linux");
    assert.equal(builtIn.browser, "Dillo");
    assert.ok(builtIn.filesystem);
    assert.ok(builtIn.notes.some((note) => /not JavaScript/.test(note)));
    assert.ok(builtIn.notes.some((note) => /Internet is off/.test(note)));
    const full = getEntry("antix-26.1-386");
    assert.equal(full.browser, "Firefox ESR");
    assert.equal(full.status, "tricky");
    assert.match(full.summary, /not boot-verified/);
    assert.ok(full.links.some((link) => /antix-26-1-released/.test(link.url)));
});

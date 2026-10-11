/**
 * ISO 9660 live-kernel extraction: real tiny-linux.iso plus a synthetic Casper CD.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    CASPER_PROFILE, ISO_SECTOR, detectLiveProfile, extractLiveLinux, listIsoFiles,
    looksLikeBzImage, matchLiveFiles, readerFromBytes, createIsoReader, fetchByteRange,
} from "../app/iso9660.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TINY = path.join(ROOT, "assets/images/tiny-linux.iso");

function both32(buf, offset, value) {
    buf.writeUInt32LE(value, offset);
    buf.writeUInt32BE(value, offset + 4);
}
function both16(buf, offset, value) {
    buf.writeUInt16LE(value, offset);
    buf.writeUInt16BE(value, offset + 2);
}

function dirRecord({ lba, size, flags, name }) {
    const nameBytes = Buffer.isBuffer(name) ? name : Buffer.from(name, "ascii");
    const nameLen = nameBytes.length;
    const pad = nameLen % 2 === 0 ? 1 : 0;
    const rec = Buffer.alloc(33 + nameLen + pad);
    rec[0] = rec.length;
    both32(rec, 2, lba);
    both32(rec, 10, size);
    rec[19] = 1; rec[20] = 1;
    rec[25] = flags;
    both16(rec, 28, 1);
    rec[32] = nameLen;
    nameBytes.copy(rec, 33);
    return rec;
}

function pathEntry({ lba, parent, name }) {
    const ident = Buffer.isBuffer(name) ? name : Buffer.from(name, "ascii");
    const pad = ident.length % 2 === 1 ? 1 : 0;
    const rec = Buffer.alloc(8 + ident.length + pad);
    rec[0] = ident.length;
    rec.writeUInt32LE(lba, 2);
    rec.writeUInt16LE(parent, 6);
    ident.copy(rec, 8);
    return rec;
}

/** Minimal ISO 9660 image with the given files (paths like casper/vmlinuz). */
export function buildIso9660(fileMap) {
    const tree = { name: "", children: new Map(), files: new Map() };
    for (const [filePath, data] of Object.entries(fileMap)) {
        const parts = filePath.split("/").filter(Boolean);
        const fileName = parts.pop();
        let node = tree;
        for (const part of parts) {
            const key = part.toUpperCase();
            if (!node.children.has(key)) node.children.set(key, { name: key, children: new Map(), files: new Map() });
            node = node.children.get(key);
        }
        node.files.set(fileName.toUpperCase(), Buffer.from(data));
    }

    const dirs = [];
    const walk = (node, parentIndex) => {
        const index = dirs.length;
        dirs.push({ node, parentIndex, children: [], files: [] });
        for (const child of node.children.values()) {
            dirs[index].children.push(walk(child, index));
        }
        for (const [name, data] of node.files) dirs[index].files.push({ name, data });
        return index;
    };
    walk(tree, 0);

    // Layout: 16 zeros, PVD, terminator, LE path table, BE path table, dirs, files
    let lba = 20;
    for (const dir of dirs) dir.lba = lba++;
    for (const dir of dirs) {
        for (const file of dir.files) {
            file.lba = lba;
            file.sectors = Math.max(1, Math.ceil(file.data.length / ISO_SECTOR));
            lba += file.sectors;
        }
    }
    const volumeSectors = lba;

    const dirSectors = dirs.map((dir) => {
        const records = [
            dirRecord({ lba: dir.lba, size: ISO_SECTOR, flags: 2, name: Buffer.from([0]) }),
            dirRecord({ lba: dirs[dir.parentIndex].lba, size: ISO_SECTOR, flags: 2, name: Buffer.from([1]) }),
        ];
        for (const childIndex of dir.children) {
            const child = dirs[childIndex];
            records.push(dirRecord({ lba: child.lba, size: ISO_SECTOR, flags: 2, name: child.node.name }));
        }
        for (const file of dir.files) {
            records.push(dirRecord({ lba: file.lba, size: file.data.length, flags: 0, name: `${file.name}.;1` }));
        }
        const sector = Buffer.alloc(ISO_SECTOR);
        let offset = 0;
        for (const rec of records) {
            rec.copy(sector, offset);
            offset += rec.length;
        }
        return sector;
    });

    const leEntries = dirs.map((dir, index) => pathEntry({
        lba: dir.lba,
        parent: dir.parentIndex + 1,
        name: index === 0 ? Buffer.from([0]) : Buffer.from(dir.node.name, "ascii"),
    }));
    const pathTable = Buffer.concat(leEntries);
    const pathTableSector = Buffer.alloc(ISO_SECTOR);
    pathTable.copy(pathTableSector);

    const pvd = Buffer.alloc(ISO_SECTOR);
    pvd[0] = 1;
    pvd.write("CD001", 1);
    pvd[6] = 1;
    pvd.write("LINUX", 8);
    pvd.write("TESTISO", 40);
    both32(pvd, 80, volumeSectors);
    both16(pvd, 128, ISO_SECTOR);
    both32(pvd, 132, pathTable.length);
    pvd.writeUInt32LE(18, 140);
    pvd.writeUInt32BE(19, 148);
    dirRecord({ lba: dirs[0].lba, size: ISO_SECTOR, flags: 2, name: Buffer.from([0]) }).copy(pvd, 156);

    const term = Buffer.alloc(ISO_SECTOR);
    term[0] = 255;
    term.write("CD001", 1);
    term[6] = 1;

    const image = Buffer.alloc(volumeSectors * ISO_SECTOR);
    pvd.copy(image, 16 * ISO_SECTOR);
    term.copy(image, 17 * ISO_SECTOR);
    pathTableSector.copy(image, 18 * ISO_SECTOR);
    pathTableSector.copy(image, 19 * ISO_SECTOR);
    for (const dir of dirs) dirSectors[dirs.indexOf(dir)].copy(image, dir.lba * ISO_SECTOR);
    for (const dir of dirs) {
        for (const file of dir.files) file.data.copy(image, file.lba * ISO_SECTOR);
    }
    return image;
}

function fakeBzImage(label = "KERNEL") {
    const buf = Buffer.alloc(1024, 0);
    buf[0x1fe] = 0x55;
    buf[0x1ff] = 0xaa;
    buf.write("HdrS", 0x202);
    buf.write(label, 0x220);
    return buf;
}

async function withRangeServer(body, run) {
    const server = http.createServer((req, res) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
        if (!range) {
            res.writeHead(200, { "Content-Length": body.length, "Access-Control-Allow-Origin": "*" }).end(body);
            return;
        }
        const start = Number(range[1]), end = Math.min(Number(range[2]), body.length - 1);
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${start}-${end}/${body.length}`,
            "Content-Length": slice.length,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        }).end(slice);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try { await run(base); }
    finally { await new Promise((resolve) => server.close(resolve)); }
}

test("tiny-linux.iso is a readable ISO 9660 image with a Linux bzImage", async () => {
    const handle = await fsp.open(TINY, "r");
    try {
        const reader = createIsoReader({
            async read(start, length) {
                const buf = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buf, 0, length, start);
                return new Uint8Array(buf.subarray(0, bytesRead));
            },
        });
        const files = await listIsoFiles(reader);
        const names = files.map((file) => file.path);
        assert.ok(names.includes("bzimage"), names.join(","));
        assert.ok(names.some((name) => name.includes("isolinux")));
        const kernel = files.find((file) => file.path === "bzimage");
        const bytes = await reader.read(kernel.lba * ISO_SECTOR, kernel.size);
        assert.equal(looksLikeBzImage(bytes), true);
        assert.equal(detectLiveProfile(files), null, "buildroot test ISO is not a casper/live image");
    } finally { await handle.close(); }
});

test("a synthetic Casper ISO yields a direct Ubuntu-style kernel boot", async () => {
    const iso = buildIso9660({
        "casper/vmlinuz": fakeBzImage("VMLINUZ"),
        "casper/initrd": Buffer.from("initrd-payload"),
        "casper/filesystem.squashfs": Buffer.from("sq"),
    });
    const extracted = await extractLiveLinux({ read: readerFromBytes(iso).read }, CASPER_PROFILE);
    assert.equal(extracted.kernelPath, "casper/vmlinuz");
    assert.equal(extracted.initrdPath, "casper/initrd");
    assert.match(extracted.cmdline, /boot=casper/);
    assert.equal(looksLikeBzImage(new Uint8Array(extracted.bzimage.buffer)), true);
    assert.equal(Buffer.from(extracted.initrd.buffer).subarray(0, 14).toString(), "initrd-payload");
});

test("Debian live-boot images are detected when Casper paths are absent", async () => {
    const iso = buildIso9660({
        "live/vmlinuz": fakeBzImage("LIVE"),
        "live/initrd.img": Buffer.from("live-initrd"),
    });
    const files = await listIsoFiles(readerFromBytes(iso));
    const detected = detectLiveProfile(files);
    assert.ok(detected, `expected a live-boot profile, files=${files.map((f) => f.path).join(",")}`);
    assert.equal(detected.profile.id, "live");
    const extracted = await extractLiveLinux({ read: readerFromBytes(iso).read });
    assert.equal(extracted.kernelPath, "live/vmlinuz");
    assert.match(extracted.cmdline, /boot=live/);
});

test("ISO file names with ;1 versions still match casper/vmlinuz", () => {
    const files = [
        { path: "casper/vmlinuz", lba: 10, size: 1000 },
        { path: "casper/initrd", lba: 20, size: 2000 },
    ];
    const match = matchLiveFiles(files, CASPER_PROFILE);
    assert.equal(match.kernel.path, "casper/vmlinuz");
    assert.equal(match.initrd.path, "casper/initrd");
});

test("looksLikeBzImage rejects random payloads", () => {
    assert.equal(looksLikeBzImage(new Uint8Array(16)), false);
    assert.equal(looksLikeBzImage(fakeBzImage()), true);
});

test("chunked HTTP Range extraction stays inside the relay-sized window", async () => {
    const iso = buildIso9660({
        "casper/vmlinuz": fakeBzImage("NET"),
        "casper/initrd": Buffer.alloc(3000, 7),
    });
    await withRangeServer(iso, async (base) => {
        const two = await fetchByteRange(`${base}/image.iso`, 0, 1, { chunkSize: 1 });
        assert.equal(two.byteLength, 2);
        const extracted = await extractLiveLinux(
            { url: `${base}/image.iso` },
            CASPER_PROFILE,
            { chunkSize: 512 },
        );
        assert.equal(extracted.kernelPath, "casper/vmlinuz");
        assert.equal(extracted.initrdSize, 3000);
        assert.equal(new Uint8Array(extracted.initrd.buffer)[10], 7);
    });
});

test("the real tiny-linux.iso on disk still exists for the parser", () => {
    assert.equal(fs.existsSync(TINY), true);
    assert.ok(fs.statSync(TINY).size > 1024);
});

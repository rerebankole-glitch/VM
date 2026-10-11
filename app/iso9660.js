/**
 * ISO 9660 (plus Joliet / Rock Ridge names) reader used to pull a live Linux
 * kernel and initrd out of a streamed CD image. v86 can then boot that bzImage
 * directly, instead of waiting on a slow, keyboard-driven ISOLINUX menu.
 *
 * Only bounded HTTP Range requests (or local File slices) are used. The ISO
 * itself is never downloaded whole.
 */

export const ISO_SECTOR = 2048;
export const ISO_RANGE_CHUNK = 1024 * 1024;
export const MAX_LIVE_FILE_BYTES = 96 * 1024 * 1024;

/** Default Ubuntu/Mint Casper layout. */
export const CASPER_PROFILE = {
    id: "casper",
    kernel: ["casper/vmlinuz", "casper/vmlinuz.efi", "casper/vmlinuz.32"],
    initrd: ["casper/initrd", "casper/initrd.lz", "casper/initrd.gz", "casper/initrd.img"],
    cmdline: "boot=casper ignore_uuid noprompt noeject nomodeset vga=791 noapic nolapic acpi=off pci=nomsi nosplash --- console=tty0 console=ttyS0,115200 tsc=reliable random.trust_cpu=on mitigations=off",
};

/** Debian live-boot / MX layout. */
export const LIVEBOOT_PROFILE = {
    id: "live",
    kernel: ["live/vmlinuz", "live/vmlinuz1", "live/vmlinuz2"],
    initrd: ["live/initrd", "live/initrd.img", "live/initrd.gz", "live/initrd1"],
    cmdline: "boot=live components ignore_uuid noeject nomodeset vga=791 noapic nolapic acpi=off nosplash --- console=tty0 console=ttyS0,115200 tsc=reliable random.trust_cpu=on mitigations=off",
};

export const LIVE_PROFILES = [CASPER_PROFILE, LIVEBOOT_PROFILE];

const latin1 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return text;
};

function u32le(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] * 0x1000000);
}

function decodeUcs2(bytes) {
    const even = bytes.length & ~1;
    let text = "";
    for (let i = 0; i < even; i += 2) text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return text;
}

function decodeIdent(bytes, joliet) {
    if (bytes.length === 1 && bytes[0] === 0) return ".";
    if (bytes.length === 1 && bytes[0] === 1) return "..";
    let name = joliet ? decodeUcs2(bytes) : latin1(bytes);
    const cut = name.indexOf(";");
    if (cut >= 0) name = name.slice(0, cut);
    if (name.endsWith(".")) name = name.slice(0, -1);
    return name;
}

function rockRidgeName(sys) {
    let offset = 0;
    if (sys.length >= 7 && sys[0] === 0x53 && sys[1] === 0x50) {
        const skip = sys[6];
        offset = sys[2] + skip;
    }
    let name = "";
    while (offset + 4 <= sys.length) {
        const length = sys[offset + 2];
        if (length < 4 || offset + length > sys.length) break;
        if (sys[offset] === 0x4e && sys[offset + 1] === 0x4d && length >= 5) {
            name += latin1(sys.subarray(offset + 5, offset + length));
        }
        offset += length;
    }
    return name || null;
}

function parseDirRecord(bytes, { joliet = false, susp = false } = {}) {
    if (!bytes || bytes.length < 34 || bytes[0] < 34 || bytes[0] > bytes.length) return null;
    const length = bytes[0];
    const nameLen = bytes[32];
    if (nameLen < 1 || 33 + nameLen > length) return null;
    const nameBytes = bytes.subarray(33, 33 + nameLen);
    let name = decodeIdent(nameBytes, joliet);
    let sysStart = 33 + nameLen;
    if ((nameLen & 1) === 0) sysStart += 1;
    if (susp && sysStart < length) {
        const rrName = rockRidgeName(bytes.subarray(sysStart, length));
        if (rrName) name = rrName;
    }
    if (!name) return null;
    return {
        lba: u32le(bytes, 2),
        size: u32le(bytes, 10),
        directory: Boolean(bytes[25] & 2),
        name,
    };
}

function* iterateRecords(data) {
    for (let sector = 0; sector < data.length; sector += ISO_SECTOR) {
        let offset = sector;
        const end = Math.min(sector + ISO_SECTOR, data.length);
        while (offset < end) {
            const length = data[offset];
            if (!length) break;
            if (offset + length > end) break;
            yield data.subarray(offset, offset + length);
            offset += length;
        }
    }
}

/**
 * Read `endInclusive - start + 1` bytes from a CORS + Range host, in chunks
 * small enough for the optional named-image relay (4 MiB cap).
 */
export async function fetchByteRange(url, start, endInclusive, {
    signal, fetchImpl = fetch, chunkSize = ISO_RANGE_CHUNK, onProgress,
} = {}) {
    const total = endInclusive - start + 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || total <= 0) {
        throw new Error("Invalid ISO byte range.");
    }
    if (total > MAX_LIVE_FILE_BYTES) {
        throw new Error("Refusing to extract a live file larger than 96 MB.");
    }
    const out = new Uint8Array(total);
    let filled = 0;
    while (filled < total) {
        const absStart = start + filled;
        const absEnd = Math.min(absStart + chunkSize - 1, endInclusive);
        const response = await fetchImpl(url, {
            headers: { Range: `bytes=${absStart}-${absEnd}`, "Accept-Encoding": "identity" },
            mode: "cors",
            cache: "no-store",
            signal,
        });
        if (response.status !== 206) {
            await response.body?.cancel?.().catch(() => {});
            throw new Error("The ISO host did not return a verified byte range while reading the live kernel.");
        }
        const buf = new Uint8Array(await response.arrayBuffer());
        if (!buf.byteLength) throw new Error("The ISO host sent an empty range.");
        if (filled + buf.byteLength > total) throw new Error("The ISO host sent more bytes than requested.");
        out.set(buf, filled);
        filled += buf.byteLength;
        onProgress?.(filled, total);
    }
    return out;
}

/** @param {{ url?: string, file?: File, read?: Function, signal?: AbortSignal, fetchImpl?: Function, chunkSize?: number }} options */
export function createIsoReader(options = {}) {
    const { url, file, read, signal, fetchImpl = fetch, chunkSize = ISO_RANGE_CHUNK } = options;
    return {
        async read(start, length, onProgress) {
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0) {
                return new Uint8Array(0);
            }
            if (typeof read === "function") {
                const bytes = await read(start, length);
                return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            }
            if (file?.slice) {
                const buffer = await file.slice(start, start + length).arrayBuffer();
                return new Uint8Array(buffer);
            }
            if (!url) throw new Error("No ISO source to read.");
            return fetchByteRange(url, start, start + length - 1, { signal, fetchImpl, chunkSize, onProgress });
        },
    };
}

export function readerFromBytes(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return createIsoReader({
        read(start, length) {
            const end = Math.min(start + length, data.length);
            if (start >= data.length) return new Uint8Array(0);
            return data.slice(start, end);
        },
    });
}

/**
 * @returns {Promise<Array<{ path: string, lba: number, size: number }>>}
 */
export async function listIsoFiles(reader) {
    let pvdRoot = null;
    let jolietRoot = null;
    for (let lba = 16; lba < 32; lba++) {
        const sector = await reader.read(lba * ISO_SECTOR, ISO_SECTOR);
        if (sector.length < 40 || latin1(sector.subarray(1, 6)) !== "CD001") break;
        const type = sector[0];
        if (type === 255) break;
        const root = parseDirRecord(sector.subarray(156, 190));
        if (type === 1) pvdRoot = root;
        if (type === 2) {
            const esc = sector.subarray(88, 91);
            if (esc[0] === 0x25 && esc[1] === 0x2f && (esc[2] === 0x40 || esc[2] === 0x43 || esc[2] === 0x45)) {
                jolietRoot = root;
            }
        }
    }
    if (!pvdRoot?.directory) throw new Error("This image is not a readable ISO 9660 CD.");
    const map = new Map();
    await walkDir(reader, pvdRoot, "", map, new Set(), { joliet: false, depth: 0 });
    if (jolietRoot?.directory) {
        await walkDir(reader, jolietRoot, "", map, new Set(), { joliet: true, depth: 0 });
    }
    return [...map.values()];
}

async function walkDir(reader, record, prefix, map, walked, { joliet, depth }) {
    if (depth > 12 || walked.has(record.lba) || record.size <= 0 || record.size > 1024 * 1024) return;
    walked.add(record.lba);
    const data = await reader.read(record.lba * ISO_SECTOR, record.size);
    for (const raw of iterateRecords(data)) {
        const child = parseDirRecord(raw, { joliet, susp: !joliet });
        if (!child || child.name === "." || child.name === "..") continue;
        const path = (prefix ? `${prefix}/${child.name}` : child.name).replace(/\\/g, "/").toLowerCase();
        if (child.directory) {
            await walkDir(reader, child, path, map, walked, { joliet, depth: depth + 1 });
        } else if (child.size > 0) {
            map.set(path, { path, lba: child.lba, size: child.size });
        }
        if (map.size > 8000) return;
    }
}

export function matchLiveFiles(files, profile = CASPER_PROFILE) {
    const map = new Map(files.map((file) => [file.path.toLowerCase(), file]));
    const pick = (candidates = []) => {
        for (const path of candidates) {
            const hit = map.get(path.toLowerCase());
            if (hit && hit.size > 8) return hit;
        }
        for (const path of candidates) {
            const parts = path.toLowerCase().split("/");
            const folder = parts.length > 1 ? parts[0] : "";
            const base = parts[parts.length - 1];
            const hit = files.find((file) => file.size > 8 && (
                file.path === base
                || (folder && file.path.startsWith(`${folder}/`) && (file.path.endsWith(`/${base}`) || file.path === `${folder}/${base}`))
            ));
            if (hit) return hit;
        }
        return null;
    };
    return {
        kernel: pick(profile.kernel || CASPER_PROFILE.kernel),
        initrd: pick(profile.initrd || CASPER_PROFILE.initrd),
    };
}

export function detectLiveProfile(files) {
    for (const profile of LIVE_PROFILES) {
        const match = matchLiveFiles(files, profile);
        if (match.kernel && match.initrd) return { profile, match };
    }
    return null;
}

/** Linux bzImage magic: boot signature + "HdrS" at 0x202. */
export function looksLikeBzImage(bytes) {
    if (!bytes || bytes.length < 0x206) return false;
    return bytes[0x202] === 0x48 && bytes[0x203] === 0x64 && bytes[0x204] === 0x72 && bytes[0x205] === 0x53;
}

function toArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * Pull kernel + initrd from a streamed or local live ISO.
 *
 * @param {{ url?: string, file?: File, kind?: string }} source
 * @param {{ kernel?: string[], initrd?: string[], cmdline?: string }} [live]
 */
export async function extractLiveLinux(source, live = {}, options = {}) {
    const reader = createIsoReader({ ...source, ...options });
    const files = await listIsoFiles(reader);
    const detected = detectLiveProfile(files);
    const profile = (live?.kernel && live?.initrd)
        ? { ...CASPER_PROFILE, ...live }
        : detected?.profile || live || CASPER_PROFILE;
    const match = matchLiveFiles(files, profile);
    if (!match.kernel || !match.initrd) {
        throw new Error("No live Linux kernel/initrd (casper/ or live/) was found in this ISO.");
    }
    if (match.kernel.size > MAX_LIVE_FILE_BYTES || match.initrd.size > MAX_LIVE_FILE_BYTES) {
        throw new Error("The live kernel or initrd is too large to extract into memory.");
    }
    const onProgress = options.onProgress;
    const kernelBytes = await reader.read(match.kernel.lba * ISO_SECTOR, match.kernel.size, (loaded, total) => {
        onProgress?.(loaded, match.kernel.size + match.initrd.size, "kernel");
        void total;
    });
    if (!looksLikeBzImage(kernelBytes)) {
        throw new Error(`Found ${match.kernel.path}, but it is not a Linux bzImage.`);
    }
    const initrdBytes = await reader.read(match.initrd.lba * ISO_SECTOR, match.initrd.size, (loaded, total) => {
        onProgress?.(match.kernel.size + loaded, match.kernel.size + match.initrd.size, "initrd");
        void total;
    });
    return {
        bzimage: { buffer: toArrayBuffer(kernelBytes) },
        initrd: { buffer: toArrayBuffer(initrdBytes) },
        cmdline: live.cmdline || profile.cmdline || CASPER_PROFILE.cmdline,
        kernelPath: match.kernel.path,
        initrdPath: match.initrd.path,
        kernelSize: match.kernel.size,
        initrdSize: match.initrd.size,
        files,
    };
}

/**
 * Turning "where is the disk image?" into something v86 can boot.
 *
 * Three kinds of source are supported:
 *
 *   bundled  an image that ships in assets/images/ (nothing to download)
 *   file     a file the user picked / dropped (never uploaded anywhere)
 *   url      a remote image, used with HTTP Range requests when the server
 *            supports them, otherwise downloaded fully into memory first
 *
 * v86 accepts `{ url }`, `{ buffer: ArrayBuffer }` or `{ buffer: File }`.
 * A plain `File` is the best option for very large ISOs: v86 then reads only
 * the 64 KB blocks the guest asks for, straight off the user's disk.
 */

/** Above this size a picked file is streamed from disk instead of read into RAM. */
export const RAM_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * @typedef {object} DiskSource
 * @property {"bundled"|"file"|"url"} kind
 * @property {string} label          human readable summary
 * @property {number} sizeBytes
 * @property {string} device         "cdrom" | "fda" | "hda"
 * @property {File} [file]
 * @property {string} [url]
 */

/**
 * Describe a bundled image from the catalogue.
 * @param {import("./catalog.js").CATALOG[number]} entry
 * @returns {DiskSource}
 */
export function bundledSource(entry) {
    return {
        kind: "bundled",
        label: entry.bundled.path.split("/").pop(),
        sizeBytes: entry.sizeBytes,
        device: entry.device || "cdrom",
        url: entry.bundled.path,
        bundledPath: entry.bundled.path,
    };
}

/**
 * Inspect a URL before committing to a multi-gigabyte boot: is it reachable
 * from the browser (CORS), how big is it, and does it honour Range requests?
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, error?: string, size?: number, acceptRanges: boolean,
 *                    cors: boolean, contentType?: string, notes: string[]}>}
 */
export async function probeUrl(url) {
    const notes = [];
    const result = { ok: false, acceptRanges: false, cors: false, notes };

    let parsed;
    try {
        // `location` only exists in a browser; the fallback keeps this module
        // usable from Node (tests, tooling).
        const base = typeof location !== "undefined" ? location.href : "http://localhost/";
        parsed = new URL(url, base);
    } catch {
        return { ...result, error: "That is not a valid URL." };
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        return { ...result, error: "Only http:// and https:// URLs can be used." };
    }

    // 1. Try a tiny ranged GET; it reveals size, range support and CORS at once.
    try {
        const response = await fetch(parsed.href, {
            method: "GET",
            headers: { Range: "bytes=0-1" },
            mode: "cors",
            cache: "no-store",
        });

        if (!response.ok && response.status !== 206) {
            return { ...result, error: `The server answered HTTP ${response.status}.` };
        }

        result.cors = true;
        result.contentType = response.headers.get("content-type") || undefined;
        result.acceptRanges = response.status === 206 || /bytes/i.test(response.headers.get("accept-ranges") || "");

        const contentRange = response.headers.get("content-range");
        if (contentRange && /\/(\d+)\s*$/.test(contentRange)) {
            result.size = Number(contentRange.match(/\/(\d+)\s*$/)[1]);
        } else {
            const length = Number(response.headers.get("content-length"));
            // Without range support the server sends the whole file; the length
            // header is only usable when it is a plain GET answer.
            result.size = Number.isFinite(length) && length > 0 ? length : undefined;
        }
        await response.body?.cancel?.().catch(() => {});

        if (!result.acceptRanges) {
            notes.push("This server ignores HTTP Range requests, so the whole image has to be downloaded into memory before booting.");
        }
        if (!result.size) {
            notes.push("The server did not report a file size; the exact size is required for range-based loading.");
        }
        result.ok = true;
        return result;
    } catch (error) {
        // 2. Ranged GET failed (CORS or network) — retry with a plain HEAD to
        //    tell "no CORS" apart from "file is missing".
        try {
            const head = await fetch(parsed.href, { method: "HEAD", mode: "cors" });
            result.cors = true;
            if (!head.ok) {
                return { ...result, error: `The server answered HTTP ${head.status}.` };
            }
            const length = Number(head.headers.get("content-length"));
            result.size = Number.isFinite(length) && length > 0 ? length : undefined;
            result.acceptRanges = /bytes/i.test(head.headers.get("accept-ranges") || "");
            result.ok = true;
            notes.push("Range probing failed but the file exists — it will be downloaded fully into memory.");
            return result;
        } catch {
            return {
                ...result,
                error:
                    "The browser could not read this URL directly. That is usually a CORS restriction " +
                    "(most distro mirrors do not allow cross-origin reads). Download the ISO and use " +
                    "the “From disk” tab instead — it is faster anyway.",
            };
        }
    }
}

/**
 * Download a URL into memory, reporting progress.
 * @param {string} url
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchToArrayBuffer(url, onProgress) {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
    }
    const totalHeader = Number(response.headers.get("content-length"));
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0;

    if (!response.body) {
        const buffer = await response.arrayBuffer();
        onProgress?.(buffer.byteLength, buffer.byteLength);
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.(loaded, total || loaded);
    }

    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out.buffer;
}

/**
 * Read a picked File into an ArrayBuffer, reporting progress while it loads.
 * @param {File} file
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export function readFileToArrayBuffer(file, onProgress) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (event) => {
            onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
        };
        reader.onload = () => {
            onProgress?.(file.size, file.size);
            resolve(/** @type {ArrayBuffer} */ (reader.result));
        };
        reader.onerror = () => reject(reader.error || new Error("Could not read that file."));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Build the v86 image descriptor for a source.
 *
 * @param {DiskSource} source
 * @param {object} [options]
 * @param {"auto"|"ram"|"stream"|"download"} [options.mode] how local/remote data is handled
 * @param {(loaded: number, total: number, label: string) => void} [options.onProgress]
 * @returns {Promise<{image: object, strategy: string, sizeBytes: number}>}
 */
export async function resolveImage(source, options = {}) {
    const { mode = "auto", onProgress } = options;
    const size = source.sizeBytes || 0;

    if (source.kind === "bundled") {
        // Ships with the app: let v86 fetch it normally (it reports progress).
        return {
            image: { url: source.url },
            strategy: "bundled file from this site",
            sizeBytes: size,
        };
    }

    if (source.kind === "url") {
        const useRange = mode === "auto" && source.acceptRanges && source.sizeBytes;
        if (mode === "download" || !useRange) {
            const buffer = await fetchToArrayBuffer(source.url, (loaded, total) => onProgress?.(loaded, total, source.label));
            return {
                image: { buffer },
                strategy: "downloaded into memory (no Range support)",
                sizeBytes: buffer.byteLength,
            };
        }
        return {
            image: { url: source.url, size: source.sizeBytes, async: true },
            strategy: "streamed on demand with HTTP Range requests",
            sizeBytes: source.sizeBytes,
        };
    }

    if (source.kind === "file" && source.file) {
        const file = source.file;
        const stream = mode === "stream" || (mode === "auto" && file.size > RAM_LIMIT_BYTES);
        if (stream) {
            // v86 reads the File lazily, block by block: no giant RAM copy.
            return {
                image: { buffer: file, async: true },
                strategy: `streamed from disk as the guest reads it (${file.name})`,
                sizeBytes: file.size,
            };
        }
        const buffer = await readFileToArrayBuffer(file, (loaded, total) => onProgress?.(loaded, total, file.name));
        return {
            image: { buffer },
            strategy: `loaded into memory (${file.name})`,
            sizeBytes: buffer.byteLength,
        };
    }

    throw new Error("No disk image selected.");
}

/**
 * Convenience: describe a source for the UI without loading anything.
 * @param {DiskSource|null} source
 */
export function describeSource(source) {
    if (!source) return "Nothing selected";
    if (source.kind === "bundled") return `Built-in image · ${source.label}`;
    if (source.kind === "url") return `Remote image · ${source.label}`;
    return `Local file · ${source.label}`;
}

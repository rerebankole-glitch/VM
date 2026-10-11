/**
 * Disk images stay either on the host, in RAM, or in a user-picked file.
 * Remote streaming must be proven with an actual, correctly sized HTTP 206;
 * an Accept-Ranges header alone is not enough.
 */

export const RAM_LIMIT_BYTES = 512 * 1024 * 1024;
export const PROBE_TIMEOUT_MS = 12_000;

/**
 * @typedef {object} DiskSource
 * @property {"bundled"|"filesystem"|"file"|"url"} kind
 * @property {string} label
 * @property {number} sizeBytes
 * @property {string} device "cdrom" | "fda" | "hda"
 * @property {File} [file]
 * @property {string} [url]
 * @property {boolean} [acceptRanges]
 * @property {boolean} [streamOnly]
 */

export function bundledSource(entry) {
    if (entry.filesystem) {
        return {
            kind: "filesystem", label: `${entry.name} + ${entry.browser}`, sizeBytes: entry.sizeBytes,
            device: "filesystem", url: entry.bundled.path, bundledPath: entry.bundled.path,
            filesystem: { baseurl: entry.filesystem.baseurl, basefs: { url: entry.bundled.path } },
            cmdline: entry.filesystem.cmdline,
        };
    }
    return {
        kind: "bundled",
        label: entry.bundled.path.split("/").pop(),
        sizeBytes: entry.sizeBytes,
        device: entry.device || "cdrom",
        url: entry.bundled.path,
        bundledPath: entry.bundled.path,
    };
}

/** Only a verified range response with a known size can be streamed. */
export function canStream(source) {
    const size = source?.sizeBytes ?? source?.size;
    return Boolean(source?.acceptRanges && Number.isSafeInteger(size) && size > 1);
}

/**
 * Inspect a URL without downloading the image. A server which ignores Range
 * has its response body cancelled immediately. HEAD is informational only.
 */
export async function probeUrl(url, { signal, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const result = { ok: false, acceptRanges: false, cors: false, notes: [] };
    let parsed;
    try {
        const base = typeof location !== "undefined" ? location.href : "http://localhost/";
        parsed = new URL(url, base);
    } catch {
        return { ...result, error: "That is not a valid URL." };
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        return { ...result, error: "Use an http:// or https:// URL without embedded credentials." };
    }
    if (typeof location !== "undefined" && location.protocol === "https:" && parsed.protocol === "http:") {
        return { ...result, error: "This page uses HTTPS, so the image must use HTTPS too (mixed content is blocked)." };
    }

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);

    const inspect = async (response, ranged) => {
        result.cors = true;
        result.contentType = response.headers.get("content-type") || undefined;
        if (!response.ok) {
            await response.body?.cancel?.().catch(() => {});
            return { ...result, error: `The image host answered HTTP ${response.status}.` };
        }
        if (/(?:text\/|application\/(?:json|xhtml\+xml))/i.test(result.contentType || "")) {
            await response.body?.cancel?.().catch(() => {});
            return { ...result, error: "This link returns a web page, not a disk image. Use a direct .iso / .img link." };
        }
        const range = /^bytes 0-1\/(\d+)$/.exec(response.headers.get("content-range") || "");
        const total = range ? Number(range[1]) : 0;
        const encoding = response.headers.get("content-encoding");
        const lengthHeader = response.headers.get("content-length");
        let valid = Boolean(ranged && response.status === 206 && Number.isSafeInteger(total) && total > 1
            && (!encoding || encoding.toLowerCase() === "identity") && (lengthHeader === null || Number(lengthHeader) === 2));
        if (valid && response.body) {
            // Verify even a chunked 206 actually contains two bytes. Never read
            // a 200 body; stop immediately if a lying 206 exceeds the probe.
            const reader = response.body.getReader();
            let bytes = 0, done = false;
            try {
                while (!done && bytes <= 2) {
                    const chunk = await reader.read();
                    done = chunk.done;
                    bytes += chunk.value?.byteLength || 0;
                }
                valid = done && bytes === 2;
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        } else {
            valid = false;
        }
        await response.body?.cancel?.().catch(() => {});
        result.acceptRanges = valid;
        if (valid) result.size = total;
        else if (response.status === 200) {
            const length = Number(lengthHeader);
            result.size = Number.isSafeInteger(length) && length > 0 ? length : undefined;
        }
        if (!valid) result.notes.push("HTTP Range streaming was not verified. Streaming-only mode will refuse this image, not download the entire ISO.");
        if (!result.size) result.notes.push("The image size is unknown. The host must expose Content-Range for streaming.");
        result.ok = true;
        return result;
    };

    try {
        try {
            const response = await fetch(parsed.href, {
                headers: { Range: "bytes=0-1" }, mode: "cors", cache: "no-store", signal: controller.signal,
            });
            return await inspect(response, true);
        } catch (error) {
            if (controller.signal.aborted) throw error;
            const head = await fetch(parsed.href, { method: "HEAD", mode: "cors", cache: "no-store", signal: controller.signal });
            return await inspect(head, false);
        }
    } catch {
        if (controller.signal.aborted) {
            return { ...result, error: timedOut ? "The image host took too long to respond. Try another host." : "Link check cancelled." };
        }
        return {
            ...result,
            error: "The browser cannot read this image host (network or CORS restrictions). " +
                "Use a CORS + Range-enabled host, or the optional server image relay. No ISO was saved to your disk.",
        };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
}

/** An explicit full download is bounded, including when Content-Length is missing. */
export async function fetchToArrayBuffer(url, onProgress, { maxBytes = RAM_LIMIT_BYTES } = {}) {
    const response = await fetch(url, { mode: "cors", cache: "no-store" });
    if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`Download failed: HTTP ${response.status}`);
    }
    const totalHeader = Number(response.headers.get("content-length"));
    const total = Number.isSafeInteger(totalHeader) && totalHeader > 0 ? totalHeader : 0;
    const tooLarge = () => new Error("This image is too large to download into RAM. Use verified HTTP Range streaming instead.");
    if (total > maxBytes) {
        await response.body?.cancel?.().catch(() => {});
        throw tooLarge();
    }
    if (!response.body) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) throw tooLarge();
        onProgress?.(buffer.byteLength, buffer.byteLength);
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            if (loaded > maxBytes) {
                await reader.cancel();
                throw tooLarge();
            }
            chunks.push(value);
            onProgress?.(loaded, total || loaded);
        }
    } finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out.buffer;
}

export function readFileToArrayBuffer(file, onProgress) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (event) => onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
        reader.onload = () => {
            onProgress?.(file.size, file.size);
            resolve(reader.result);
        };
        reader.onerror = () => reject(reader.error || new Error("Could not read that file."));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * @param {DiskSource} source
 * @param {{mode?: string, streamOnly?: boolean, onProgress?: Function}} options
 */
export async function resolveImage(source, options = {}) {
    const { mode = "auto", onProgress, streamOnly = source?.streamOnly || false } = options;
    const size = source.sizeBytes || 0;
    if (source.kind === "filesystem") {
        return {
            filesystem: source.filesystem, cmdline: source.cmdline,
            strategy: "Linux filesystem loaded on demand · no ISO to save", sizeBytes: size,
        };
    }
    if (source.kind === "bundled") {
        return { image: { url: source.url }, strategy: "small bundled image from this site", sizeBytes: size };
    }
    if (source.kind === "url") {
        // Local-file RAM settings must never accidentally force a remote ISO download.
        if (canStream(source) && (streamOnly || (mode !== "download" && mode !== "ram"))) {
            return {
                image: { url: source.url, size, async: true },
                strategy: "HTTP Range streaming · no ISO file to save",
                sizeBytes: size,
            };
        }
        if (streamOnly || mode === "stream") {
            throw new Error("Streaming-only mode is on, but this host did not prove HTTP Range support and the image size. " +
                "Choose a streaming host or server relay. The full ISO will not be downloaded.");
        }
        if (size > RAM_LIMIT_BYTES) {
            throw new Error("This ISO is too large for a full RAM download. Use HTTP Range streaming; no multi-GB download was started.");
        }
        const buffer = await fetchToArrayBuffer(source.url, (loaded, total) => onProgress?.(loaded, total, source.label));
        return { image: { buffer }, strategy: "downloaded into memory (no Range support)", sizeBytes: buffer.byteLength };
    }
    if (source.kind === "file" && source.file) {
        const file = source.file;
        if (mode === "stream" || (mode === "auto" && file.size > RAM_LIMIT_BYTES)) {
            return {
                image: { buffer: file, async: true }, strategy: `streamed from disk as the guest reads it (${file.name})`, sizeBytes: file.size,
            };
        }
        const buffer = await readFileToArrayBuffer(file, (loaded, total) => onProgress?.(loaded, total, file.name));
        return { image: { buffer }, strategy: `loaded into memory (${file.name})`, sizeBytes: buffer.byteLength };
    }
    throw new Error("No disk image selected.");
}

export function describeSource(source) {
    if (!source) return "Nothing selected";
    if (source.kind === "filesystem") return `On-demand Linux desktop · ${source.label}`;
    if (source.kind === "bundled") return `Built-in image · ${source.label}`;
    if (source.kind === "url") return `Remote stream · ${source.label}`;
    return `Local file · ${source.label}`;
}

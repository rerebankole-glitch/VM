/**
 * An optional, diskless ISO relay for the Node host. It is NOT an open proxy:
 * only operator-configured, named images are reachable. No client URL, cookie,
 * authorization header or arbitrary request header is forwarded upstream.
 */
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RELAY_IDS, getEntry } from "../app/catalog.js";

export const MINT_ID = "mint-19.3-xfce-32";
export { RELAY_IDS };
export const MAX_RANGE_BYTES = 4 * 1024 * 1024;
const CORS = {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, X-Accept-Encoding",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "X-Content-Type-Options": "nosniff",
};

export function parseImageRange(header) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(header || "");
    if (!match) return null;
    const start = Number(match[1]), end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
        || end - start + 1 > MAX_RANGE_BYTES) return null;
    return { start, end };
}

export function defaultMintUrls() {
    return getEntry(MINT_ID).links.filter((link) => link.kind === "direct").map((link) => link.url);
}

export function defaultRelayImages() {
    const images = new Map();
    for (const id of RELAY_IDS) {
        const urls = getEntry(id)?.links.filter((link) => link.kind === "direct").map((link) => link.url) || [];
        if (urls.length) images.set(id, urls);
    }
    return images;
}

function validateUpstream(url) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("The configured image URL must use HTTP(S) without embedded credentials.");
    }
    return parsed.href;
}

export function createImageRelay({ images, mintUrls, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
    // Configuration belongs to the server operator, never to an incoming request.
    // Tests pass mintUrls alone (Mint-only map). The Node host passes `images`.
    const map = new Map();
    if (images) {
        for (const [id, urls] of images) map.set(id, urls.map(validateUpstream));
    } else {
        map.set(MINT_ID, (mintUrls || defaultMintUrls()).map(validateUpstream));
    }
    if (mintUrls && images) map.set(MINT_ID, mintUrls.map(validateUpstream));
    const images_ = map;
    let active = 0;

    const reply = (req, res, status, message) => {
        if (res.destroyed || res.headersSent) return;
        const body = JSON.stringify({ error: message });
        res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : body);
    };

    return async function handleImageRelay(req, res, url) {
        if (url.pathname !== "/api/stream-images" && !url.pathname.startsWith("/api/images/")) return false;
        if (req.method === "OPTIONS") {
            res.writeHead(204, CORS).end();
            return true;
        }
        if (!["GET", "HEAD"].includes(req.method)) {
            reply(req, res, 405, "Only GET and HEAD are supported.");
            return true;
        }
        if (url.search) {
            reply(req, res, 400, "Image URLs cannot be supplied by a client.");
            return true;
        }
        if (url.pathname === "/api/stream-images") {
            const body = JSON.stringify({ images: [...images_.keys()].map((id) => ({ id, url: `api/images/${id}.iso` })) });
            res.writeHead(200, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
            res.end(req.method === "HEAD" ? undefined : body);
            return true;
        }
        const id = /^\/api\/images\/([a-z0-9.-]+)\.iso$/.exec(url.pathname)?.[1];
        const upstreamUrls = images_.get(id);
        if (!upstreamUrls?.length) {
            reply(req, res, 404, "This image is not configured on this server.");
            return true;
        }
        const range = parseImageRange(req.headers.range || (req.method === "HEAD" ? "bytes=0-1" : ""));
        if (!range) {
            reply(req, res, 400, `A single, explicit byte range of at most ${MAX_RANGE_BYTES} bytes is required. Full ISO downloads are disabled.`);
            return true;
        }
        if (active >= 8) {
            reply(req, res, 503, "The image relay is busy. Try again shortly.");
            return true;
        }

        active++;
        const controller = new AbortController();
        const abort = () => controller.abort();
        const onClose = () => { if (!res.writableEnded) abort(); };
        req.once("aborted", abort);
        res.once("close", onClose);
        const timer = setTimeout(abort, timeoutMs);
        let lastError = "The configured image mirrors are unreachable.";
        try {
            for (const upstream of upstreamUrls) {
                if (controller.signal.aborted) break;
                let response;
                try {
                    response = await fetchImpl(upstream, {
                        headers: { Range: `bytes=${range.start}-${range.end}`, "Accept-Encoding": "identity" },
                        signal: controller.signal,
                        redirect: "follow",
                    });
                    const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
                    const start = Number(contentRange?.[1]), end = Number(contentRange?.[2]), size = Number(contentRange?.[3]);
                    const length = end - start + 1;
                    const encoded = response.headers.get("content-encoding");
                    const contentLength = response.headers.get("content-length");
                    const type = response.headers.get("content-type") || "application/octet-stream";
                    const valid = response.status === 206 && Number.isSafeInteger(size) && size > range.start
                        && start === range.start && end === Math.min(range.end, size - 1) && length > 0
                        && (!encoded || encoded.toLowerCase() === "identity")
                        && (contentLength === null || Number(contentLength) === length)
                        && !/(?:text\/|application\/(?:json|xhtml\+xml))/i.test(type);
                    if (!valid || !response.body) {
                        // A mirror ignoring Range must never spill a whole ISO to the client.
                        await response.body?.cancel?.().catch(() => {});
                        lastError = "The mirror did not return a valid, uncompressed byte range. Full downloads are disabled.";
                        continue;
                    }
                    if (req.method === "HEAD") {
                        await response.body.cancel();
                        res.writeHead(200, { ...CORS, "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" }).end();
                        return true;
                    }
                    res.writeHead(206, {
                        ...CORS, "Content-Type": type, "Content-Length": length,
                        "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes",
                    });
                    let received = 0;
                    const bounded = new Transform({
                        transform(chunk, encoding, callback) {
                            received += chunk.length;
                            callback(received > length ? new Error("Upstream exceeded the requested byte range.") : null,
                                received > length ? undefined : chunk);
                        },
                        flush(callback) {
                            callback(received === length ? null : new Error("Upstream sent an incomplete byte range."));
                        },
                    });
                    await pipeline(Readable.fromWeb(response.body), bounded, res, { signal: controller.signal });
                    return true;
                } catch {
                    await response?.body?.cancel?.().catch(() => {});
                    if (res.headersSent) { res.destroy(); return true; }
                    lastError = "The server cannot reach the image mirror. Check its network access or configure UBUNTU_ISO_URL / MINT_ISO_URL.";
                }
            }
            reply(req, res, 502, controller.signal.aborted ? "The image mirror timed out. No full ISO was downloaded." : lastError);
        } finally {
            clearTimeout(timer);
            req.removeListener("aborted", abort);
            res.removeListener("close", onClose);
            active--;
        }
        return true;
    };
}

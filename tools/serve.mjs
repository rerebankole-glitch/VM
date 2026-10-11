#!/usr/bin/env node
/**
 * Dependency-free static host + optional, diskless, named-image relay.
 * node tools/serve.mjs [--port 8080] [--host 0.0.0.0] [--mint-url https://host/image.iso]
 * GitHub Pages still works as a static-only deployment; it has no relay.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createImageRelay } from "./image-relay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".ico": "image/x-icon", ".wasm": "application/wasm",
    ".iso": "application/octet-stream", ".img": "application/octet-stream",
    ".bin": "application/octet-stream", ".zst": "application/octet-stream",
};
const HEADERS = {
    "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range, X-Accept-Encoding",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "X-Content-Type-Options": "nosniff",
};

export function createVmServer({ root = ROOT, relayOptions } = {}) {
    const relay = createImageRelay(relayOptions);
    const send = (req, res, status, headers, body) => {
        res.writeHead(status, { ...HEADERS, ...headers });
        if (req.method === "HEAD") { body?.destroy?.(); res.end(); }
        else if (body?.pipe) { body.on("error", () => res.destroy()); body.pipe(res); }
        else res.end(body);
    };

    async function handle(req, res) {
        const url = new URL(req.url || "/", "http://localhost");
        if (await relay(req, res, url)) return;
        if (req.method === "OPTIONS") return send(req, res, 204, {}, undefined);
        if (!["GET", "HEAD"].includes(req.method)) {
            return send(req, res, 405, { Allow: "GET, HEAD, OPTIONS" }, "Method not allowed");
        }
        let decoded;
        try { decoded = decodeURIComponent(url.pathname); }
        catch { return send(req, res, 400, {}, "Bad path"); }
        // Don't serve git credentials, dotfiles, test caches, or dependencies.
        if (decoded.includes("\0") || decoded.split(/[\\/]/).some((part) => part.startsWith(".") || part === "node_modules")) {
            return send(req, res, 403, {}, "Forbidden");
        }
        let target = path.resolve(root, `.${decoded}`);
        if (target !== root && !target.startsWith(root + path.sep)) return send(req, res, 403, {}, "Forbidden");
        const stat = async (file) => { try { return await fsp.stat(file); } catch { return null; } };
        let stats = await stat(target);
        if (stats?.isDirectory()) { target = path.join(target, "index.html"); stats = await stat(target); }
        if (!stats?.isFile()) return send(req, res, 404, { "Content-Type": "text/plain; charset=utf-8" }, `404 ${url.pathname}`);
        const real = await fsp.realpath(target);
        if (real !== root && !real.startsWith(root + path.sep)) return send(req, res, 403, {}, "Forbidden");

        const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
        const size = stats.size;
        if (req.headers.range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (!match || (!match[1] && !match[2])) return send(req, res, 416, { "Content-Range": `bytes */${size}` });
            let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
            let end = match[1] && match[2] ? Number(match[2]) : size - 1;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size
                || (!match[1] && Number(match[2]) <= 0)) return send(req, res, 416, { "Content-Range": `bytes */${size}` });
            end = Math.min(end, size - 1);
            return send(req, res, 206, {
                "Content-Type": type, "Content-Length": end - start + 1,
                "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes",
            }, req.method === "HEAD" ? undefined : fs.createReadStream(target, { start, end }));
        }
        send(req, res, 200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" },
            req.method === "HEAD" ? undefined : fs.createReadStream(target));
    }

    return http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            console.error("request failed:", error.message);
            if (!res.headersSent) send(req, res, 500, { "Content-Type": "text/plain" }, "Internal server error");
            else res.destroy();
        });
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const arg = (name, fallback) => {
        const index = args.indexOf(`--${name}`);
        return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
    };
    const port = Number(arg("port", process.env.PORT || 8080));
    const host = arg("host", "0.0.0.0");
    const mintUrl = arg("mint-url", process.env.MINT_ISO_URL);
    const server = createVmServer({ relayOptions: mintUrl ? { mintUrls: [mintUrl] } : undefined });
    server.on("error", (error) => { console.error(`Could not listen on ${host}:${port} — ${error.message}`); process.exit(1); });
    server.listen(port, host, () => {
        console.log("WebVM");
        console.log(`  local:   http://localhost:${port}/`);
        console.log(`  serving: ${ROOT}`);
        console.log("  Mint:    diskless byte-range relay (requires access to the configured mirror)");
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}

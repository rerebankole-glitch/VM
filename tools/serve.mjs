#!/usr/bin/env node
/**
 * Zero-dependency static server for local development.
 *
 *   node tools/serve.mjs [--port 8080] [--host 0.0.0.0]
 *
 * Mirrors what GitHub Pages does (correct MIME types, byte ranges) so that
 * everything can be tested locally, including v86's Range-request disk mode.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number(arg("port", process.env.PORT || 8080));
const HOST = arg("host", "0.0.0.0");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".iso": "application/octet-stream",
    ".img": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".zst": "application/octet-stream",
};

/** Keep every response inside ROOT. */
function resolveSafe(urlPath) {
    const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
    const target = path.resolve(ROOT, `.${path.normalize(decoded)}`);
    return target.startsWith(ROOT) ? target : null;
}

async function statOrNull(target) {
    try {
        return await fsp.stat(target);
    } catch {
        return null;
    }
}

function send(res, status, headers, body) {
    res.writeHead(status, {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        ...headers,
    });
    if (body && typeof body.pipe === "function") {
        body.on("error", () => res.destroy());
        body.pipe(res);
    } else if (body !== undefined && body !== null) {
        res.end(body);
    } else {
        res.end();
    }
}

const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
        console.error("request failed:", error);
        if (!res.headersSent) send(res, 500, { "Content-Type": "text/plain" }, "Internal server error");
        else res.destroy();
    });
});

async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let target = resolveSafe(url.pathname);
    if (!target) return send(res, 400, { "Content-Type": "text/plain" }, "Bad path");

    let stats = await statOrNull(target);
    if (stats?.isDirectory()) {
        target = path.join(target, "index.html");
        stats = await statOrNull(target);
    }
    if (!stats?.isFile()) {
        return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, `404 ${url.pathname}`);
    }

    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    const size = stats.size;
    const range = req.headers.range;

    // Byte ranges: needed by v86's async disk images and by our URL probe.
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
            let start = match[1] ? Number(match[1]) : 0;
            let end = match[2] ? Number(match[2]) : size - 1;
            if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
                return send(res, 416, { "Content-Range": `bytes */${size}` });
            }
            end = Math.min(end, size - 1);
            const stream = fs.createReadStream(target, { start, end });
            return send(res, 206, {
                "Content-Type": type,
                "Content-Length": end - start + 1,
                "Content-Range": `bytes ${start}-${end}/${size}`,
                "Accept-Ranges": "bytes",
            }, stream);
        }
    }

    if (req.method === "HEAD") {
        return send(res, 200, {
            "Content-Type": type,
            "Content-Length": size,
            "Accept-Ranges": "bytes",
        });
    }

    send(res, 200, {
        "Content-Type": type,
        "Content-Length": size,
        "Accept-Ranges": "bytes",
    }, fs.createReadStream(target));
}

server.on("error", (error) => {
    console.error(`Could not listen on ${HOST}:${PORT} — ${error.message}`);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log(`Browser VM dev server`);
    console.log(`  local:   http://localhost:${PORT}/`);
    console.log(`  serving: ${ROOT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
    });
}

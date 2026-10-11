import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createVmServer } from "../tools/serve.mjs";
import { MAX_RANGE_BYTES, MINT_ID, parseImageRange } from "../tools/image-relay.mjs";
import { probeUrl, canStream } from "../app/sources.js";

const DATA = Buffer.from("a real range fixture, not a Linux Mint ISO. ".repeat(128));
const IMAGE_PATH = `/api/images/${MINT_ID}.iso`;

async function listen(server) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}
async function withFixture(run, options = {}) {
    const requests = [];
    const upstream = http.createServer((req, res) => {
        requests.push({ url: req.url, headers: req.headers });
        if (req.url === "/stall") return;
        if (req.url === "/broken") return res.writeHead(500).end("unavailable");
        if (req.url === "/ignore") return res.writeHead(200, {
            "Accept-Ranges": "bytes", "Content-Length": DATA.length, "Content-Type": "application/octet-stream",
        }).end(DATA);
        const range = parseImageRange(req.headers.range);
        if (!range) return res.writeHead(400).end("bad range");
        const end = Math.min(range.end, DATA.length - 1);
        if (range.start >= DATA.length) return res.writeHead(416).end();
        const headers = {
            "Content-Type": req.url === "/html" ? "text/html" : "application/octet-stream",
            "Content-Range": `bytes ${range.start}-${end}/${DATA.length}`,
            "Content-Length": end - range.start + 1,
        };
        if (req.url === "/wrong") headers["Content-Range"] = `bytes 1-${end + 1}/${DATA.length}`;
        if (req.url === "/encoded") headers["Content-Encoding"] = "gzip";
        res.writeHead(206, headers).end(DATA.subarray(range.start, end + 1));
    });
    const origin = await listen(upstream);
    const server = createVmServer({ relayOptions: {
        mintUrls: (options.paths || ["/image.iso"]).map((part) => origin + part), timeoutMs: options.timeoutMs || 1000,
    } });
    const base = await listen(server);
    try { await run({ base, origin, requests }); }
    finally { await close(server); await close(upstream); }
}

test("relay range parser refuses whole-file, malformed and oversized requests", () => {
    assert.deepEqual(parseImageRange("bytes=0-1"), { start: 0, end: 1 });
    assert.deepEqual(parseImageRange(`bytes=0-${MAX_RANGE_BYTES - 1}`), { start: 0, end: MAX_RANGE_BYTES - 1 });
    for (const value of [undefined, "bytes=0-", "bytes=-10", "bytes=2-1", "bytes=0-1,5-6", `bytes=0-${MAX_RANGE_BYTES}`, "bytes=0-9007199254740992"]) {
        assert.equal(parseImageRange(value), null, value);
    }
});

test("the diskless relay forwards exactly the requested bytes and browser CORS headers", async () => {
    await withFixture(async ({ base, requests }) => {
        const response = await fetch(base + IMAGE_PATH, { headers: {
            Range: "bytes=8-41", Cookie: "private=secret", Authorization: "Bearer do-not-forward", "X-Accept-Encoding": "identity",
        } });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("content-range"), `bytes 8-41/${DATA.length}`);
        assert.equal(response.headers.get("content-length"), "34");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.match(response.headers.get("access-control-expose-headers"), /Content-Range/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), DATA.subarray(8, 42));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].headers.range, "bytes=8-41");
        // Node's fetch may append an additional identity token for Range.
        assert.ok(requests[0].headers["accept-encoding"].split(",").every((token) => token.trim() === "identity"));
        assert.equal(requests[0].headers.cookie, undefined);
        assert.equal(requests[0].headers.authorization, undefined);
        assert.equal(requests[0].headers["x-accept-encoding"], undefined);
    });
});

test("the same browser source probe proves relay streaming; HEAD never fetches a whole image", async () => {
    await withFixture(async ({ base, requests }) => {
        const probe = await probeUrl(base + IMAGE_PATH);
        assert.equal(probe.ok, true, probe.error);
        assert.equal(canStream(probe), true);
        assert.equal(probe.size, DATA.length);
        const head = await fetch(base + IMAGE_PATH, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get("content-length"), String(DATA.length));
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        assert.deepEqual(requests.map((request) => request.headers.range), ["bytes=0-1", "bytes=0-1"]);
    });
});

test("a client cannot turn a named-image relay into an open proxy or trigger full downloads", async () => {
    await withFixture(async ({ base, requests }) => {
        assert.equal((await fetch(base + IMAGE_PATH)).status, 400);
        assert.equal((await fetch(base + IMAGE_PATH + "?url=http://127.0.0.1/private", { headers: { Range: "bytes=0-1" } })).status, 400);
        assert.equal((await fetch(base + "/api/images/other.iso", { headers: { Range: "bytes=0-1" } })).status, 404);
        assert.equal((await fetch(base + IMAGE_PATH, { method: "POST" })).status, 405);
        assert.equal((await fetch(base + IMAGE_PATH, { headers: { Range: `bytes=0-${MAX_RANGE_BYTES}` } })).status, 400);
        assert.equal(requests.length, 0);
        const options = await fetch(base + IMAGE_PATH, { method: "OPTIONS" });
        assert.equal(options.status, 204);
        assert.match(options.headers.get("access-control-allow-headers"), /X-Accept-Encoding/);
        const index = await (await fetch(base + "/api/stream-images")).json();
        assert.deepEqual(index.images, [{ id: MINT_ID, url: `api/images/${MINT_ID}.iso` }]);
    });
});

for (const path of ["/ignore", "/wrong", "/html", "/encoded"]) {
    test(`the relay refuses an invalid upstream (${path}) before sending image bytes`, async () => {
        await withFixture(async ({ base }) => {
            const response = await fetch(base + IMAGE_PATH, { headers: { Range: "bytes=0-1" } });
            assert.equal(response.status, 502);
            assert.match((await response.json()).error, /valid|reach/);
            assert.notEqual(response.headers.get("content-type"), "application/octet-stream");
        }, { paths: [path] });
    });
}

test("configured mirrors can fall back without ever accepting a full-file response", async () => {
    await withFixture(async ({ base, requests }) => {
        const response = await fetch(base + IMAGE_PATH, { headers: { Range: "bytes=0-1" } });
        assert.equal(response.status, 206);
        assert.equal((await response.arrayBuffer()).byteLength, 2);
        assert.deepEqual(requests.map((request) => request.url), ["/broken", "/ignore", "/image.iso"]);
    }, { paths: ["/broken", "/ignore", "/image.iso"] });
});

test("unreachable upstream requests are bounded by a timeout", async () => {
    await withFixture(async ({ base }) => {
        const response = await fetch(base + IMAGE_PATH, { headers: { Range: "bytes=0-1" } });
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /timed out/);
    }, { paths: ["/stall"], timeoutMs: 40 });
});

test("the static host serves byte ranges and HEAD but never git files or bad paths", async () => {
    await withFixture(async ({ base }) => {
        const range = await fetch(base + "/assets/images/kolibri.img", { headers: { Range: "bytes=0-1" } });
        assert.equal(range.status, 206);
        assert.equal((await range.arrayBuffer()).byteLength, 2);
        const suffix = await fetch(base + "/assets/images/kolibri.img", { headers: { Range: "bytes=-4" } });
        assert.equal(suffix.status, 206);
        assert.equal((await suffix.arrayBuffer()).byteLength, 4);
        const head = await fetch(base + "/assets/images/kolibri.img", { method: "HEAD", headers: { Range: "bytes=0-1" } });
        assert.equal(head.status, 206);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        for (const path of ["/.git/config", "/%2Egit/config", "/.cache/qa/welcome.png", "/node_modules/playwright-core/package.json"]) {
            assert.equal((await fetch(base + path)).status, 403, path);
        }
        assert.equal((await fetch(base + "/%zz")).status, 400);
        assert.equal((await fetch(base + "/assets/images/kolibri.img", { headers: { Range: "bytes=0-1,3-4" } })).status, 416);
        assert.equal((await fetch(base + "/index.html", { method: "POST" })).status, 405);
    });
});

/**
 * Unit tests for the disk-image layer: which strategy is chosen for bundled,
 * local and remote images, and how URLs are probed before booting.
 *
 * A throwaway HTTP server provides real end-to-end coverage of the fetch paths
 * (Node 22 has fetch, so these tests exercise the same code the browser runs).
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { RAM_LIMIT_BYTES, bundledSource, describeSource, probeUrl, resolveImage } from "../app/sources.js";
import { getEntry } from "../app/catalog.js";

const PAYLOAD = Buffer.from("browser-vm test payload".repeat(64));

/** Serve PAYLOAD with or without Range support, plus a 500 endpoint. */
async function withServer(run) {
    const server = http.createServer((req, res) => {
        if (req.url === "/broken") {
            res.writeHead(500).end("nope");
            return;
        }
        const range = req.headers.range;
        const withRanges = req.url !== "/norange";
        if (range && withRanges) {
            const [startText, endText] = range.replace("bytes=", "").split("-");
            const start = Number(startText);
            const end = endText ? Number(endText) : PAYLOAD.length - 1;
            const slice = PAYLOAD.subarray(start, end + 1);
            res.writeHead(206, {
                "Content-Type": "application/octet-stream",
                "Content-Range": `bytes ${start}-${end}/${PAYLOAD.length}`,
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(slice);
            return;
        }
        res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": PAYLOAD.length,
            ...(withRanges ? { "Accept-Ranges": "bytes" } : {}),
            "Access-Control-Allow-Origin": "*",
        });
        res.end(PAYLOAD);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
        await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test("bundled images are served by the site itself", async () => {
    const entry = getEntry("tiny-linux");
    const source = bundledSource(entry);
    assert.equal(source.kind, "bundled");
    assert.equal(source.url, "assets/images/tiny-linux.iso");
    assert.equal(source.device, "cdrom");
    assert.match(describeSource(source), /Built-in image/);

    const { image, strategy } = await resolveImage(source);
    assert.deepEqual(image, { url: "assets/images/tiny-linux.iso" });
    assert.match(strategy, /bundled/);
});

test("a game floppy is described as a floppy device", () => {
    const source = bundledSource(getEntry("kolibrios"));
    assert.equal(source.device, "fda");
});

test("streaming is chosen for images larger than the RAM limit", async () => {
    const file = { name: "huge.iso", size: RAM_LIMIT_BYTES + 1 };
    const source = { kind: "file", file, label: file.name, sizeBytes: file.size, device: "cdrom" };

    const { image, strategy } = await resolveImage(source);
    assert.deepEqual(image, { buffer: file, async: true });
    assert.match(strategy, /streamed from disk/);
    assert.match(describeSource(source), /Local file/);
});

test("streaming can be forced and RAM loading can be requested", async () => {
    const file = { name: "small.iso", size: 1024 };
    const source = { kind: "file", file, label: file.name, sizeBytes: file.size, device: "cdrom" };

    const streamed = await resolveImage(source, { mode: "stream" });
    assert.deepEqual(streamed.image, { buffer: file, async: true });
    assert.match(streamed.strategy, /streamed from disk/);

    // mode: "ram" needs FileReader, which only exists in browsers — assert the
    // correct decision was made by checking it does not take the streaming path.
    await assert.rejects(
        () => resolveImage(source, { mode: "ram" }),
        /FileReader|is not defined/,
        "RAM loading should go through the FileReader path",
    );
});

test("remote images use HTTP Range requests when the host supports them", async () => {
    await withServer(async (base) => {
        const probe = await probeUrl(`${base}/image.iso`);
        assert.equal(probe.ok, true, probe.error);
        assert.equal(probe.acceptRanges, true);
        assert.equal(probe.size, PAYLOAD.length);

        const { image, strategy } = await resolveImage({
            kind: "url", url: `${base}/image.iso`, label: "image.iso",
            sizeBytes: probe.size, acceptRanges: true, device: "cdrom",
        });
        assert.deepEqual(image, { url: `${base}/image.iso`, size: PAYLOAD.length, async: true });
        assert.match(strategy, /Range/);
    });
});

test("a host without Range support is flagged and downloaded instead", async () => {
    await withServer(async (base) => {
        const probe = await probeUrl(`${base}/norange`);
        assert.equal(probe.ok, true, probe.error);
        assert.equal(probe.acceptRanges, false);
        assert.ok(probe.notes.some((note) => /Range/i.test(note)));

        const { image, strategy } = await resolveImage(
            { kind: "url", url: `${base}/norange`, label: "norange", sizeBytes: PAYLOAD.length, acceptRanges: false, device: "cdrom" },
            { onProgress: () => {} },
        );
        assert.ok(image.buffer instanceof ArrayBuffer, "expected a downloaded buffer");
        assert.equal(image.buffer.byteLength, PAYLOAD.length);
        assert.match(strategy, /downloaded into memory/);
    });
});

test("probe reports transport problems and refuses nonsense URLs", async () => {
    const malformed = await probeUrl("http://");
    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /valid URL/);

    const wrongScheme = await probeUrl("ftp://example.org/file.iso");
    assert.equal(wrongScheme.ok, false);
    assert.match(wrongScheme.error, /http/);

    // A bare file name resolves against the page (handy when an image sits next
    // to the site) — it must fail for transport reasons, not as a syntax error.
    const relative = await probeUrl("some-local.iso");
    assert.equal(relative.ok, false);
    assert.doesNotMatch(relative.error, /valid URL/);

    await withServer(async (base) => {
        const broken = await probeUrl(`${base}/broken`);
        assert.equal(broken.ok, false);
        assert.match(broken.error, /500/);
    });

    const unreachable = await probeUrl("http://127.0.0.1:9/nothing.iso");
    assert.equal(unreachable.ok, false);
    assert.ok(unreachable.error.length > 20, "expected a helpful explanation");
});

test("a missing disk image is rejected instead of booting nothing", async () => {
    await assert.rejects(() => resolveImage({ kind: "file", label: "none", sizeBytes: 0, device: "cdrom" }), /No disk image/);
});

test("streaming-only refuses no-range hosts before issuing a whole-file fetch", async () => {
    await withServer(async (base) => {
        await assert.rejects(() => resolveImage({
            kind: "url", url: `${base}/norange`, sizeBytes: PAYLOAD.length, acceptRanges: false, streamOnly: true,
        }), /Streaming-only/);
    });
});

test("streaming-only takes precedence over a previous local-file RAM preference", async () => {
    const source = { kind: "url", url: "https://example.org/image.iso", sizeBytes: 2_000_000_000, acceptRanges: true };
    const result = await resolveImage(source, { mode: "ram", streamOnly: true });
    assert.deepEqual(result.image, { url: source.url, size: source.sizeBytes, async: true });
});

test("large non-streaming URLs are refused even when the streaming-only option is off", async () => {
    await assert.rejects(() => resolveImage({
        kind: "url", url: "https://example.org/huge.iso", sizeBytes: RAM_LIMIT_BYTES + 1, acceptRanges: false,
    }), /too large/);
});

async function withFetch(mock, run) {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try { await run(); } finally { globalThis.fetch = original; }
}

test("an Accept-Ranges header on a full 200 response is not proof of streaming", async () => {
    let cancelled = false;
    await withFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        headers: { "Accept-Ranges": "bytes", "Content-Length": "2000000000", "Content-Type": "application/octet-stream" },
    }), async () => {
        const probe = await probeUrl("https://example.org/lying.iso");
        assert.equal(probe.ok, true);
        assert.equal(probe.acceptRanges, false);
        assert.equal(probe.size, 2_000_000_000);
        assert.equal(cancelled, true, "the full body must be cancelled, not consumed");
    });
});

for (const [label, body, headers] of [
    ["missing/excluded Content-Range", "ab", { "Content-Length": "2" }],
    ["wrong offset", "ab", { "Content-Range": "bytes 1-2/100" }],
    ["wrong declared length", "abc", { "Content-Range": "bytes 0-1/100", "Content-Length": "3" }],
    ["lying chunked body", "abc", { "Content-Range": "bytes 0-1/100" }],
    ["short chunked body", "a", { "Content-Range": "bytes 0-1/100" }],
    ["encoded bytes", "ab", { "Content-Range": "bytes 0-1/100", "Content-Encoding": "gzip" }],
]) {
    test(`an invalid 206 (${label}) never becomes a streaming source`, async () => {
        await withFetch(async () => new Response(body, { status: 206, headers: { "Content-Type": "application/octet-stream", ...headers } }), async () => {
            const probe = await probeUrl("https://example.org/image.iso");
            assert.equal(probe.acceptRanges, false);
            assert.equal(probe.size, undefined, "partial Content-Length is not an ISO's full size");
        });
    });
}

test("HTML landing pages and credential-bearing image URLs are refused", async () => {
    await withFetch(async () => new Response("<h1>Download</h1>", { headers: { "Content-Type": "text/html" } }), async () => {
        const page = await probeUrl("https://example.org/download");
        assert.equal(page.ok, false);
        assert.match(page.error, /web page/);
        const credentials = await probeUrl("https://private:password@example.org/image.iso");
        assert.equal(credentials.ok, false);
        assert.match(credentials.error, /credentials/);
    });
});

test("a successful HEAD after a failed ranged GET does not prove ranges", async () => {
    await withFetch(async (url, options) => {
        if (options.method !== "HEAD") throw new Error("blocked ranged GET");
        return new Response(null, { headers: { "Accept-Ranges": "bytes", "Content-Length": "2000000000" } });
    }, async () => {
        const probe = await probeUrl("https://example.org/image.iso");
        assert.equal(probe.ok, true);
        assert.equal(probe.acceptRanges, false);
        assert.equal(probe.size, 2_000_000_000);
    });
});

test("link probing handles timeout and user cancellation without another request", async () => {
    let calls = 0;
    await withFetch((url, { signal }) => new Promise((resolve, reject) => {
        calls++;
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), async () => {
        const timeout = await probeUrl("https://example.org/stall.iso", { timeoutMs: 10 });
        assert.equal(timeout.ok, false);
        assert.match(timeout.error, /too long/);
        assert.equal(calls, 1);
        const controller = new AbortController();
        controller.abort();
        const cancelled = await probeUrl("https://example.org/stall.iso", { signal: controller.signal });
        assert.match(cancelled.error, /cancelled/);
        assert.equal(calls, 2);
    });
});

test("full RAM downloads enforce a limit on declared AND undeclared sizes", async () => {
    const { fetchToArrayBuffer } = await import("../app/sources.js");
    await withFetch(async () => new Response("abc", { headers: { "Content-Length": "3" } }), async () => {
        await assert.rejects(() => fetchToArrayBuffer("https://example.org/image.iso", null, { maxBytes: 2 }), /too large/);
    });
    await withFetch(async () => new Response("abc"), async () => {
        await assert.rejects(() => fetchToArrayBuffer("https://example.org/image.iso", null, { maxBytes: 2 }), /too large/);
    });
});


test("the built-in Linux browser is demand-loaded without a whole-image fetch", async () => {
    const source = bundledSource(getEntry("alpine-browser"));
    assert.equal(source.kind, "filesystem");
    await withFetch(() => { throw new Error("must not fetch an ISO"); }, async () => {
        const resolved = await resolveImage(source, { mode: "ram", streamOnly: true });
        assert.equal(resolved.image, undefined);
        assert.deepEqual(resolved.filesystem.basefs, { url: "assets/images/alpine-browser/fs.json" });
        assert.equal(resolved.filesystem.baseurl, "assets/images/alpine-browser/rootfs/");
        assert.match(resolved.cmdline, /root=host9p/);
        assert.match(resolved.strategy, /on demand/);
    });
});

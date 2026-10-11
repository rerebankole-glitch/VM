# Hosting disk images for the “From URL” tab

The **Stream URL** tab is the low-storage route: the image stays on its host and only
requested blocks are fetched. **Streaming only** is checked by default: unavailable
streaming stops the boot rather than falling back to a full multi-GB download.

**From disk** remains useful if you already have an ISO. The browser reads it locally;
local files are never uploaded. Streaming does not offload CPU/RAM or guarantee zero
browser cache use. For a current, persistent Mint desktop on server hardware, see
[REMOTE-MINT.md](REMOTE-MINT.md).

Two things have to be true for a URL to work:

| Requirement | Why |
| --- | --- |
| **CORS** — `Access-Control-Allow-Origin` | Without it the browser refuses to hand the bytes to the page. Most public mirrors do not send this header, which is why they fail here. |
| **Range requests** — `Accept-Ranges: bytes` + `Content-Range` | v86 then fetches only the 64 KB blocks the guest reads, instead of pulling gigabytes into memory. Without it the whole file is downloaded first. |

The probe verifies an actual `206` and `Content-Range: bytes 0-1/<size>`. A `200` response
is cancelled immediately even if it advertises `Accept-Ranges: bytes`. The host must
allow v86's `Range` and `X-Accept-Encoding` request headers, and expose `Content-Range`,
`Content-Length` and `Accept-Ranges` to the browser. HEAD alone does not prove streaming.
Small full downloads into RAM are an explicit opt-out from streaming-only and are capped
at 512 MB, including when the server does not send a size header.

## Which links work as-is?

| Host | CORS | Ranges | Usable in the URL tab? |
| --- | --- | --- | --- |
| GitHub Pages | ✅ `*` | ✅ | ✅ Yes (mind the 100 MB per-file limit) |
| GitHub Releases | ✅ `*` | ✅ | ✅ Yes, good for big ISOs |
| jsDelivr (serves GitHub content) | ✅ `*` | ✅ | ✅ Yes, files up to 20 MB |
| S3 / Cloudflare R2 / Backblaze B2 (configured, see below) | ✅ when configured | ✅ | ✅ Yes |
| nginx / Caddy you control | ✅ when configured | ✅ | ✅ Yes |
| Distro mirrors, Ubuntu `cdimage`, SourceForge, archive.org | ❌ often | ✅ often | Check in the browser; otherwise use a configured relay / another host |

These are hosting patterns, not availability guarantees. Always use **Check link**;
headers can vary across hosts, redirects and deployments. You do not have to store a
large ISO on your device when streaming works.

## Optional Node Mint relay

`npm start` includes a diskless relay for the named legacy Mint 19.3 image. It forwards
only bounded, verified ranges, never a full ISO, and no user-supplied URL can turn it into
an open proxy. A trusted alternate upstream can be configured by the server operator:

```bash
MINT_ISO_URL="https://your-host.example/linuxmint-19.3-xfce-32bit.iso" npm start
```

The upstream must actually return `206`, an exact `Content-Range`, a matching length and
uncompressed binary bytes. The server must be able to reach it. Responses use `no-store`;
there is no server disk cache. Source checks prove transport, not ISO authenticity —
verify images before hosting them. **Explore Mint** tries this relative endpoint first.
GitHub Pages cannot run the relay; direct CORS-enabled streaming still works there.
Details and the separate remote-VM route: [REMOTE-MINT.md](REMOTE-MINT.md).

## GitHub Releases (the easiest host for a big ISO)

1. Create a release (or use a draft) and attach the ISO as an asset.
2. Right-click the asset → **Copy link address**. It looks like
   `https://github.com/<user>/<repo>/releases/download/<tag>/<file>.iso`.
3. Paste it into the **From URL** tab and press **Check link**. GitHub sends the CORS and
   Range headers, so the probe should report *Reachable* with *Range requests: yes*.

Release assets are capped at 2 GB per file; GitHub Pages itself is limited to 1 GB per site
and 100 MB per file, and should not be used to host ISOs.

## Your own server

### nginx

```nginx
# serve the images with CORS and byte ranges enabled
location /isos/ {
    root /srv/vm;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Headers "Range, X-Accept-Encoding" always;
    add_header Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges" always;
    add_header Cache-Control "no-store" always;
    # nginx serves byte ranges automatically; do not merely advertise support.
    types { application/octet-stream iso img raw bin; }
    gzip off;                                    # ranges + compression do not mix
}
```

### Caddy

```caddy
example.com {
    header /isos/* {
        Access-Control-Allow-Origin "*"
        Access-Control-Allow-Headers "Range, X-Accept-Encoding"
        Access-Control-Expose-Headers "Content-Range, Content-Length, Accept-Ranges"
        Cache-Control "no-store"
    }
    file_server
}
```

Caddy and nginx both answer `Range` requests for static files by default; do not enable gzip
for the image files, because compressed responses cannot be range-addressed.

### S3 / R2 / B2

Set the object's metadata to include `Access-Control-Allow-Origin: *`, or add a bucket CORS
rule:

```json
[{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"],
   "ExposeHeaders": ["Content-Range", "Accept-Ranges", "Content-Length"], "MaxAgeSeconds": 3600 }]
```

`ExposeHeaders` matters: without it the page cannot read `Content-Range`, so the probe cannot
determine the file size, and range-based loading is skipped.

## Static hosts without Range support: split images into chunks

v86 can fetch fixed-size chunks instead of using Range requests. This is what the v86 project
recommends for plain static hosting, and the option is called `use_parts`.

1. Split the image into equal chunks (1 MB is a good size).
2. Upload `image.iso-0-1048576`, `image.iso-1048576-2097152`, … so the pattern is
   `<url>-<start>-<end>`.
3. Boot it with:

```js
cdrom: {
    url: "https://example.org/isos/image.iso",
    size: 1_973_420_032,
    async: true,
    use_parts: true,
    fixed_chunk_size: 1024 * 1024,
},
```

`copy/v86` ships [`tools/split-image.py`](https://github.com/copy/v86/blob/master/tools/split-image.py)
for step 1. To wire this into the interface, set `use_parts`/`fixed_chunk_size` in
`resolveImage()` inside `app/sources.js` — the catalog already records each image's exact size.

## Verifying a URL by hand

```bash
# CORS + size + range in one request
curl -sI -H "Origin: https://example.org" -H "Range: bytes=0-1" \
     https://example.org/isos/image.iso | grep -iE "http/|content-range|accept-ranges|access-control"

# expected:
#   HTTP/2 206
#   content-range: bytes 0-1/1973420032
#   accept-ranges: bytes
#   access-control-allow-origin: *
```

No `access-control-allow-origin` / exposed range headers means direct browser streaming
cannot work. Use a configured server relay, a suitable host, or **From disk** only if you
already have space for the image. A successful HEAD is not enough; test a small ranged
GET too. The application does that automatically.

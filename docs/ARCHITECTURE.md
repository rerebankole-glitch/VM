# Architecture and implementation notes

The application is a static site with no build step or runtime dependencies. Small ES
modules wrap the vendored emulator; one HTML file and stylesheet supply the workbench.
The optional Node host adds a named-image relay, not a remote VM.

```
index.html ──┬─► app/app.js      interface: picker, sources, controls, zoom, input capture
             │      ├─► app/catalog.js   the operating-system catalogue (pure data)
             │      ├─► app/iso9660.js   live kernel/initrd extraction from streamed ISOs
             │      ├─► app/sources.js   where disk images come from, URL probing, streaming
             │      ├─► app/engine.js    one v86 instance: boot/run/pause/reset/state/screenshot
             │      ├─► app/input.js     explicit screen focus / host shortcuts
             │      ├─► app/sessions.js  opt-in IndexedDB snapshots + metadata validation
             │      └─► app/util.js      formatting, escaping, safe preference helpers
             ├─► app/styles.css          theme + the DOM contract v86 expects
             └─► assets/v86/libv86.js    the emulator (sets window.V86), WASM core, BIOS roms
```

## Boot sequence

1. `libv86.js` is a classic script, so `window.V86` exists before the module runs.
2. `VmEngine.boot(config)` assembles the v86 options: `wasm_path`, BIOS roms, memory, VGA
   memory, boot order, NIC/relay, the chosen image under its device key (`cdrom`, `fda`,
   `hda`), the optional second disk, and — for Ubuntu/Mint live ISOs — an extracted
   `bzimage` + `initrd` + kernel cmdline. The ISO remains attached as `cdrom` so casper
   can read the squashfs. Serial bytes (`serial0-output-byte`) are forwarded to the UI.
3. v86 is constructed with `autostart: false`. The wrapper waits for `emulator-ready`,
   checks that the same instance is still attached, then starts the CPU if requested.
   A cancelled or failed load therefore cannot start a late, orphan CPU. Loading has a
   bounded initialization timeout; this is **not** a guest-OS boot deadline.
4. `VmEngine.boot()` resolves when initialized (and started, unless restoring a session).
   Save/restore/run also wait for that readiness and verify instance identity. Saving or
   restoring pauses a running CPU and resumes it in a `finally` block, preserving an
   already-paused guest. Lifecycle bus callbacks ignore destroyed/replaced instances.
5. Bus events drive the UI: `emulator-ready`, `emulator-loaded`, `emulator-started`,
   `emulator-stopped`, `download-progress`, `download-error`, `screen-set-size`.
   Setup controls are locked during operations or while attached, preventing mismatched
   hardware/source metadata. Power-off and restart warn about unsaved guest work.

## Disk images

`app/sources.js` turns a source into something v86 accepts. The decision tree matters,
because a wrong choice means either gigabytes of wasted RAM or a boot that never starts:

| Source | Condition | v86 image | Notes |
| --- | --- | --- | --- |
| Bundled | always | `{ url }` | Small files served by the site; v86 reports progress. |
| Local file | ≤ 512 MB | `{ buffer: ArrayBuffer }` | Read with a `FileReader` so the page can show a progress bar. |
| Local file | > 512 MB | `{ buffer: File, async: true }` | v86's `AsyncFileBuffer` reads 64 KB blocks off the user's disk on demand — no giant copy in RAM. |
| Remote URL | ranges available | `{ url, size, async: true }` | Only the blocks the guest reads are fetched. |
| Remote URL | no ranges | refuse by default | Only an explicit streaming-only opt-out allows bounded (≤512 MB) RAM downloads. |

`probeUrl()` performs a timeout-bounded 2-byte GET. A real `206` with exact
`Content-Range: bytes 0-1/<size>` and no content encoding proves streaming. An advertised
`Accept-Ranges` alone does not; HEAD fallback is informational, never a streaming proof.
HTML/JSON landing pages, mixed-content URLs and credential-bearing URLs are refused.
A server's full `200` body is cancelled immediately. If streaming-only is enabled,
`resolveImage()` refuses any unverified source before issuing a full fetch. Even the
explicit RAM fallback checks its byte limit during reading, not just `Content-Length`.

`tools/image-relay.mjs`, used only by the Node host, solves CORS for named legacy Mint
sources. GET requires an explicit single range ≤4 MB; upstream status, range, size,
encoding and length must match before bytes are sent. HEAD is derived from a tiny ranged
GET. Client-supplied URLs and arbitrary headers are never forwarded. Disconnects and
bounded timeouts abort upstream fetches; only configured mirror paths are available.
Responses use `Cache-Control: no-store`, and there is no disk image cache. The relay
cannot circumvent a host's outbound network restrictions or validate ISO authenticity.
The static host also refuses dotfiles, git files and out-of-root paths/symlinks.

The optional hard disk uses the RAM path on purpose: v86 can only write to a `File` in
memory-backed modes, and an installation needs writes. The buffer is kept so the interface can
offer **Download disk image** afterwards.

## The screen: two modes, one viewport

v86 renders text modes into a `<div>` (rows of styled spans) and graphical modes into a
`<canvas>` inside `#screen_container`, switching visibility by inline `display`. The
stylesheet therefore provides:

* `white-space: pre` and a monospace stack for the text element (otherwise text-mode geometry
  collapses),
* `touch-action: none` and a black background for the canvas,
* the `#screen_container:fullscreen` rules v86's own `screen_go_fullscreen()` expects.

**Zooming is done by the app, not by v86** (`screen_set_scale` stays at 1). A wrapper
(`#screen-stage`, absolutely positioned with `transform-origin: top left`) receives
`translate(x, y) scale(z)`, computed from the *layout* size of whichever child is visible
(`offsetWidth`/`offsetHeight`, which CSS transforms do not affect). Because the transform is
uniform and its translate is derived from the same numbers, the mouse mapping stays correct:
v86 reads the container's `getBoundingClientRect()` and normalises by its width and height, so
a scaled screen still produces exact guest coordinates.

The **screen shell** (viewport plus toolbar) goes fullscreen, so actions remain visible.
Desktop mode hides setup/log/metrics and uses a flex layout with a full-height viewport.
The native guest resolution and aspect ratio are preserved; fitting does not pretend to
change the guest's display resolution.

## Input capture

v86's keyboard listener is global and ignores only a few input types. `ScreenInput`
therefore owns the input boundary:

* Hovering does nothing. Clicking/focusing the display enables keyboard/mouse adapters;
  they start disabled. Input stays focused until the user focuses a host control or
  releases it, rather than stopping as the pointer leaves the canvas.
* Pointer lock is explicit (**Grab mouse**); the viewport is locked, not `document.body`.
  A locked pointer leaving the screen does not disable input. Native **Esc** releases it.
* Clicking/focusing outside, window blur, hidden document, pause/power-off, and the host
  **Ctrl+Alt+G** shortcut disable adapters and release modifiers to avoid stuck keys.
* Capture-phase host shortcuts do not leak into v86: **Ctrl+Alt+F** toggles fullscreen,
  **Ctrl+Alt+Delete/Backspace** sends one guest Ctrl+Alt+Del sequence. Native OS/browser
  reserved shortcuts remain limitations, not promises of keyboard-lock support.
* Clipboard read happens only after a click. It fills a reviewable textarea and does not
  execute automatically; denial falls back to manual paste. Explicit Send uses
  `keyboard_send_text()` (keystrokes, not a true guest shared clipboard). v86 silently
  ignores that API while its keyboard adapter is disabled: the wrapper enables it only
  for each synchronous character injection and restores its previous setting before
  yielding to host events. Characters are paced to avoid PS/2 FIFO overflow. Text is
  limited to 5,000 US-ASCII characters, CRLF becomes LF, and tabs expand to four spaces.
  Non-ASCII input is refused before sending, rather than silently dropped.

## State snapshots

`save_state()` returns a machine snapshot; sizes depend on guest state and may be large.
`restore_state()` requires the same emulator build, memory and base images. Streamed base
images are **not** wholly embedded — unread blocks must still be available from the same
URL. Changed disk blocks / memory are handled by v86's snapshot format. Do not promise a
self-contained Linux installation merely because a state file was saved.

There are two paths:

* Existing **Download state / Load state file** for user-managed snapshots, including
  local ISO images and attached disks. Keep the original image and matching settings.
* Opt-in **Save session here** for a reopenable built-in or verified streamed source,
  with no optional hard disk. `SessionStore` atomically replaces one IndexedDB slot
  (`metadata` + `snapshots`). Metadata reads do not pull the large snapshot into memory.
  Saves require confirmation, are bounded at 128 MB and check quota; no autosaving or
  persistent-storage permission is requested. Resume validates version/settings/source
  metadata, then re-probes remote size and ranges. Size is not an image checksum.

Deleting the slot frees its storage. Private mode, denied storage, eviction, quota errors,
invalid metadata, changed/unavailable images and version mismatches are handled without
preventing the VM from running. Settings alone use guarded, tiny localStorage writes.

## Testing without a browser

`npm test` runs dependency-free suites:

| Suite | What it protects |
| --- | --- |
| `tests/catalog.test.mjs` | Catalogue integrity: unique ids, sane memory sizes, bundled files exist with the recorded size, every entry has download links, nothing claims to be 64-bit. |
| `tests/assets.test.mjs` | The vendored emulator is complete (bundle + WASM magic bytes + BIOS roms + licences), the demo images match their SHA-256 sums, and the assets stay small enough to live in git. |
| `tests/static.test.mjs` | Interface wiring: every `#id` and `data-` attribute the app queries exists, every event name the engine subscribes to is declared in `v86.d.ts`, no root-absolute URLs (GitHub Pages sub-paths), docs linked from the footer exist, Pages plumbing is present, and the v86 screen contract holds. |
| `tests/emulator.test.mjs` | **Real boots.** v86 has a Node mode, so the same `libv86.js` and WASM core the browser loads retire millions of instructions from SeaBIOS, the FreeDOS floppy, the KolibriOS floppy, the Linux CD image and a machine with an extra hard disk — and the full API surface the interface calls is asserted to exist. |
| `tests/sources.test.mjs` | Range proof, safe streaming-only refusal, bounded downloads, timeout/CORS paths and local-file strategy selection. |
| `tests/relay.test.mjs` | Local upstream fixtures prove bounded relay transfers, fallback, header filtering, timeout/cancellation and safe static hosting; no public ISO download required. |
| `tests/input.test.mjs` | Explicit focus, blur/visibility releases, pointer lock and non-leaking host shortcuts with DOM event fixtures. |
| `tests/sessions.test.mjs` | Reopenable source/metadata validation, size/quota guards and unsupported browser-storage paths. |
| `tests/engine.test.mjs` | Lifecycle readiness/cancellation, stale event isolation and CPU pause/resume ordering during snapshots. |

Node mode cannot test everything: `FileReader` (used when reading a local ISO into RAM) and
the DOM/screen adapters only exist in browsers, so those paths are covered indirectly by the
strategy tests and by keeping the DOM contract checks strict.

### Optional real-browser regression test

On a development host with compatible Chromium libraries:

```bash
npm install --no-save --package-lock=false playwright-core
CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm run test:browser
# Optional screenshots, ignored in .cache/qa/:
CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm run test:browser -- --screenshots
```

Alternatively install `@sparticuz/chromium` alongside `playwright-core` on a compatible
host; the runner can locate that binary. This is **test tooling only**, not a site runtime
dependency. The usual `npm test` and `npm start` need no installation.

The smoke runner creates a throwaway local server, blocks external image requests, and
checks a real coloured KolibriOS desktop, click/release focus, pause, fullscreen toolbar,
state persistence across reload, resume/delete, the unsupported Mint acknowledgement and
failed-source refusal, a real Linux boot using only ISO ranges despite an earlier RAM-file
setting, mobile layout, and boot with both IndexedDB and localStorage denied. It also
waits for a mapped native Dillo window inside Alpine Linux, navigates to a second local
page through actual guest keyboard input and checks the guest's X window title over
serial. QA-only instrumentation stays in Playwright, never the production application.
It does **not** download or claim to boot Mint, antiX or a guest's public internet.

## Extending it

* **Add an operating system** — append an entry to `app/catalog.js` (see
  [DISTROS.md](DISTROS.md#adding-your-own-operating-system)); no other file changes.
* **Ship another built-in image** — drop it in `assets/images/`, record its size and SHA-256 in
  `assets/images/SHA256SUMS` (or extend `tools/fetch-demo-images.sh`), and reference it from the
  catalogue with `status: "instant"`.
* **Refresh the emulator** — `V86_VERSION=0.5.471 npm run vendor:v86`; the script copies the
  bundle, the WASM core, the `.d.ts` and the roms, then records the version. `npm test` will
  tell you if the API the interface uses has moved.
* **Embed just the VM elsewhere** — `app/engine.js` has no UI dependencies: pass a container
  element and hooks, call `boot()`, and you have a working machine. `app/catalog.js` is
  optional.


## Native Linux browser profile

`alpine-browser` is a built-in `filesystem` source rather than a CD/floppy image.
`bundledSource` describes the relative 9p index and content-object base URL;
`resolveImage` returns a filesystem configuration without fetching a whole image.
`VmEngine` passes `filesystem`, `bzimage_initrd_from_filesystem` and the profile's kernel
command line to v86. The kernel and initramfs are found in the index's `/boot` directory.
Guest file writes remain in RAM, not in the hosted content objects.

The image includes Fluxbox, Dillo, a terminal and local test pages. Dillo's browser window
is a native guest application. It is a limited non-JavaScript browser, not a Firefox
substitute. Networking remains opt-in; no third-party relay is silently enabled.
The new source is deliberately excluded from browser-session eligibility until its
filesystem restore path is verified.

`tools/linux-browser/` and the cloud preparation workflow reproduce the image. Package
signatures, APK-recorded recipe commits, verified corresponding source archives,
filesystem checksums and a recursive asset budget protect the build. Generated rootfs
exports/source archives stay outside Git; only the bounded compressed runtime files
are vendored. See [LINUX-BROWSER.md](LINUX-BROWSER.md).

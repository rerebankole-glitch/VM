# Architecture and implementation notes

The project is a static site with no build step. Four small ES modules wrap the vendored
emulator, and the whole interface is one HTML file plus one stylesheet.

```
index.html ──┬─► app/app.js      interface: picker, sources, controls, zoom, input capture
             │      ├─► app/catalog.js   the operating-system catalogue (pure data)
             │      ├─► app/sources.js   where disk images come from, URL probing, streaming
             │      ├─► app/engine.js    one v86 instance: boot/run/pause/reset/state/screenshot
             │      └─► app/util.js      formatting, escaping, storage helpers
             ├─► app/styles.css          theme + the DOM contract v86 expects
             └─► assets/v86/libv86.js    the emulator (sets window.V86), WASM core, BIOS roms
```

## Boot sequence

1. `libv86.js` is a classic script, so `window.V86` exists before the module runs.
2. `VmEngine.boot(config)` assembles the v86 options: `wasm_path`, BIOS roms, memory, VGA
   memory, boot order, NIC/relay, the chosen image under its device key (`cdrom`, `fda`,
   `hda`), and the optional second disk.
3. `autostart: true` — v86 loads the WASM core, the roms and the disk images, then starts the
   CPU itself. The interface deliberately never calls `run()` before the `emulator-ready`
   event, because v86 throws if `run()` arrives while it is still initialising. (`VmEngine.run`
   awaits `readyPromise` before forwarding, which keeps the Resume button race-free.)
4. Bus events drive the UI: `emulator-ready`, `emulator-loaded`, `emulator-started`,
   `emulator-stopped`, `download-progress`, `download-error`, `screen-set-size`.

## Disk images

`app/sources.js` turns a source into something v86 accepts. The decision tree matters,
because a wrong choice means either gigabytes of wasted RAM or a boot that never starts:

| Source | Condition | v86 image | Notes |
| --- | --- | --- | --- |
| Bundled | always | `{ url }` | Small files served by the site; v86 reports progress. |
| Local file | ≤ 512 MB | `{ buffer: ArrayBuffer }` | Read with a `FileReader` so the page can show a progress bar. |
| Local file | > 512 MB | `{ buffer: File, async: true }` | v86's `AsyncFileBuffer` reads 64 KB blocks off the user's disk on demand — no giant copy in RAM. |
| Remote URL | ranges available | `{ url, size, async: true }` | Only the blocks the guest reads are fetched. |
| Remote URL | no ranges | download → `{ buffer: ArrayBuffer }` | The whole file is fetched first (the probe warns about this). |

`probeUrl()` performs a 2-byte ranged GET and reports reachability, size, range support and
CORS, falling back to `HEAD` to distinguish “file missing” from “no CORS”. The distinction is
what turns a confusing failure into the advice “download it and use From disk”.

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

The viewport (not the page) is what goes fullscreen, so the toolbar keeps working and the
transform stays valid.

## Input capture

* **v86's keyboard listener is global** and only skips events whose target is an `INPUT` or
  `TEXTAREA`. To keep the setup panels usable while a guest runs, the app enables keyboard and
  mouse input on `pointerenter` of the screen and disables it on `pointerleave`, sending
  key-ups for the modifier keys so a half-pressed Shift cannot stick inside the guest.
* **The mouse is scoped** by v86 itself (`is_child` of the screen container), and relative
  devices are driven through pointer lock: clicking the screen locks the pointer (<kbd>Esc</kbd>
  releases). Guests with an absolute pointing device are handled without locking.
* `Ctrl+Alt+Del` is sent as scancodes (`0x1D 0x38 0x53` plus releases) — the only reliable way
  to reach a login manager.
* **Type text** uses `keyboard_send_text()` to inject a string as keystrokes, which is much
  faster than typing a long command by hand.

## State snapshots

`save_state()` returns a zstd-compressed image of CPU, RAM, devices and disks (tens of
megabytes for a 512 MB guest). `restore_state()` requires the *same* machine: same memory
size, same attached images, same BIOS. The interface therefore treats snapshots as files the
user manages, and documents that a snapshot belongs to one configuration.

## Testing without a browser

`npm test` runs four suites:

| Suite | What it protects |
| --- | --- |
| `tests/catalog.test.mjs` | Catalogue integrity: unique ids, sane memory sizes, bundled files exist with the recorded size, every entry has download links, nothing claims to be 64-bit. |
| `tests/assets.test.mjs` | The vendored emulator is complete (bundle + WASM magic bytes + BIOS roms + licences), the demo images match their SHA-256 sums, and the assets stay small enough to live in git. |
| `tests/static.test.mjs` | Interface wiring: every `#id` and `data-` attribute the app queries exists, every event name the engine subscribes to is declared in `v86.d.ts`, no root-absolute URLs (GitHub Pages sub-paths), docs linked from the footer exist, Pages plumbing is present, and the v86 screen contract holds. |
| `tests/emulator.test.mjs` | **Real boots.** v86 has a Node mode, so the same `libv86.js` and WASM core the browser loads retire millions of instructions from SeaBIOS, the FreeDOS floppy, the KolibriOS floppy, the Linux CD image and a machine with an extra hard disk — and the full API surface the interface calls is asserted to exist. |
| `tests/sources.test.mjs` | Strategy selection and URL probing against a local HTTP server, including a host that refuses Range requests. |

Node mode cannot test everything: `FileReader` (used when reading a local ISO into RAM) and
the DOM/screen adapters only exist in browsers, so those paths are covered indirectly by the
strategy tests and by keeping the DOM contract checks strict.

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

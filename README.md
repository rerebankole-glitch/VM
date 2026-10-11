# WebVM — your browser computer

A real 32-bit x86 PC inside a browser tab, with **one-click desktop launch**, a clean
**desktop mode**, focused keyboard/mouse controls, and **streaming-only image loading**
for computers without room to save a big ISO. No painted-on fake desktop: the apps run
inside genuine guest operating systems, using [v86](https://github.com/copy/v86).

The app remains a static site with no runtime dependencies or build step. Drop it on
GitHub Pages (or any static host). Local files are never uploaded. The optional Node host
also supplies a **diskless, named-image Mint relay** for mirrors that lack CORS.

**Important:** current Linux Mint is 64-bit and cannot run in v86. Legacy Mint 19.3 Xfce
is a slow, unsupported candidate, not a guaranteed boot or a daily-use computer. If you
want current Mint with permanent files and no OS installation on your device, use a
**persistent remote 64-bit VM**. See [the storage and remote Mint guide](docs/REMOTE-MINT.md).

```
┌─────────────────────────── browser tab ───────────────────────────┐
│  the page  ──────────────►  v86 (WebAssembly x86 CPU + devices)   │
│                               ▲                                   │
│  your ISO / IMG ──────────────┘  read locally, block by block      │
└───────────────────────────────────────────────────────────────────┘
```

## Quick start

### Locally

```bash
git clone https://github.com/rerebankole-glitch/VM.git
cd VM
npm start          # serves http://localhost:8080 — or: python3 -m http.server 8080
```

Open the URL and click **Linux + browser**: Alpine Linux boots a real Fluxbox desktop
with **Dillo already installed**, opening a local welcome page. Linux loads compressed
filesystem files on demand from this site — about 72 MiB in total, no large ISO to
save. Allow a few minutes for a cold Linux browser boot. **Ubuntu 18.04** and
**Linux Mint 19.3** stream a 32-bit live ISO without saving it: the emulator reads
`casper/vmlinuz` and the initrd with HTTP Range requests and boots that kernel
directly (no ISOLINUX menu). **Instant desktop** launches KolibriOS; **Linux terminal**
launches the small console Linux. You can also pick a system and press **Boot**.

Dillo supports basic pages and HTTPS, **not JavaScript-heavy sites**. Guest internet
requires an explicitly selected external relay; the local welcome page works offline.
Guest changes are temporary, and browser-session saving is not supported for the new
filesystem profile yet. See [the Linux browser guide](docs/LINUX-BROWSER.md).

**Ubuntu 18.04** / **Explore Mint** explain the legacy/security limits, then check
streaming sources. With `npm start`, they first try the Node host's named byte-range
relay, then direct mirrors. The host must be able to reach a suitable image server.
With GitHub Pages, there is no relay backend. If streaming is unavailable the app
stops, without a whole-ISO download. Configure an alternate trusted image with
`UBUNTU_ISO_URL`, `MINT_ISO_URL`, `--ubuntu-url` or `--mint-url`;
see [docs/REMOTE-MINT.md](docs/REMOTE-MINT.md).

### On GitHub Pages

Live site: **https://rerebankole-glitch.github.io/VM/**.

This repository already uses **Deploy from a branch → main → / (root)**. Merging the
working branch into `main` triggers GitHub's Pages publication. The test workflow runs
on the pull request and main push. There is no runtime build step or backend on Pages.

For another repository, enable that branch source in **Settings → Pages**, or choose
**GitHub Actions** to let the included workflow assemble only the site files and gate
publication on tests. Details: [docs/DEPLOY.md](docs/DEPLOY.md).

While you wait for Pages, the same site runs anywhere: `npm start` serves it locally, and
any static host (Cloudflare Pages, Netlify, a plain nginx) can serve the repository as-is.

## What actually boots

v86 emulates a **32-bit x86** CPU (Pentium-4 class instruction set, PAE paging, no 64-bit
long mode), one core, with VGA, IDE, floppy, PS/2 input and an NE2000/VirtIO network card.
That decides everything: **use 32-bit (i386) images, and pick releases from before the
distros dropped 32-bit builds.**

| System | Release to use | Size | How it feels |
| --- | --- | --- | --- |
| **Alpine + Dillo** (built in) | Alpine 3.23 x86 / Fluxbox | ≈72 MiB on demand | Real Linux desktop and graphical browser; no JavaScript; 256 MB guest RAM |
| **Tiny Linux** (built in) | Buildroot test image | 5 MB | Boots to a root shell in seconds |
| **KolibriOS** (built in) | 0.7.7.0 | 1.4 MB | Full GUI desktop, boots in seconds |
| **FreeDOS** (built in) | 7.22 | 720 KB | Instant DOS prompt |
| **MX Linux** | `MX-19.4_386.iso` | 1.7 GB | Real Xfce desktop, slow boot |
| **Ubuntu** | `ubuntu-18.04.5-desktop-i386.iso` | ≈1.9 GB | Last 32-bit Ubuntu Desktop; direct casper kernel boot; GNOME is heavy |
| **Lubuntu** | `lubuntu-18.04.5-desktop-i386.iso` | 1.1 GB | Lightest of the Ubuntu family; same direct-kernel path |
| **Linux Mint** | `linuxmint-19.3-xfce-32bit.iso` | 1.8 GB | Unsupported legacy Xfce; direct casper kernel boot; slow, not guaranteed |
| **antiX** | `antiX-26.1_386-full.iso` | ≈2.3 GB | Firefox ESR included in full; experimental, not boot-verified here |
| **Debian** | 12 “bookworm” live i386 | 2.9 GB | Full Debian, security supported |
| **Tiny Core Linux** | `TinyCore-current.iso` | 17 MB | Tiny and fast |
| **Alpine Linux** | `latest-stable` x86 | 250 MB | Console-first, ideal for scripting |
| **Arch Linux 32** | i686 | 800 MB | Rolling release for 32-bit |

**Modern 64-bit releases cannot run** — MX 21/23/25, Mint 20+, Lubuntu 20.04+, Debian 13
i386 installers. The emulated CPU has no long mode, so those kernels stop at the first
instruction. The interface says so up front, and
**[docs/DISTROS.md](docs/DISTROS.md)** explains the situation in detail.

## Using it

| Step | What to do |
| --- | --- |
| 1. System | Start **Linux + browser**, the instant KolibriOS desktop, a Linux terminal, or another 32-bit guest. Browser limits and experimental-image warnings are explicit. |
| 2. Disk image | **Built in** (small site assets), **Stream URL** (no ISO file to save; verified byte ranges + CORS needed), or **From disk** (pick/drop a file you already have). Streaming-only is on by default. |
| 3. Hardware | Memory, video memory, boot order, network backend. “Use recommended settings” restores the values tuned for the selected system. |

While it runs:

* **Click the screen to control it.** Input remains connected until you focus a page
  control, switch tabs/windows, or press **Ctrl+Alt+G**. Merely hovering never captures
  your keyboard. Modifier keys are released when focus is lost.
* **Grab mouse** enables pointer lock for relative mice and games; **Esc** releases it.
  Pointer lock is explicit, not forced on every click. Absolute guest pointers can work
  without it.
* **Desktop mode** removes setup/log/metrics clutter and uses the window's height;
  **Show setup** brings it back. **Fullscreen** keeps the toolbar visible. The focused
  guest's **Ctrl+Alt+F** shortcut toggles fullscreen; browsers/host OSes still reserve
  some shortcuts.
* **Screenshot**, **Ctrl+Alt+Del**, zoom and other actions are in the compact toolbar
  and **Tools** menu. Pausing visibly labels the paused screen.
* **Paste from clipboard** opens a review box; it does not execute clipboard commands
  automatically. **Type text** accepts multiple lines; **Ctrl+Enter** sends them as
  guest keystrokes, paced to avoid dropped keys. This path supports up to 5,000 US-ASCII
  characters per send (tabs expand to spaces), not a shared guest clipboard. Clipboard
  denial falls back to manual paste.
* **Save session here** is an **optional local** snapshot, never an autosave or cloud
  backup. It requires confirmation, uses at most 128 MB, and checks browser quota.
  Resume/delete it on the welcome screen. This path supports built-in/streamed disk-image
  guests without an extra hard disk; the new demand-loaded filesystem is excluded until
  restore is verified. Local ISO files and installations use file snapshots.
* **Download state / Load state file** export/restore the machine with the same emulator,
  memory and images. Saving/restoring pauses the CPU and resumes it only if it was running.
* Restart/power-off/closing a live guest warn about unsaved work. Setup controls are
  locked while attached, so changes cannot silently mismatch a running snapshot.

### No space for an ISO?

The featured **Linux + browser** desktop needs no ISO at all: its filesystem files load
on demand. For other distributions, prefer **Stream URL**, with **Streaming only** left checked. A 2-byte probe verifies
real Range support and an exposed image size. A misleading `Accept-Ranges` header is
not enough. Hosts that ignore ranges are refused, not silently downloaded. Turning
streaming-only off explicitly allows small RAM downloads, bounded at 512 MB even if the
server omits `Content-Length`.

For a mirror without CORS, the Node host's optional Mint relay transfers only bounded
ranges and writes no ISO to disk. Static hosts cannot run that relay. Streaming still
uses your CPU/RAM and may use browser caches; it is not a remote computer.

If you already have an ISO, **From disk** reads it locally, without uploading it. Large
files are read block-by-block instead of copied into RAM. More details:
[image hosting](docs/HOSTING-ISOS.md) and [remote Mint](docs/REMOTE-MINT.md).

## Performance expectations

An emulated CPU is roughly **10–50× slower** than the host. Rough guidance:

* KolibriOS, FreeDOS and the small console Linux boot quickly.
* The Alpine browser desktop needs more time; expect a minute or more on a slow device.
* Other small Linux images vary with guest services and the host CPU.
* Ubuntu 18.04, Lubuntu 18.04, Mint 19.3, MX 19.4 live desktops: **several minutes to
  tens of minutes** even with direct kernel boot; the desktop is usable for exploring,
  not for work. Serial lines in the activity log are kernel messages, not a freeze.

The status bar shows a live MIPS figure. If a boot looks stuck, it usually is not — the
log panel shows progress and the CPU counter tells you whether the guest is still working.

## Project layout

```
index.html                 the whole application shell
app/
  app.js                   setup, desktop mode, streaming launch, controls, sessions
  input.js                 explicit display focus, input release and host shortcuts
  sessions.js              opt-in, bounded IndexedDB snapshots and metadata validation
  engine.js                wrapper around one v86 instance (boot/run/pause/reset/state)
  catalog.js               the operating-system catalogue (pure data — edit this to add distros)
  iso9660.js               live-kernel extraction from streamed Ubuntu/Mint ISOs
  sources.js               on-demand filesystem / disk images, URL probing, streaming
  styles.css               dark responsive theme (+ the markup contract v86 needs)
  util.js                  formatting and storage helpers
assets/
  v86/                     vendored v86 build, WASM core, SeaBIOS + VGA BIOS roms (BSD-2 / LGPL)
  images/                  three tiny bootable images that ship with the site
tools/
  vendor-v86.sh            refresh assets/v86 from a pinned v86 release
  fetch-demo-images.sh     refresh assets/images from copy/images
  serve.mjs                static + named-image host, Range support, safe file serving
  image-relay.mjs          optional diskless legacy Mint relay (never an open proxy)
tests/                     node:test suite — catalogue, assets, interface wiring, real boots
docs/                      deployment, distro matrix, ISO hosting, architecture
```

`npm run vendor` refreshes both vendored directories and updates the recorded checksums;
`npm test` runs the whole suite, including genuine boots of the bundled images through the
same `libv86.js` the browser uses (v86 has a Node mode, so this needs no browser).

## How it works

1. `index.html` loads `assets/v86/libv86.js`, which exposes the `V86` constructor.
2. `engine.js` builds the machine (memory, VGA, boot order, NIC, BIOS roms, disk image) and
   starts it. v86's WASM core translates x86 instructions to WebAssembly at runtime.
3. The screen lives in `#screen_container`: v86 writes text mode into a `<div>` and
   graphical modes into a `<canvas>`; the interface scales that pair to fit the viewport.
4. The featured Alpine desktop loads compressed 9p filesystem files on demand. Ubuntu
   and Mint live ISOs are scanned with ISO 9660 Range reads for `casper/vmlinuz` +
   initrd, then booted as a v86 bzImage with the CD still attached for the squashfs.
   Other disk images arrive as a bundled file, a local `File` read block-by-block when
   large, or a URL using proven HTTP Range requests. The optional Node relay solves
   mirror CORS without hosting a VM or saving the full ISO.
5. Guest networking is optional: `inbrowser` is a built-in virtual LAN, or you can point it
   at a [wsproxy](https://github.com/copy/v86/blob/master/docs/networking.md) relay for real
   internet access.

More detail, including the reasoning behind the input-capture and zoom strategies, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limitations, honestly

* **No 64-bit guests.** No long mode, no multicore, no nested virtualisation. Current
  Mint requires a different, server-side VM; the UI says this before a streaming attempt.
* **Live ISOs are heavy.** They are real kernels with real desktops; the emulator is the
  bottleneck, not the page.
* **Guest network access needs a relay.** Nothing is enabled by default; the public
  `relay.widgetry.org` proxy is shared and slow, and a self-hosted relay is the fast option.
* **Snapshots use resources.** Save sizes depend on guest state and can be large.
  Browser sessions are opt-in, capped at 128 MB, and subject to quota/eviction. There is
  no cloud persistence or automatic ISO cache.
* **Mobile browsers are cramped and memory-limited.** The console Linux uses 64 MB;
  the graphical browser profile needs 256 MB plus substantial browser/emulator overhead.
  It may be unsuitable for low-memory phones.

## Credits and licences

* **v86** by Fabian Hemmer and contributors — BSD-2-Clause. Vendored in `assets/v86/`,
  including the WASM core and the SeaBIOS/VGA BIOS roms (SeaBIOS is LGPL-3.0; see
  `assets/v86/COPYING.LESSER`).
* **Demo images** (`linux.iso`, `freedos722.img`, `kolibri.img`) come from the v86 project's
  test image repository and contain GPL-licensed operating systems — see
  `assets/images/README.md`.
* Application code in this repository: MIT, see [LICENSE](LICENSE). Third-party components
  and their licences are listed in [NOTICE](NOTICE).


### Linux browser image preparation

The already prepared Alpine desktop is a bounded, demand-loaded filesystem, not a giant
ISO. `tools/linux-browser/` contains the Docker/guest recipes. The separate preparation
workflow builds in GitHub's cloud runner and publishes exact copyleft source archives
as release assets, outside Git. APK provenance and all deployed checksums are included.
Rebuilding is optional and requires a separate Docker build host, not the visitor's PC.
See [docs/LINUX-BROWSER.md](docs/LINUX-BROWSER.md).

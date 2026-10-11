# Browser VM

A complete x86 PC that boots **MX Linux, Lubuntu, Linux Mint, Debian, antiX, Tiny Core,
FreeDOS and KolibriOS** inside a browser tab — no plugins, no backend, no uploads.

It is a static site: HTML, CSS, ~360 KB of JavaScript and a WebAssembly CPU emulator
([v86](https://github.com/copy/v86)). Drop it on GitHub Pages (or any static host) and
visitors get a working virtual machine. Your ISO files never leave the visitor's device.

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

Open the URL, pick a system, press **Boot**. The three built-in images (Tiny Linux,
KolibriOS, FreeDOS) are already in the repository, so the first boot needs no download.

### On GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: “GitHub Actions”.**
3. The workflow in `.github/workflows/pages.yml` runs the test suite, then publishes the
   site to `https://<user>.github.io/<repo>/`.

No build step, no secrets, no configuration. Prefer the old-fashioned way? Pages can also
serve this repository straight from the `main` branch root (**Source: Deploy from a
branch**) — the site is plain static files. Details and troubleshooting: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## What actually boots

v86 emulates a **32-bit x86** CPU (Pentium-4 class instruction set, PAE paging, no 64-bit
long mode), one core, with VGA, IDE, floppy, PS/2 input and an NE2000/VirtIO network card.
That decides everything: **use 32-bit (i386) images, and pick releases from before the
distros dropped 32-bit builds.**

| System | Release to use | Size | How it feels |
| --- | --- | --- | --- |
| **Tiny Linux** (built in) | Buildroot test image | 5 MB | Boots to a root shell in seconds |
| **KolibriOS** (built in) | 0.7.7.0 | 1.4 MB | Full GUI desktop, boots in seconds |
| **FreeDOS** (built in) | 7.22 | 720 KB | Instant DOS prompt |
| **MX Linux** | `MX-19.4_386.iso` | 1.7 GB | Real Xfce desktop, slow boot |
| **Lubuntu** | `lubuntu-18.04.5-desktop-i386.iso` | 1.1 GB | Lightest of the Ubuntu family |
| **Linux Mint** | `linuxmint-19.3-xfce-32bit.iso` | 1.8 GB | Xfce edition only, slow but works |
| **antiX** | `antiX-23.2_386-full.iso` | 1.7 GB | sysVinit, noticeably snappier |
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
| 1. System | Pick a card. Built-in systems are ready immediately; distro cards show download links for the right 32-bit ISO. |
| 2. Disk image | **Built in** (nothing to fetch), **From disk** (pick or drop an `.iso`/`.img` — recommended, it is the fastest path), or **From URL** (works only where the host sends CORS + Range headers). |
| 3. Hardware | Memory, video memory, boot order, network backend. “Use recommended settings” restores the values tuned for the selected system. |

While it runs:

* **Hover the screen to type.** Keyboard input is only captured over the screen area, so
  the rest of the page stays usable.
* **Click the screen to grab the mouse**, <kbd>Esc</kbd> releases it. Guests with an
  absolute pointing device (Xfce, LXDE) work without grabbing.
* **Fullscreen** scales the emulated screen to the window; **Fit**/`−`/`+` control the zoom.
* **Screenshot** saves a PNG, **Ctrl+Alt+Del** reaches the guest's login manager.
* **Save state / Load state** download and restore a compressed snapshot of the whole
  machine (CPU, RAM, screen, disks) — handy to skip a 20-minute boot next time.
* **Type text** sends a string to the guest as keystrokes (great for long commands).

### Getting the ISOs

Download links for every supported release are in the interface (step 2) and in
[docs/DISTROS.md](docs/DISTROS.md). Then choose **From disk** and pick the file. This is
the recommended route: it bypasses CORS entirely, and for images above 512 MB v86 streams
blocks off your disk instead of loading gigabytes into RAM.

## Performance expectations

An emulated CPU is roughly **10–50× slower** than the host. Rough guidance:

* Built-in images, KolibriOS, FreeDOS: **instant**, feels native.
* Tiny Core, Alpine: **under a minute** to a usable system.
* MX 19.4, antiX, Lubuntu 18.04, Mint 19.3 live desktops: **several minutes to tens of
  minutes** for the first boot; the desktop is usable for exploring, not for work.

The status bar shows a live MIPS figure. If a boot looks stuck, it usually is not — the
log panel shows progress and the CPU counter tells you whether the guest is still working.

## Project layout

```
index.html                 the whole application shell
app/
  app.js                   interface logic: picker, sources, controls, zoom, input capture
  engine.js                wrapper around one v86 instance (boot/run/pause/reset/state)
  catalog.js               the operating-system catalogue (pure data — edit this to add distros)
  sources.js               built-in / local file / URL disk images, URL probing, streaming
  styles.css               dark responsive theme (+ the markup contract v86 needs)
  util.js                  formatting and storage helpers
assets/
  v86/                     vendored v86 build, WASM core, SeaBIOS + VGA BIOS roms (BSD-2 / LGPL)
  images/                  three tiny bootable images that ship with the site
tools/
  vendor-v86.sh            refresh assets/v86 from a pinned v86 release
  fetch-demo-images.sh     refresh assets/images from copy/images
  serve.mjs                dependency-free static server with Range support
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
4. Disk images arrive one of three ways: bundled file, a `File` from the user (streamed
   block-by-block when large), or a URL using HTTP Range requests.
5. Guest networking is optional: `inbrowser` is a built-in virtual LAN, or you can point it
   at a [wsproxy](https://github.com/copy/v86/blob/master/docs/networking.md) relay for real
   internet access.

More detail, including the reasoning behind the input-capture and zoom strategies, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Limitations, honestly

* **No 64-bit guests.** No long mode, no multicore, no nested virtualisation.
* **Live ISOs are heavy.** They are real kernels with real desktops; the emulator is the
  bottleneck, not the page.
* **Guest network access needs a relay.** Nothing is enabled by default; the public
  `relay.widgetry.org` proxy is shared and slow, and a self-hosted relay is the fast option.
* **Saving state is memory-hungry.** A snapshot of a 512 MB guest is tens of megabytes of
  compressed data in the browser tab.
* **Mobile browsers work but are cramped** — 64 MB RAM and a 32-bit guest is the practical
  ceiling on phones.

## Credits and licences

* **v86** by Fabian Hemmer and contributors — BSD-2-Clause. Vendored in `assets/v86/`,
  including the WASM core and the SeaBIOS/VGA BIOS roms (SeaBIOS is LGPL-3.0; see
  `assets/v86/COPYING.LESSER`).
* **Demo images** (`linux.iso`, `freedos722.img`, `kolibri.img`) come from the v86 project's
  test image repository and contain GPL-licensed operating systems — see
  `assets/images/README.md`.
* Application code in this repository: MIT, see [LICENSE](LICENSE). Third-party components
  and their licences are listed in [NOTICE](NOTICE).

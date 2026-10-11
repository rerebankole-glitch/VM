# A Linux desktop that actually includes a browser

## Best fit for this Pages app: Alpine Linux + Dillo

A **kernel** is the operating-system core, not a desktop or a browser. This app's
**Linux + browser** button boots a complete, deliberately small **32-bit Alpine Linux
3.23** guest with the **6.18.55 linux-virt kernel**, **Fluxbox, Dillo and a terminal**. Dillo is a native graphical Linux
application running inside v86 — not a host iframe pretending to be a guest browser.

The browser opens an included local welcome page automatically. Right-click the
desktop for the app menu and terminal. Dillo can navigate to another local page even
with networking disabled.

### Storage and performance

Instead of a multi-gigabyte ISO, the guest mounts v86's **VirtIO/9p filesystem**.
A small index describes the files; individual compressed files are fetched from this
same Pages site as Linux and its applications need them. No image server, Node backend,
local ISO selection or saved installation is required. Everything uses relative paths,
including on project Pages at `/VM/`.

The compressed filesystem totals about **72 MiB**, and boot can read many of its
objects. The guest is configured with **256 MB RAM** plus emulator/browser overhead.
It uses your computer's CPU, not a cloud CPU. OpenRC skips `udev-settle` (it stalls
badly on emulated hardware), 9p uses a larger `msize`, and the session tries a
**16:9** framebuffer (1280×720, then 1024×576) before starting X. Cold boot still
needs the kernel and X; allow a minute or more on a slow device. Browser-managed
HTTP caches may still use some local storage; “no ISO to save” is not a promise of
zero disk, RAM or network use.

Guest changes live in memory. Closing or powering off loses them. **Save session here**
is disabled for this new filesystem profile until its restore path is verified; the
existing small disk-image demos still support the bounded, explicit snapshot feature.
The image deliberately omits unused GPU/LLVM payload and package documentation. It is
an exploration/demo environment, not a general-purpose install with reliable package
management.

### What the browser can — and cannot — do

Dillo supports basic HTML, images and HTTPS. **It does not implement JavaScript.**
Many modern websites, streaming video services and web applications will not work.
A current Firefox cannot fit in this 32-bit, 256 MB guest (and Mozilla ended normal
32-bit Linux Firefox builds). Do not present Dillo as an equivalent to Firefox or
Chrome.

**Internet is off by default.** The initial page is a local file, so a working browser
window does not prove internet access. To try websites:

1. Before launch, explicitly check **Try guest internet through the public relay** on
   the welcome card. It is unchecked by default. Or choose your own trusted relay in
   **Show setup → Machine → Network**.
2. Keep the recommended **VirtIO** adapter and boot. Changing networking requires
   powering off and booting again.
3. The guest requests an address automatically. Try a simple page in Dillo.

The public relay is an external community service, not provided or guaranteed by
GitHub Pages. It can be unavailable or rate-limited. It carries guest traffic: do not
send private data or sign into sensitive accounts through an untrusted relay. Pages
alone cannot run a WebSocket internet backend. The app does not quietly enable a
third-party relay on your behalf.

## Full-browser alternative: antiX 26.1 full (32-bit)

The catalogue also includes **antiX 26.1 386 full**, with **Firefox ESR** and the
IceWM/Fluxbox desktops according to the
[official antiX release announcement](https://antixlinux.com/antix-26-1-released/).
Choose **full**, not core: core has no graphical desktop/browser. The official
[download folder](https://sourceforge.net/projects/antix-linux/files/Final/antiX-26.1/)
contains checksums and signatures; the 32-bit full ISO is about 2.3 GB.

This is a heavier **experimental catalogue candidate, not a bundled or boot-verified
system**. Its mirror must prove CORS and exact byte-range support before this app can
stream it. A download landing page is not a streaming image host. If the probe fails,
streaming-only refuses the image rather than downloading a giant ISO.

Do not assume any 32-bit Firefox package still has current upstream security support.
Mozilla ended regular official 32-bit x86 Linux builds after Firefox 144, with ESR 140
updates promised until *at least September 2026*. Check your distribution's current
maintenance policy rather than treating that past date as a present guarantee.
[1](https://blog.mozilla.org/futurereleases/2025/09/05/firefox-32-bit-linux-support-to-end-in-2026/)

For modern web apps, account sign-ins and a computer with permanent storage, the better
choice is **current 64-bit Linux Mint with Firefox on a persistent remote VM**. Its
storage and CPU belong to the server; your device only displays the screen. v86 cannot
execute 64-bit kernels, and static Pages cannot host that remote machine. See
[REMOTE-MINT.md](REMOTE-MINT.md). This repository supplies instructions, not an already
provisioned remote server.

## Rebuilding, provenance, licenses and corresponding source

The prepared guest lives in `assets/images/alpine-browser/`:

- `fs.json`: the v86 filesystem index, including `/boot`, Dillo and welcome pages.
- `rootfs/*.bin.zst`: content-addressed, compressed file objects loaded on demand.
- `manifest.json`: Alpine/kernel versions, the exact APK package database and source URL.
- `SHA256SUMS`: checksums of the index, manifest and every compressed file.

The checked-in recipe is `tools/linux-browser/Dockerfile`, with the guest configuration
and local pages under `tools/linux-browser/guest/`. The cloud preparation workflow runs
Docker on GitHub's runner, not on the visitor's computer. APK signatures verify the
packages. The v86 filesystem converters are fetched at a pinned upstream commit recorded
in the manifest. The build refuses more than 90 MiB or 4,500 compressed guest files;
the test suite also enforces a recursive 110 MiB total vendored-asset budget.

The guest contains GPL/LGPL license text in `/opt/webvm/licenses/`. Alpine packages
retain their individual licenses; this application's MIT license does **not** relicense
the Linux kernel, Dillo or other guest software.

**Corresponding source is available as a release download, outside Git and the Pages
payload.** Open the `sourceUrl` in `manifest.json`. This archive contains exact aports
recipes/patches/configuration at the APK-recorded commits, checksum-verified upstream
source archives for the distributed packages (including their license notices), package
provenance and the WebVM
build/configuration files. It is not just a moving upstream link. Source collection must
succeed before the workflow publishes guest assets. Large source archives and rootfs
exports never enter the Git working tree's deliverable patch.

On a separate Linux build host with Docker, `gh`, Python, `zstandard`, `tar` and `zstd`,
run `bash tools/linux-browser/build.sh`. This intentionally uses external Docker/Alpine
mirrors and substantial temporary build space. Rebuilding is **not required to use the
already prepared Pages desktop**.


### Small guest-configuration fixes

`tools/reconfigure-linux-browser.py` updates the checked-in guest text/configuration
files in the already prepared filesystem, removes unreferenced objects, and refreshes
the index, manifest, catalogue size and checksums. It requires Python `zstandard` and
never changes the packaged kernel/browser binaries. `guestConfigSourceUrl` in the
manifest points at the current WebVM-owned configuration, separately from the exact
third-party source archive. This avoids re-downloading the large source bundle for a
small launcher/help-page fix.

The launcher uses `xinit` directly to avoid `startx`/xauth bootstrap stalls on the 9p
root. It enables **local loopback** for Dillo's local file helper; this does not enable
guest internet or a third-party relay. These paths are covered by genuine guest boots
and the browser smoke test, including visible browser pixels and local-page navigation.

The cloud image-preparation workflow is now **manual only**. Run it explicitly on
`arena/ad819641-vm` if packaged software needs rebuilding; review and test its asset
commit before merging to `main`. It is not an automatic security-update service.

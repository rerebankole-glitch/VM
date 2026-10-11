# Which distributions work, and why

## The one rule

**Use a 32-bit (i386 / x86) image, from a release that still had one.**

v86 emulates a 32-bit x86 CPU: Pentium-4-class instructions including SSE3 and PAE paging,
but **no 64-bit long mode** and no second core. An `amd64`/`x86_64` kernel stops at the very
first instruction, so a modern 64-bit ISO can never boot — no setting will change that.

The second catch is timing: between 2019 and 2024 the desktop distributions stopped
publishing 32-bit images. The newest releases that still exist in 32-bit are:

| Distribution | Last 32-bit release | Notes |
| --- | --- | --- |
| Ubuntu / Lubuntu / Xubuntu | **18.04.5 LTS (i386)** | Ubuntu dropped i386 desktop images after 18.04 |
| Linux Mint | **19.3 “Tricia”** | Mint 20 (2020) and later are 64-bit only |
| MX Linux | **19.4 (386)** | MX 21 and later are 64-bit only |
| antiX | **23.2 (386)** | antiX 26 is x64 only |
| Debian | **12 “bookworm” i386** | Debian 13 keeps i386 only as a partial architecture |
| Alpine Linux | still ships `x86` | console-first, very light |
| Tiny Core Linux | still ships `x86` | 17 MB Core image, ideal for emulation |
| Arch Linux 32 | rolling, maintained | community i686 port |

Everything in the table above is selectable from the interface, with download links, and the
catalogue lives in `app/catalog.js` if you want to add your own.

## What to expect, by system

### Built-in images (nothing to download)

* **Tiny Linux** — a Buildroot image that boots to a root shell in a few seconds. Use it to
  confirm keyboard/mouse capture, networking and settings before downloading gigabytes.
* **KolibriOS** — a complete graphical OS in 1.44 MB. Boots in seconds, has windows, a text
  editor, games and a menu bar. The best demonstration of what the emulator can do.
* **FreeDOS 7.22** — a 720 KB floppy that boots instantly and runs DOS programs.

### Live desktops (MX, Lubuntu, Mint, Debian, antiX)

These are full Linux systems. Expect:

| Phase | Rough time (desktop host) |
| --- | --- |
| ISOLINUX menu | a few seconds |
| Kernel + initramfs | 1–5 minutes |
| Discovering and mounting the live filesystem | 2–10 minutes |
| Desktop appears | 5–40 minutes total |

Once booted, the desktop is usable but slow (opening a file manager takes seconds). Good for
looking around, checking that your ISO works, running small tools, or testing a remaster.
Not good for compiling software.

Practical advice:

* **Give it memory.** 512 MB is the recommended value for the live desktops; 256 MB works for
  antiX and Tiny Core.
* **Prefer Xfce/LXDE/IceWM images.** Cinnamon, GNOME and KDE are far heavier.
* **Let it finish.** A black screen or a blinking cursor for several minutes is normal.
* **Check the log panel.** If the CPU counter stops moving, the guest is stuck or waiting.
* If graphics misbehave, at the ISOLINUX menu press <kbd>Tab</kbd> (or <kbd>E</kbd>), append
  ` nomodeset` to the kernel line, and press <kbd>Enter</kbd>. Adding ` quiet` (or removing
  `splash`) shows boot messages, which is more informative than a logo.
* For text-mode rescue options every ISO also has entries like *Safe mode* or
  *Install (text mode)*, which boot much faster.

### Lightweight Linux

* **Tiny Core** loads itself into RAM: the Core ISO is 17 MB, CorePlus adds a small desktop.
  Under a minute to a working system.
* **Alpine** boots to a root prompt quickly. `setup-alpine` installs it to the attached hard
  disk; `apk add` works if you enable a network backend.
* **Arch Linux 32** boots the standard Arch ISO; use `archinstall` for a guided install.

## Installing a guest onto a persistent disk

The interface has an optional hard disk under **Hardware → Hard disk**:

1. Choose **Create an empty disk in RAM** (256 MB–2 GB).
2. Boot the installer ISO and install onto `/dev/sda` (the emulated IDE disk).
3. After the install, press **Download disk image** to save `vm-disk.img`.
4. Next session: **Hard disk → Use a disk image file**, pick `vm-disk.img`, set **Boot order**
   to *Hard disk → CD-ROM → floppy*, and boot.

The disk is held in RAM while the machine runs, so a 2 GB installation needs roughly 2 GB of
free memory plus the guest's RAM. 512 MB–1 GB disks are the comfortable range.

## Guest networking

| Backend | What you get |
| --- | --- |
| **No network card** | Default. Nothing leaves the tab; fastest. |
| **In-browser network** | v86's built-in LAN: DHCP, DNS and connections between tabs of this page. Still no internet. |
| **Public relay** (`wss://relay.widgetry.org/`) | Real internet access through a shared community proxy, with a compatible NIC. Expect slowness during peak use. |
| **Custom relay** | Point at your own [wsproxy](https://github.com/copy/v86/blob/master/docs/networking.md) instance or a fetch/WISP CORS proxy. Best performance and privacy. |

Pick the **NE2000** card for DOS and older Linux (the drivers are built in), **VirtIO** for
modern Linux guests. Inside most live systems the card is configured automatically by DHCP;
in the built-in Tiny Linux image run `ip link set eth0 up` and `udhcpc -i eth0`.

## Troubleshooting boots

| Symptom | Likely cause and fix |
| --- | --- |
| `This kernel requires an x86-64 CPU` | You picked a 64-bit ISO. Use the 32-bit release listed above. |
| Stuck at `Booting from DVD/CD...` | The ISO is not bootable as a CD (some are USB-only hybrid images) or it is a 64-bit image. Try another release. |
| Black screen after the boot menu | Add ` nomodeset` to the kernel line, or choose a safe/text-mode boot entry. |
| `Kernel panic – not syncing: VFS: Unable to mount root fs` | The live filesystem could not be found; the ISO is probably corrupt or partially downloaded. Verify its checksum. |
| Desktop never appears, CPU counter still rising | Very slow, still working. Wait longer, or switch to a lighter flavour. |
| Guest freezes after the desktop appears | Increase memory, or lower the screen resolution inside the guest (1024×768 instead of 1280×1024). |
| Keyboard does nothing | Hover the mouse **over the screen area** — input is only captured there. |
| Mouse jumps wildly | Click the screen to lock the pointer (relative mouse), press <kbd>Esc</kbd> to release. |

## Adding your own operating system

Edit `app/catalog.js` and append an entry. Two shapes are supported:

```js
// 1. Something you host or link to
{
    id: "my-distro",
    name: "My Distro", version: "1.0 (i386)", family: "Debian", desktop: "Xfce",
    arch: "i386", status: "works",      // "instant" | "works" | "tricky"
    summary: "One-line description shown on the card.",
    sizeBytes: 700_000_000,
    device: "cdrom",                    // "cdrom" | "fda" | "hda"
    ramMB: 256, vgaMB: 8,
    notes: ["Boot tip one.", "Boot tip two."],
    links: [{ label: "Download", url: "https://example.org/my.iso", kind: "direct" }],
}

// 2. An image that ships in this repository (status: "instant")
{
    // …
    status: "instant",
    bundled: { path: "assets/images/my.img", fileName: "my.img" },
}
```

`npm test` verifies that bundled paths exist with the recorded size, that every entry has
links, and that nothing claims to be 64-bit.

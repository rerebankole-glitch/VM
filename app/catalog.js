/**
 * The operating-system catalogue.
 *
 * Everything here is data, not code: to add your own OS, append an entry to
 * CATALOG (or UNSUPPORTED) and give it either a `bundled` image that ships in
 * assets/images/ or `links` that point at an ISO the user downloads and opens.
 *
 * `status`:
 *   "instant"  — built in, no ISO to save; the Linux desktop still needs boot time
 *   "works"    — 32-bit (i386) release that boots in v86, bring the ISO
 *   "tricky"   — 32-bit but heavy: expect a slow boot and a slow desktop
 *   "blocked"  — 64-bit only: cannot run, v86 has no 64-bit long mode
 */

/** @typedef {"instant"|"works"|"tricky"|"blocked"} OsStatus */

/** Casper live ISOs (Ubuntu, Lubuntu, Mint 19). Used to boot the kernel directly. */
export const CASPER_LIVE = {
    kernel: ["casper/vmlinuz", "casper/vmlinuz.efi", "casper/vmlinuz.32"],
    initrd: ["casper/initrd", "casper/initrd.lz", "casper/initrd.gz", "casper/initrd.img"],
    cmdline: "boot=casper ignore_uuid noprompt noeject nomodeset vga=791 noapic nolapic acpi=off pci=nomsi nosplash --- console=tty0 console=ttyS0,115200 tsc=reliable random.trust_cpu=on mitigations=off",
};

/** Debian live-boot (MX, Debian live). */
export const LIVEBOOT_LIVE = {
    kernel: ["live/vmlinuz", "live/vmlinuz1", "live/vmlinuz2"],
    initrd: ["live/initrd", "live/initrd.img", "live/initrd.gz", "live/initrd1"],
    cmdline: "boot=live components ignore_uuid noeject nomodeset vga=791 noapic nolapic acpi=off nosplash --- console=tty0 console=ttyS0,115200 tsc=reliable random.trust_cpu=on mitigations=off",
};

/** Named images the optional Node host may relay (never an open proxy). */
export const RELAY_IDS = ["ubuntu-18.04.5-i386", "mint-19.3-xfce-32", "lubuntu-18.04.5-i386"];

export const CATALOG = [
    {
        id: "alpine-browser",
        name: "Alpine Linux",
        version: "3.23 · widescreen desktop",
        family: "Linux",
        desktop: "Fluxbox + Dillo browser",
        browser: "Dillo",
        arch: "i386",
        status: "instant",
        summary: "A real widescreen Linux desktop with a graphical browser already installed. Small files load on demand — no large ISO to save.",
        sizeBytes: 75_760_677,
        device: "filesystem",
        ramMB: 256,
        vgaMB: 8,
        nicType: "virtio",
        bundled: { path: "assets/images/alpine-browser/fs.json", fileName: "fs.json" },
        filesystem: {
            baseurl: "assets/images/alpine-browser/rootfs/",
            cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose,msize=32768,version=9p2000.L modules=virtio_pci tsc=reliable random.trust_cpu=on mitigations=off nowatchdog nmi_watchdog=0 vga=0x344 video=vesafb:ypan,vremap:8 console=tty0 console=ttyS0,115200",
        },
        notes: [
            "Dillo opens a local welcome page automatically. Right-click the desktop for the browser or a terminal.",
            "Dillo supports basic pages and HTTPS, not JavaScript, streaming video or modern web apps. It is not a Firefox replacement — a current Firefox cannot fit in this 32-bit 256 MB guest.",
            "Internet is off by default. Before booting, choose Machine → Network → your trusted relay, or opt into the third-party public relay.",
            "The guest uses 256 MB RAM plus emulator overhead. OpenRC skips udev-settle and tries a 16:9 framebuffer (1280×720) before starting X.",
            "Guest changes are temporary. Browser-session saves are not yet supported for this demand-loaded filesystem.",
        ],
        links: [],
    },
    /* ------------------------------------------------------------------ *
     * Instant demos — small images that live in this repository
     * ------------------------------------------------------------------ */
    {
        id: "tiny-linux",
        name: "Tiny Linux",
        version: "Buildroot (v86 test image)",
        family: "Linux",
        desktop: "Console",
        arch: "i386",
        status: "instant",
        summary: "A 5 MB Linux that boots to a root shell in a few seconds. The best way to prove the VM works.",
        sizeBytes: 5_666_816,
        device: "cdrom",
        ramMB: 64,
        vgaMB: 4,
        bundled: { path: "assets/images/tiny-linux.iso", fileName: "tiny-linux.iso" },
        notes: [
            "The bundled image opens a shell (look for `/root%`). Try `uname -a`, `ls /`, `cat /proc/cpuinfo`.",
            "Network works with the NE2000 card: `ip link set eth0 up` + `udhcpc -i eth0`.",
            "Booting takes ~10 seconds — good for testing settings and keyboard/mouse capture.",
        ],
        links: [],
    },
    {
        id: "kolibrios",
        name: "KolibriOS",
        version: "0.7.7.0",
        family: "Independent",
        desktop: "Kolibri GUI",
        arch: "i386",
        status: "instant",
        summary: "A complete graphical OS that fits on one 1.44 MB floppy. Boots in seconds, writes text, plays games.",
        sizeBytes: 1_474_560,
        device: "fda",
        ramMB: 32,
        vgaMB: 4,
        bundled: { path: "assets/images/kolibri.img", fileName: "kolibri.img" },
        notes: [
            "Floppy image: it is attached as a 1.44 MB diskette and booted directly.",
            "Try the task bar at the bottom: text editor, games, image viewer, even a Tetris clone.",
            "Interesting because a whole modern GUI OS runs inside ~1 MB of emulated memory.",
        ],
        links: [{ label: "kolibrios.org", url: "https://kolibrios.org/en/", kind: "page" }],
    },
    {
        id: "freedos",
        name: "FreeDOS",
        version: "7.22",
        family: "DOS",
        desktop: "DOS prompt",
        arch: "i386",
        status: "instant",
        summary: "The classic DOS environment on a 720 KB floppy. Boots instantly and is a good breakage test.",
        sizeBytes: 737_280,
        device: "fda",
        ramMB: 32,
        vgaMB: 4,
        bundled: { path: "assets/images/freedos.img", fileName: "freedos.img" },
        notes: [
            "Type `help` for the built-in commands, `ver` for the version.",
            "Good for running old DOS games and programs inside the browser.",
        ],
        links: [{ label: "freedos.org", url: "https://www.freedos.org/", kind: "page" }],
    },

    /* ------------------------------------------------------------------ *
     * Ubuntu + Mint — first-class streamed live desktops
     * ------------------------------------------------------------------ */
    {
        id: "ubuntu-18.04.5-i386",
        name: "Ubuntu",
        version: "18.04.5 LTS (i386)",
        family: "Ubuntu",
        desktop: "GNOME Flashback / Unity",
        arch: "i386",
        status: "tricky",
        legacy: true,
        summary: "The last 32-bit Ubuntu Desktop. Streamed live ISO; the kernel is pulled out of the disc so boot skips ISOLINUX.",
        sizeBytes: 1_900_000_000,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        nicType: "virtio",
        bootOrder: "cd",
        acpi: false,
        live: CASPER_LIVE,
        notes: [
            "Stream `ubuntu-18.04.5-desktop-i386.iso` — not amd64. Ubuntu 20.04+ cannot boot here.",
            "18.04 is out of standard support. Use it for experiments, not private accounts.",
            "The emulator reads casper/vmlinuz + initrd with Range requests and boots that kernel with nomodeset.",
            "GNOME/Unity is heavy in v86. If the desktop never appears, try Lubuntu 18.04.5 (same Ubuntu base, LXDE).",
            "Expect many minutes. The serial lines in the activity log are kernel messages, not a freeze.",
        ],
        links: [
            {
                label: "ubuntu-18.04.5-desktop-i386.iso (old-releases.ubuntu.com)",
                url: "https://old-releases.ubuntu.com/releases/bionic/ubuntu-18.04.5-desktop-i386.iso",
                kind: "direct",
            },
            {
                label: "ubuntu-18.04.5-desktop-i386.iso (Internet Archive)",
                url: "https://archive.org/download/ubuntu-18.04.5-desktop-i386/ubuntu-18.04.5-desktop-i386.iso",
                kind: "direct",
            },
            { label: "All 18.04.5 images (official old-releases)", url: "https://old-releases.ubuntu.com/releases/bionic/", kind: "page" },
        ],
    },
    {
        id: "mint-19.3-xfce-32",
        name: "Linux Mint",
        version: "19.3 “Tricia” Xfce (32-bit)",
        family: "Ubuntu",
        desktop: "Xfce",
        arch: "i386",
        status: "tricky",
        summary: "Legacy, unsupported Mint for experiments only. Xfce is lighter than Cinnamon. Direct kernel boot from the live ISO.",
        legacy: true,
        sizeBytes: 1_973_420_032,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        nicType: "virtio",
        bootOrder: "cd",
        acpi: false,
        live: CASPER_LIVE,
        notes: [
            "Stream `linuxmint-19.3-xfce-32bit.iso` from a verified host — no ISO file to save locally.",
            "Mint 19.3 is out of security support. Do not use it for private accounts or everyday computing.",
            "Mint 20 and later are 64-bit only; 19.3 is the newest Mint that can run in an x86 emulator.",
            "The emulator extracts casper/vmlinuz + initrd and boots with nomodeset, skipping the CD menu.",
            "Cinnamon 32-bit exists too but is far heavier — avoid it on emulated hardware.",
        ],
        links: [
            {
                label: "linuxmint-19.3-xfce-32bit.iso (mirror.yandex.ru)",
                url: "https://mirror.yandex.ru/linuxmint/stable/19.3/linuxmint-19.3-xfce-32bit.iso",
                kind: "direct",
            },
            {
                label: "linuxmint-19.3-xfce-32bit.iso (mirror.ihost.md)",
                url: "https://mirror.ihost.md/linuxmint/iso/stable/19.3/linuxmint-19.3-xfce-32bit.iso",
                kind: "direct",
            },
            { label: "All Mint releases (official)", url: "https://linuxmint.com/download_all.php", kind: "page" },
        ],
    },
    {
        id: "lubuntu-18.04.5-i386",
        name: "Lubuntu",
        version: "18.04.5 LTS (i386)",
        family: "Ubuntu",
        desktop: "LXDE",
        arch: "i386",
        status: "tricky",
        legacy: true,
        summary: "The last 32-bit Lubuntu. Lightweight LXDE on Ubuntu 18.04 — the friendliest Ubuntu-family desktop for this emulator.",
        sizeBytes: 1_100_000_000,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        nicType: "virtio",
        bootOrder: "cd",
        acpi: false,
        live: CASPER_LIVE,
        notes: [
            "Grab the file ending in `-desktop-i386.iso` (NOT amd64).",
            "18.04 is out of standard support. Experiments only, not private accounts.",
            "Direct kernel boot reads casper/vmlinuz from the ISO; LXDE is much lighter than Ubuntu GNOME or Mint Cinnamon.",
            "Add ` nomodeset` after pressing TAB on the boot entry if you fall back to the CD menu.",
        ],
        links: [
            {
                label: "lubuntu-18.04.5-desktop-i386.iso (Internet Archive)",
                url: "https://archive.org/download/lubuntu-18.04.5-desktop-i386/lubuntu-18.04.5-desktop-i386.iso",
                kind: "direct",
            },
            {
                label: "Lubuntu 18.04 collection (all ISOs)",
                url: "https://archive.org/details/Lubuntu_18.04",
                kind: "page",
            },
            { label: "lubuntu.me", url: "https://lubuntu.me/", kind: "page" },
        ],
    },

    /* ------------------------------------------------------------------ *
     * Other 32-bit Linux desktops
     * ------------------------------------------------------------------ */
    {
        id: "mx-19.4-386",
        name: "MX Linux",
        version: "19.4 (386)",
        family: "Debian",
        desktop: "Xfce",
        arch: "i386",
        status: "tricky",
        summary: "The classic MX desktop. 19.4 is the last 32-bit MX release — MX 21 and newer are 64-bit only and cannot boot here.",
        sizeBytes: 1_700_000_000,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        nicType: "virtio",
        bootOrder: "cd",
        acpi: false,
        live: LIVEBOOT_LIVE,
        notes: [
            "Pick the file named MX-19.4_386.iso. The 64-bit one (x64) will not boot.",
            "The emulator tries to boot live/vmlinuz directly; otherwise press ENTER at the ISOLINUX menu.",
            "If the boot hangs at a black screen, re-select the entry, press TAB and append ` nomodeset`.",
            "4.19 kernel + PAE works on v86; the desktop is slow but usable for poking around.",
        ],
        links: [
            {
                label: "MX-19.4_386.iso (SourceForge, official)",
                url: "https://sourceforge.net/projects/mx-linux/files/Old/MX-19.4/MX-19.4_386.iso/download",
                kind: "direct",
            },
            {
                label: "Browse the MX-19.4 folder",
                url: "https://sourceforge.net/projects/mx-linux/files/Old/MX-19.4/",
                kind: "page",
            },
            { label: "mxlinux.org downloads", url: "https://mxlinux.org/download-links/", kind: "page" },
        ],
    },

    /* ------------------------------------------------------------------ *
     * Other genuinely 32-bit Linuxes that work well
     * ------------------------------------------------------------------ */
    {
        id: "antix-26.1-386",
        name: "antiX",
        version: "26.1 (386 full)",
        family: "Debian",
        desktop: "IceWM / Fluxbox",
        browser: "Firefox ESR",
        arch: "i386",
        status: "tricky",
        summary: "Full desktop with Firefox ESR included. A heavier alternative to the built-in Dillo desktop; this release is not boot-verified here.",
        sizeBytes: 2_300_000_000,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        nicType: "virtio",
        notes: [
            "antiX's official 26.1 release includes Firefox ESR in the full edition, alongside IceWM and Fluxbox. Core has no graphical browser.",
            "Choose antiX-26.1_386-full.iso, not x64. Its ISO is about 2.3 GB: stream only from a verified CORS/Range host.",
            "This is an experimental catalogue option, not a bundled or boot-tested guest. The emulator may be too slow for Firefox.",
            "Do not assume a 32-bit Firefox build has current security support. For sensitive accounts and modern web apps, use a supported 64-bit desktop remotely.",
        ],
        links: [
            { label: "antiX-26.1_386-full.iso (official SourceForge)", url: "https://sourceforge.net/projects/antix-linux/files/Final/antiX-26.1/antiX-26.1_386-full.iso/download", kind: "direct" },
            { label: "Official release: included software", url: "https://antixlinux.com/antix-26-1-released/", kind: "page" },
            { label: "Checksums and signatures", url: "https://sourceforge.net/projects/antix-linux/files/Final/antiX-26.1/", kind: "page" },
        ],
    },
    {
        id: "antix-23.2-386",
        name: "antiX",
        version: "23.2 (386 full)",
        family: "Debian",
        desktop: "IceWM / Fluxbox",
        arch: "i386",
        status: "works",
        summary: "Older antiX full desktop with Firefox ESR included. Prefer the built-in Alpine browser demo or explore the newer antiX 26.1 full edition.",
        browser: "Firefox ESR (older image)",
        sizeBytes: 1_700_000_000,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        notes: [
            "Debian 12 based, sysVinit (no systemd) — it starts services much faster than Ubuntu.",
            "Choose the 386 full ISO; runit variants live in a sub-folder.",
            "SHA-256: d5df9986e95bc707345779c833b3fc7aee364d58addae07ee19292a162af159b",
        ],
        links: [
            {
                label: "antiX-23.2_386-full.iso (SourceForge, official)",
                url: "https://sourceforge.net/projects/antix-linux/files/Final/antiX-23.2/antiX-23.2_386-full.iso/download",
                kind: "direct",
            },
            { label: "antixlinux.com", url: "https://antixlinux.com/", kind: "page" },
        ],
    },
    {
        id: "debian-12-i386-live",
        name: "Debian",
        version: "12 “bookworm” Live (i386, Xfce)",
        family: "Debian",
        desktop: "Xfce",
        arch: "i386",
        status: "tricky",
        summary: "The real Debian, with a long-lived i386 port. A solid choice if you want a full desktop that is still security-supported.",
        sizeBytes: 2_900_000_000,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        nicType: "virtio",
        bootOrder: "cd",
        acpi: false,
        live: LIVEBOOT_LIVE,
        notes: [
            "Open the i386 iso-hybrid folder and take the Xfce or LXDE image (avoid GNOME — too heavy).",
            "For a small download use `debian-12.*-i386-netinst.iso` instead and install over the emulated network.",
            "Debian's i386 images are a partial architecture from Debian 13 onwards, so 12 is the easy path.",
        ],
        links: [
            {
                label: "i386 live images (official)",
                url: "https://cdimage.debian.org/debian-cd/current-live/i386/iso-hybrid/",
                kind: "page",
            },
            { label: "debian.org/CD/live", url: "https://www.debian.org/CD/live/", kind: "page" },
        ],
    },
    {
        id: "tinycore-x86",
        name: "Tiny Core Linux",
        version: "Core / CorePlus (x86)",
        family: "Independent",
        desktop: "FLTK/FLWM",
        arch: "i386",
        status: "works",
        summary: "17 MB Core image with an optional tiny graphical desktop. If something is going to feel fast in an emulator, it is this.",
        sizeBytes: 17_000_000,
        device: "cdrom",
        ramMB: 256,
        vgaMB: 8,
        notes: [
            "TinyCore-current.iso (17 MB) drops to a shell; CorePlus-current.iso (~250 MB) adds a graphical desktop.",
            "Loads entirely into RAM, so disk access inside the VM is rare and the boot is quick.",
        ],
        links: [
            { label: "tinycorelinux.net downloads", url: "http://tinycorelinux.net/downloads.html", kind: "page" },
        ],
    },
    {
        id: "alpine-x86",
        name: "Alpine Linux",
        version: "latest-stable (x86)",
        family: "Independent",
        desktop: "Console (+ optional X)",
        arch: "i386",
        status: "works",
        summary: "Small, musl-based, boots to a root shell in under a minute. Ideal for scripting tests over the emulated network.",
        sizeBytes: 250_000_000,
        device: "cdrom",
        ramMB: 256,
        vgaMB: 8,
        notes: [
            "Take the `x86` (32-bit) images — `alpine-standard` or the smaller `alpine-virt`.",
            "Run `setup-alpine` to install to the emulated hard disk, or use it as a live system.",
            "Tons of packages: `apk add xorg-server` etc. Network needs the NE2000 card + a relay.",
        ],
        links: [
            { label: "x86 release folder (official)", url: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86/", kind: "page" },
            { label: "alpinelinux.org/downloads", url: "https://alpinelinux.org/downloads/", kind: "page" },
        ],
    },
    {
        id: "archlinux32",
        name: "Arch Linux 32",
        version: "i686",
        family: "Arch",
        desktop: "Your choice",
        arch: "i386",
        status: "works",
        summary: "The community i686 port of Arch Linux. Rolling release, still maintained for old 32-bit hardware.",
        sizeBytes: 800_000_000,
        device: "cdrom",
        ramMB: 512,
        vgaMB: 8,
        notes: [
            "Boot the `i686` ISO from the download page; install with `archinstall` or by hand.",
            "v86's own documentation includes an Arch Linux 32 image recipe.",
        ],
        links: [
            { label: "archlinux32.org/download", url: "https://www.archlinux32.org/download/", kind: "page" },
        ],
    },
];

/**
 * Modern releases that will NOT boot in v86: the emulated CPU has no 64-bit
 * long mode, so any amd64/x86_64 kernel fails immediately. Shown in the UI as
 * `blocked` so nobody wastes an hour downloading the wrong ISO.
 */
export const UNSUPPORTED = [
    {
        id: "mx-23-amd64",
        name: "MX Linux 21 / 23 / 25",
        arch: "x86_64",
        status: "blocked",
        reason: "MX dropped 32-bit images after MX-19.4. Use MX 19.4 (386) instead.",
    },
    {
        id: "mint-21-amd64",
        name: "Linux Mint 20 / 21 / 22",
        arch: "x86_64",
        status: "blocked",
        reason: "Mint has been 64-bit only since Mint 20. Use Mint 19.3 Xfce (32-bit).",
    },
    {
        id: "ubuntu-20-amd64",
        name: "Ubuntu 20.04 / 22.04 / 24.04 / 25.04",
        arch: "x86_64",
        status: "blocked",
        reason: "Ubuntu stopped shipping i386 desktop images after 18.04. Use Ubuntu 18.04.5 (i386) or Lubuntu 18.04.5.",
    },
    {
        id: "lubuntu-20-amd64",
        name: "Lubuntu 20.04 / 22.04 / 24.04",
        arch: "x86_64",
        status: "blocked",
        reason: "Ubuntu stopped shipping i386 images after 18.04. Use Lubuntu 18.04.5 (i386).",
    },
    {
        id: "debian-13-amd64",
        name: "Debian 13 “trixie” (i386 installer)",
        arch: "x86_64",
        status: "blocked",
        reason: "i386 is no longer a full Debian release architecture. Use Debian 12 i386 images.",
    },
    {
        id: "generic-arm",
        name: "Raspberry Pi OS / any ARM image",
        arch: "arm",
        status: "blocked",
        reason: "v86 emulates x86 only. ARM images need an ARM emulator.",
    },
];

export const BURN_HINT = "64-bit (amd64/x86_64) ISOs cannot boot: v86 emulates a 32-bit x86 CPU with no long mode.";

/** @param {string} id */
export function getEntry(id) {
    return CATALOG.find((entry) => entry.id === id) || null;
}

/** Entries grouped for the OS picker. */
export function groupedCatalog() {
    return {
        instant: CATALOG.filter((entry) => entry.status === "instant"),
        bootable: CATALOG.filter((entry) => entry.status !== "instant"),
    };
}

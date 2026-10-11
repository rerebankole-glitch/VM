# 64-bit (long mode) in this app

## Short version

This Pages VM ships **32-bit v86**. A 64-bit CPU is possible only with the
separate [v86_64](https://github.com/portlandhodl/v86_64) wasm core. That core
is **not in git** (GitHub serves it from a release CDN). Drop the three files
listed in [assets/v86_64/README.md](../assets/v86_64/README.md) into
`assets/v86_64/`, then boot the built-in **64-bit CPU** floppy.

## Ubuntu and Mint

| Guest | In this app |
| --- | --- |
| Ubuntu 18.04.5 **i386** | Streamed live kernel (slow, legacy) |
| Mint 19.3 Xfce **32-bit** | Same |
| Ubuntu 20.04+ / 26.04 **amd64** | Not bundled. v86_64 has shown Ubuntu 26.04 GNOME with an ~6.5 GB ISO and **8 GB** RAM. This build’s memory picker tops out at 2 GB, and GitHub Pages cannot ship that ISO. |
| Mint 20+ **amd64** | Not tested on v86_64. Same size/RAM problem. Not listed as bootable. |

A 64-bit CPU does **not** mean current Ubuntu/Mint “just work” here.

## Built-in 64-bit demo

`assets/images/tiny64.img` is a 720 KB floppy assembled from
`tools/tiny64/boot.S`. It enters long mode and prints `WEBVM_X86_64_READY` on
the serial port. It is not Linux.

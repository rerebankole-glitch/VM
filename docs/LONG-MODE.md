# 64-bit (long mode) in this app

## Short version

This Pages VM ships **32-bit v86** for every existing guest. A second core,
[v86_64](https://github.com/portlandhodl/v86_64), is vendored in
`assets/v86_64/` and is used only for `x86_64` guests. Boot the built-in
**64-bit CPU** floppy to see long mode (serial token `WEBVM_X86_64_READY`).

## Ubuntu and Mint

| Guest | In this app |
| --- | --- |
| Ubuntu 18.04.5 **i386** | Streamed live kernel (slow, legacy) |
| Mint 19.3 Xfce **32-bit** | Same |
| Ubuntu 24.04+ **amd64** | Catalogue card **Ubuntu 24.04+ (amd64)**. You attach the ISO (From disk). Default 2 GB RAM; 4 GB+ uses `v86-mem64.wasm`. Not boot-verified here. |
| Mint 22 Xfce **amd64** | Same: bring the ISO. Prefer Xfce over Cinnamon. |

The ISO is still yours to attach. Git cannot hold a 6 GB Ubuntu image.

## Built-in 64-bit demo

`assets/images/tiny64.img` is a 720 KB floppy assembled from
`tools/tiny64/boot.S`. It enters long mode and prints `WEBVM_X86_64_READY` on
the serial port. It is not Linux.

# 64-bit emulator core (v86_64)

This folder holds the experimental [v86_64](https://github.com/portlandhodl/v86_64)
CPU: the same `V86` API as official v86, plus long mode.

| File | Role |
| --- | --- |
| `libv86.js` | JS wrapper |
| `v86.wasm` | 64-bit capable CPU |
| `v86-fallback.wasm` | interpreter fallback |
| `v86-mem64.wasm` | guest RAM above 3 GiB (wasm memory64) |
| `VERSION` | release tag these files came from |

Do **not** replace `assets/v86/`. That 32-bit core still runs Alpine, KolibriOS
and the legacy Ubuntu/Mint i386 ISOs. The app loads this folder only for
`x86_64` guests (the built-in **64-bit CPU** floppy).

Refresh from GitHub Releases:

```bash
npm run vendor:v86_64
```

## What this does *not* give you

- Not Ubuntu 24.04/26.04 or Mint 21/22. Those ISOs are several gigabytes and
  want 4–8 GB of guest RAM. They are not bundled and are not claimed to boot.
- Not Firefox. A 64-bit CPU is only the first requirement.

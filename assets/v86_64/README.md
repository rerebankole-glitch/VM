# 64-bit emulator core (not shipped)

Official [v86](https://github.com/copy/v86) is **32-bit only**. A 64-bit CPU
comes from the experimental fork
[portlandhodl/v86_64](https://github.com/portlandhodl/v86_64). Its wasm is
published as **GitHub Release assets**, not git files, so this folder is empty
until you add three files.

## What to drop here

From <https://github.com/portlandhodl/v86_64/releases/tag/latest>:

| File | Typical size |
| --- | --- |
| `libv86.js` | ~370 KB |
| `v86.wasm` | ~3 MB |
| `v86-fallback.wasm` | ~3 MB |

Optional: a one-line `VERSION` file (the vendor script writes the release tag).

On a computer that can download GitHub releases:

```bash
gh release download latest --repo portlandhodl/v86_64 \
  -p libv86.js -p v86.wasm -p v86-fallback.wasm \
  -D assets/v86_64
echo latest > assets/v86_64/VERSION
```

Or `npm run vendor:v86_64`. Then reload the page and start **64-bit CPU**.

Do **not** replace `assets/v86/` — that 32-bit core still runs Alpine, KolibriOS
and the legacy Ubuntu/Mint i386 ISOs.

## What this does *not* give you

- Not Ubuntu 24.04/26.04 or Mint 21/22. Those ISOs are several gigabytes and
  want 4–8 GB of guest RAM. They are not bundled and are not claimed to boot.
- Not Firefox. A 64-bit CPU is only the first requirement.

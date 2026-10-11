#!/usr/bin/env bash
# Assemble the long-mode demo floppy. GNU as/ld only — no NASM, no Rust.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/tools/tiny64/boot.S"
OUT="$ROOT/assets/images/tiny64.img"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

as --32 -o "$WORK/boot.o" "$SRC"
ld -m elf_i386 -Ttext 0x7C00 --oformat binary -o "$WORK/boot.bin" "$WORK/boot.o"

python3 - <<PY
from pathlib import Path
raw = Path("$WORK/boot.bin").read_bytes()
if len(raw) < 512:
    raise SystemExit(f"boot.bin too small: {len(raw)}")
if raw[510:512] != b"\x55\xaa":
    raise SystemExit("missing 0xAA55 boot signature")
if len(raw) > 16 * 512:
    raise SystemExit(f"boot.bin {len(raw)} exceeds the 16-sector load")
img = raw.ljust(737_280, b"\x00")  # 720 KiB floppy
Path("$OUT").write_bytes(img)
print(f"wrote {len(img)} bytes to $OUT (payload {len(raw)})")
PY

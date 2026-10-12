#!/usr/bin/env bash
# Vendor the experimental 64-bit v86 fork (portlandhodl/v86_64) into assets/v86_64/.
#
# Official copy/v86 has no long mode. This fork's wasm is published as GitHub
# Release assets (not git blobs), so a network that can follow GitHub's CDN
# is required — or drop the three files in by hand (see assets/v86_64/README.md).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/assets/v86_64"
REPO="${V86_64_REPO:-portlandhodl/v86_64}"
TAG="${V86_64_TAG:-latest}"

mkdir -p "$DEST"
FILES=(libv86.js v86.wasm v86-fallback.wasm v86-mem64.wasm)

if [[ "${1:-}" == "--from" ]]; then
    SOURCE="${2:?usage: vendor-v86_64.sh --from <dir-with-libv86.js-and-wasm>}"
    for f in "${FILES[@]}"; do
        [[ -f "$SOURCE/$f" ]] || { echo "missing $SOURCE/$f" >&2; exit 1; }
        cp "$SOURCE/$f" "$DEST/$f"
        printf '   %-22s %8s bytes\n' "$f" "$(wc -c < "$DEST/$f")"
    done
else
    echo "==> Downloading $REPO@$TAG release assets"
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT
    if ! gh release download "$TAG" --repo "$REPO" --dir "$WORK" \
            --pattern 'libv86.js' --pattern 'v86.wasm' --pattern 'v86-fallback.wasm'; then
        echo "Could not download release assets (GitHub CDN often blocked here)." >&2
        echo "On your computer:" >&2
        echo "  gh release download $TAG --repo $REPO -p libv86.js -p v86.wasm -p v86-fallback.wasm -D $DEST" >&2
        echo "Or download from https://github.com/$REPO/releases/tag/$TAG and drop the three files in $DEST" >&2
        exit 1
    fi
    for f in "${FILES[@]}"; do
        [[ -f "$WORK/$f" ]] || { echo "release did not contain $f" >&2; exit 1; }
        cp "$WORK/$f" "$DEST/$f"
        printf '   %-22s %8s bytes\n' "$f" "$(wc -c < "$DEST/$f")"
    done
fi

python3 - <<PY
from pathlib import Path
p = Path("$DEST/v86.wasm")
magic = p.read_bytes()[:4]
if magic != b"\x00asm":
    raise SystemExit(f"v86.wasm is not a WebAssembly module (got {magic!r})")
if p.stat().st_size < 1_000_000:
    raise SystemExit("v86.wasm is too small to be the 64-bit core")
PY

echo "$TAG" > "$DEST/VERSION"
# Keep the 32-bit BIOS; v86_64 uses the same SeaBIOS/VGA ROMs.
echo "==> Done. 64-bit core in $DEST"
echo "    Boot the built-in “64-bit CPU” floppy, or stream a 64-bit ISO."

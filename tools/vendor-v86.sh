#!/usr/bin/env bash
# Vendor the v86 browser build + BIOS/ROM images into assets/v86/.
#
# The app has no build step: everything it needs lives in assets/.
# Run this script (or `npm run vendor`) to refresh a pinned v86 version.
#
#   ./tools/vendor-v86.sh                 # refresh the pinned version
#   V86_VERSION=0.5.471 ./tools/vendor-v86.sh
#   ./tools/vendor-v86.sh --from /path/to/v86   # copy from a local v86 checkout
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/assets/v86"
V86_VERSION="${V86_VERSION:-pinned}"          # "pinned" = version recorded in assets/v86/VERSION
V86_GIT_REF="${V86_GIT_REF:-master}"          # used for BIOS files from the git repo

VENDOR_FILES=(
    "build/libv86.js:libv86.js"
    "build/v86.wasm:v86.wasm"
    "build/v86-fallback.wasm:v86-fallback.wasm"
    "LICENSE:LICENSE-v86.txt"
    "v86.d.ts:v86.d.ts"
)

FROM_LOCAL=""
if [[ "${1:-}" == "--from" ]]; then
    FROM_LOCAL="${2:?usage: vendor-v86.sh --from <v86-checkout-or-npm-package>}"
fi

mkdir -p "$DEST"

if [[ -n "$FROM_LOCAL" ]]; then
    SOURCE="$FROM_LOCAL"
    echo "==> Vendoring v86 from local path: $SOURCE"
else
    if [[ "$V86_VERSION" == "pinned" ]]; then
        V86_VERSION="$(cat "$DEST/VERSION" 2>/dev/null || echo 0.5.471)"
    fi
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT
    echo "==> Downloading v86@$V86_VERSION from the npm registry"
    (cd "$WORK" && npm pack "v86@$V86_VERSION" --silent >/dev/null && tar xzf ./*.tgz)
    SOURCE="$WORK/package"
fi

for entry in "${VENDOR_FILES[@]}"; do
    src="${entry%%:*}"
    dst="${entry##*:}"
    if [[ ! -f "$SOURCE/$src" ]]; then
        echo "   !! missing $src in $SOURCE" >&2
        exit 1
    fi
    cp "$SOURCE/$src" "$DEST/$dst"
    printf '   %-22s %8s bytes\n' "$dst" "$(stat -c%s "$DEST/$dst")"
done

# SeaBIOS + VGA BIOS: small LGPL roms, taken from the v86 git repository.
if [[ "${SKIP_BIOS:-0}" != "1" ]]; then
    WORK="${WORK:-$(mktemp -d)}"
    echo "==> Downloading BIOS roms from copy/v86@$V86_GIT_REF"
    curl -fsSL -o "$WORK/v86-src.tar.gz" \
        "https://codeload.github.com/copy/v86/tar.gz/refs/heads/$V86_GIT_REF"
    tar xzf "$WORK/v86-src.tar.gz" -C "$WORK" --strip-components=1 "v86-$V86_GIT_REF/bios"
    cp "$WORK/bios/seabios.bin"      "$DEST/seabios.bin"
    cp "$WORK/bios/vgabios.bin"      "$DEST/vgabios.bin"
    cp "$WORK/bios/COPYING.LESSER"   "$DEST/COPYING.LESSER"
    printf '   %-22s %8s bytes\n' "seabios.bin" "$(stat -c%s "$DEST/seabios.bin")"
    printf '   %-22s %8s bytes\n' "vgabios.bin" "$(stat -c%s "$DEST/vgabios.bin")"
fi

echo "$V86_VERSION" > "$DEST/VERSION"
echo "==> Done. Vendored build in $DEST"

#!/usr/bin/env bash
# Vendor the small "instant demo" boot images into assets/images/.
#
# These are the tiny images that the v86 project publishes for testing in
# copy/images (BSD-2-Clause project, GPL guest operating systems). They are
# small enough to live in a GitHub repository / GitHub Pages site, which makes
# the whole app work out of the box with no ISO download.
#
#   ./tools/fetch-demo-images.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/assets/images"
IMAGES_REF="${IMAGES_REF:-master}"

# upstream name -> local name
IMAGES=(
    "linux.iso:tiny-linux.iso"       # Buildroot Linux, boots to a root shell in seconds
    "freedos722.img:freedos.img"     # FreeDOS 7.22 floppy
    "kolibri.img:kolibri.img"        # KolibriOS: a complete GUI OS in 1.4 MB
)

mkdir -p "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Downloading https://github.com/copy/images ($IMAGES_REF)"
curl -fsSL -o "$WORK/images.tar.gz" \
    "https://codeload.github.com/copy/images/tar.gz/refs/heads/$IMAGES_REF"

for entry in "${IMAGES[@]}"; do
    src="${entry%%:*}"
    dst="${entry##*:}"
    tar xzf "$WORK/images.tar.gz" -C "$WORK" --strip-components=1 "images-$IMAGES_REF/$src"
    cp "$WORK/$src" "$DEST/$dst"
    printf '   %-18s %9s bytes\n' "$dst" "$(stat -c%s "$DEST/$dst")"
done

# Checksums so that the vendored files can be verified later (see tests/).
( cd "$DEST" && sha256sum tiny-linux.iso freedos.img kolibri.img > SHA256SUMS )
echo "==> Done. Demo images in $DEST"

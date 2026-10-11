#!/usr/bin/env bash
# Run on a Linux host with Docker, gh, Python and zstandard. Large intermediate
# files stay outside Git; only the bounded, compressed, demand-loaded guest is
# committed. GitHub Actions performs this build on behalf of low-storage users.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
OUT="$ROOT/assets/images/alpine-browser"
WORK=$(mktemp -d)
CONTAINER="webvm-browser-$$"
IMAGE="webvm-alpine-browser:local"
V86_COMMIT=94faf3d6b19ecabc53a4010aaa24252fa6a162e2
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
# A rebuild must not redistribute stale objects from a previous package version.
rm -rf "$OUT"
mkdir -p "$OUT" "$WORK/v86" "$ROOT/.cache/linux-browser"

for tool in fs2json.py copy-to-sha256.py; do
    gh api "repos/copy/v86/contents/tools/$tool?ref=$V86_COMMIT" --jq .content | base64 -d > "$WORK/v86/$tool"
done

# Keep the GPL/LGPL notices accessible inside the actual guest as well as online.
LICENSES="$ROOT/tools/linux-browser/guest/opt/webvm/licenses"
mkdir -p "$LICENSES"
for license in GPL-2.0-only GPL-3.0-or-later LGPL-2.1-or-later; do
    gh api "repos/spdx/license-list-data/contents/text/$license.txt" --jq .content | base64 -d > "$LICENSES/$license.txt"
done

docker build --platform linux/386 --tag "$IMAGE" tools/linux-browser
docker create --platform linux/386 --name "$CONTAINER" "$IMAGE"
docker export "$CONTAINER" --output "$WORK/rootfs.tar"
tar --delete -f "$WORK/rootfs.tar" .dockerenv
python3 "$WORK/v86/fs2json.py" --zstd --out "$OUT/fs.json" "$WORK/rootfs.tar"
mkdir -p "$OUT/rootfs"
python3 "$WORK/v86/copy-to-sha256.py" --zstd "$WORK/rootfs.tar" "$OUT/rootfs"

# Refuse to turn this small static application into a multi-GB image repository.
python3 - "$OUT" <<'PY'
import pathlib, sys
files = [p for p in pathlib.Path(sys.argv[1]).rglob('*') if p.is_file()]
size = sum(p.stat().st_size for p in files)
assert size <= 90 * 1024 * 1024, f'Guest is too large to vendor: {size} bytes'
assert len(files) <= 4500, f'Too many guest files: {len(files)}'
print(f'Compressed guest: {size} bytes in {len(files)} files')
PY

# These are exact source archives plus the Alpine recipes/patches for the
# copyleft programs distributed here, not merely links to moving upstream code.
python3 tools/linux-browser/collect-sources.py "$WORK/rootfs.tar" "$WORK/sources"
cp -r tools/linux-browser "$WORK/sources/webvm-build"
SOURCE_TAG="alpine-browser-sources-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
SOURCE_ARCHIVE="$ROOT/.cache/linux-browser/alpine-browser-sources.tar.zst"
tar --zstd -cf "$SOURCE_ARCHIVE" -C "$WORK/sources" .

python3 - "$WORK/rootfs.tar" "$OUT" "$V86_COMMIT" "$SOURCE_TAG" <<'PY'
import datetime, hashlib, json, pathlib, re, sys, tarfile
archive, dest, v86_commit, tag = sys.argv[1:]
out = pathlib.Path(dest)
with tarfile.open(archive) as t:
    def text(name):
        return t.extractfile('opt/webvm/provenance/' + name).read().decode().strip()
    metadata = dict(alpineVersion=text('alpine-version.txt'), kernelVersion=text('kernel-version.txt'),
                    packages=text('packages.txt').splitlines(), apkDatabase=text('apk-installed.txt'))
metadata.update(architecture='x86', browser='Dillo', builtAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                v86ToolsCommit=v86_commit,
                sourceUrl=f'https://github.com/rerebankole-glitch/VM/releases/download/{tag}/alpine-browser-sources.tar.zst')
metadata['compressedBytes'] = sum(p.stat().st_size for p in out.rglob('*') if p.is_file())
(out / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
catalog = pathlib.Path('app/catalog.js')
text = catalog.read_text()
text = re.sub(r'(id: "alpine-browser"[\s\S]*?sizeBytes:\s*)[\d_]+',
              lambda m: m.group(1) + f"{metadata['compressedBytes']:_}", text, count=1)
catalog.write_text(text)
files = sorted(p for p in out.rglob('*') if p.is_file())
(out / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(out).as_posix() + '\n' for p in files))
PY
printf '%s\n' "$SOURCE_TAG" > .cache/linux-browser/source-tag.txt
printf 'Prepared %s. Source archive: %s\n' "$OUT" "$SOURCE_ARCHIVE"

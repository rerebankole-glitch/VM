#!/usr/bin/env python3
"""Apply this repo's small guest config files without rebuilding package binaries.
Requires zstandard. Does not alter the signed packages or their source provenance.
Large, unneeded build/source files never enter Git.
"""
import hashlib
import json
import pathlib
import re
import time
import zstandard

root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'assets/images/alpine-browser'
index = json.loads((out / 'fs.json').read_text())
manifest = json.loads((out / 'manifest.json').read_text())
changes = []

for source in sorted((root / 'tools/linux-browser/guest').rglob('*')):
    if not source.is_file() or 'licenses' in source.parts:
        continue
    name = source.relative_to(root / 'tools/linux-browser/guest').as_posix()
    data = source.read_bytes()
    parts = name.split('/')
    nodes = index['fsroot']
    for part in parts[:-1]:
        nodes = next(node for node in nodes if node[0] == part)[6]
    node = next((node for node in nodes if node[0] == parts[-1]), None)
    old_size = node[1] if node else 0
    filename = hashlib.sha256(data).hexdigest()[:10] + '.bin.zst'
    if node and node[6] == filename:
        continue
    if node is None:
        node = [parts[-1], len(data), int(time.time()), 0x8000 | 0o644, 0, 0, filename]
        nodes.append(node)
    else:
        node[1], node[2], node[6] = len(data), int(time.time()), filename
    if name == 'root/.xinitrc':
        node[3] = 0x8000 | 0o755
    (out / 'rootfs' / filename).write_bytes(zstandard.ZstdCompressor(level=19).compress(data))
    index['size'] += len(data) - old_size
    changes.append('/' + name)

def regular_files(nodes):
    for node in nodes:
        if isinstance(node[6], list):
            yield from regular_files(node[6])
        elif node[3] & 0xf000 == 0x8000:
            yield node[6]

used = set(regular_files(index['fsroot']))
for file in (out / 'rootfs').iterdir():
    if file.name not in used:
        file.unlink()
(out / 'fs.json').write_text(json.dumps(index, separators=(',', ':')))
manifest['compressedBytes'] = (out / 'fs.json').stat().st_size + sum(p.stat().st_size for p in (out / 'rootfs').iterdir())
manifest['guestConfigSourceUrl'] = 'https://github.com/rerebankole-glitch/VM/tree/main/tools/linux-browser/guest'
manifest['guestConfigFiles'] = ['/' + p.relative_to(root / 'tools/linux-browser/guest').as_posix()
                              for p in sorted((root / 'tools/linux-browser/guest').rglob('*')) if p.is_file() and 'licenses' not in p.parts]
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
files = sorted(p for p in out.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
(out / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(out).as_posix() + '\n' for p in files))
catalog = root / 'app/catalog.js'
catalog.write_text(re.sub(r'(id: "alpine-browser"[\s\S]*?sizeBytes:\s*)[\d_]+',
                         lambda m: m.group(1) + f"{manifest['compressedBytes']:_}", catalog.read_text(), count=1))
print('Updated:', ', '.join(changes))
print('Compressed payload:', manifest['compressedBytes'])

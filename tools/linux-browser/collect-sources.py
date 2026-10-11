#!/usr/bin/env python3
"""Collect exact corresponding source for the guest's copyleft packages.

The signed APK database records each origin's aports commit. Preserve that
recipe directory (including local patches/configs), then use Alpine's own
abuild fetch/verify to download and checksum its upstream source archives.
Everything is prepared in a temporary directory, not in the VM repository.
"""
import json
import pathlib
import re
import subprocess
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive) as tar:
    database = tar.extractfile('opt/webvm/provenance/apk-installed.txt').read().decode()
packages = []
for block in database.split('\n\n'):
    fields = {}
    for line in block.splitlines():
        if len(line) > 2 and line[1] == ':' and line[0] not in fields:
            fields[line[0]] = line[2:]
    if 'P' in fields:
        packages.append(fields)
origins = sorted({(p.get('o', p['P']), p.get('c', '')) for p in packages
                  if re.search(r'(?:A?GPL|LGPL|MPL)', p.get('L', ''))})
(out / 'packages.json').write_text(json.dumps(packages, indent=2) + '\n')

repo = out.parent / 'aports'
subprocess.run(['git', 'clone', '--quiet', '--depth=1', '--filter=blob:none', '--no-checkout',
                'https://github.com/alpinelinux/aports.git', str(repo)], check=True)
recipes = []
for origin, commit in origins:
    if not re.fullmatch(r'[a-zA-Z0-9+_.-]+', origin) or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise RuntimeError(f'Missing source provenance: {origin} {commit!r}')
    subprocess.run(['git', '-C', str(repo), 'fetch', '--quiet', '--depth=1', 'origin', commit], check=True)
    location = None
    for section in ['main', 'community', 'testing']:
        candidate = f'{section}/{origin}'
        if subprocess.run(['git', '-C', str(repo), 'cat-file', '-e', f'{commit}:{candidate}/APKBUILD'],
                          stderr=subprocess.DEVNULL).returncode == 0:
            location = candidate
            break
    if location is None:
        raise RuntimeError(f'No source recipe for {origin} at {commit}')
    target = out / 'recipes' / origin
    target.mkdir(parents=True, exist_ok=True)
    data = subprocess.check_output(['git', '-C', str(repo), 'archive', commit, location])
    subprocess.run(['tar', '-xf', '-', '--strip-components=2', '-C', str(target)], input=data, check=True)
    recipes.append(dict(origin=origin, commit=commit, path=location))
(out / 'recipes.json').write_text(json.dumps(recipes, indent=2) + '\n')
(out / 'fetch.sh').write_text('''#!/bin/sh
set -eu
apk add --no-cache abuild
export SRCDEST=/sources/distfiles
export CARCH=x86
mkdir -p "$SRCDEST"
for recipe in /sources/recipes/*; do
    cd "$recipe"
    abuild -F fetch verify
done
''')
subprocess.run(['docker', 'run', '--rm', '-v', f'{out}:/sources', 'alpine:3.23',
                'sh', '/sources/fetch.sh'], check=True)
print(f'Collected and verified source for {len(recipes)} copyleft package origins.')

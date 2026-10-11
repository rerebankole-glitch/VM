# Demo boot images

These three small images ship with the site so that a visitor can boot a real
machine without downloading anything. They come from the v86 project's test
image repository ([copy/images](https://github.com/copy/images)) and are
unmodified:

| File | Size | Contents | Licence |
| --- | --- | --- | --- |
| `tiny-linux.iso` | 5,666,816 B | Buildroot Linux, boots to a root shell | GPL and other free licences (see the Buildroot output licences) |
| `freedos.img` | 737,280 B | FreeDOS 7.22 boot floppy | GPL |
| `kolibri.img` | 1,474,560 B | KolibriOS 0.7.7.0 boot floppy | GPL |

`SHA256SUMS` records their checksums; `npm test` verifies them, so a corrupted
or substituted file cannot slip into a deployment.

## Refreshing them

```bash
npm run vendor:images     # re-downloads from copy/images and rewrites SHA256SUMS
```

The script is `tools/fetch-demo-images.sh`. It renames `linux.iso` to
`tiny-linux.iso` and `freedos722.img` to `freedos.img`; if you change a name,
update `bundled.path` in `app/catalog.js` as well.

## Adding your own

Anything bootable that fits comfortably in a repository works: DOS floppies,
small Linux images, hobby operating systems. Add the file here, list it in
`SHA256SUMS` (`sha256sum <file> >> SHA256SUMS`) and create a catalogue entry with
`status: "instant"` and a matching `bundled` block.

Keep an eye on the total size: GitHub warns above 50 MB per file and rejects
above 100 MB, and every added megabyte is downloaded by every visitor.


## Included Alpine Linux browser desktop

`alpine-browser/` contains a prepared Alpine Linux 3.23 x86 filesystem with Fluxbox,
Dillo and a terminal. It is **not an ISO**: v86 loads its compressed objects from this
site. The compressed filesystem payload is about **72 MiB**; booting can read many
of its objects, so this is not a promise of zero network or browser-cache storage.
The visitor never needs to save an installer or multi-gigabyte disk image.

`alpine-browser/manifest.json` records kernel/package versions and the exact
corresponding-source release. Its own `SHA256SUMS` covers every deployed object.
The recursive asset budget is now 110 MiB, enforced by tests; source archives and
uncompressed rootfs exports stay outside Git. See [the Linux browser guide](../../docs/LINUX-BROWSER.md).

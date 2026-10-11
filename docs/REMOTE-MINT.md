# Linux Mint when your computer has little storage

There are **two different machines** people often call a “WebVM”. This project is a real
browser emulator, not a cloud computer. A Mint-looking wallpaper would not change that.

| | This project / streamed ISO | A persistent remote desktop |
| --- | --- | --- |
| CPU and RAM | Your browser, on your computer | A separate server |
| CPU architecture | v86: 32-bit x86, one emulated core | QEMU/KVM: 64-bit x86, hardware accelerated |
| Linux Mint | Legacy 19.3 Xfce **candidate**, unsupported; slow, not guaranteed to boot | A current supported 64-bit Mint release |
| Large ISO | On its host; only requested blocks are transferred | Downloaded on the server |
| Guest files | Temporary RAM unless you explicitly save a state/disk | A persistent virtual disk on the server |
| Your device's storage | Page/assets, possible browser caches, optional snapshots; no ISO file to save when streaming | Browser page/cache, not the OS installation |
| Backend required | No for static hosting; optional Node image relay | Yes, a continuously running VM + browser desktop gateway |

## What you can use now

* **Start desktop** boots the bundled 1.4 MB **KolibriOS** graphical desktop in a click.
  It is a genuine guest OS, **not Mint and not Linux**.
* **Linux terminal** boots the bundled small Linux system.
* **Explore Mint** explains the legacy/security limits before checking streaming sources.
  The app tries the Node host's named relay, then direct mirrors. It requires a real HTTP
  `206` response with an exposed, valid `Content-Range`. If that fails, it stops.
* **Stream URL** accepts your own CORS + Range-enabled image host. **Streaming only** is
  checked by default. A server that advertises ranges but sends the whole image is not
  accepted as a streaming source. Non-streaming RAM downloads are bounded at 512 MB even
  when streaming-only is explicitly turned off.

Streaming is not “no download”: bytes still cross the network and enter browser RAM. It
means you do not need to download and keep a multi-GB **ISO file** on your device. Caches
may consume some space. A running guest also needs RAM and emulator overhead; streaming
cannot offload its CPU or make it as fast as your physical PC.

### An image relay, without storing an ISO on either disk

Run the dependency-free Node host on a server that can reach the Mint mirrors:

```bash
npm start -- --host 0.0.0.0 --port 8080
```

Its default relay is pinned to the catalogue's **Mint 19.3 Xfce 32-bit** mirror paths.
To use an operator-controlled, trusted copy of that *same* legacy image:

```bash
MINT_ISO_URL="https://your-image-host.example/linuxmint-19.3-xfce-32bit.iso" npm start
# equivalently: npm start -- --mint-url https://your-image-host.example/linuxmint-19.3-xfce-32bit.iso
```

The relay endpoint is `api/images/mint-19.3-xfce-32.iso`, relative to this site's origin.
It forwards bounded byte ranges, never a full image, and does not cache the ISO to disk.
Only configured image IDs are exposed; clients cannot supply arbitrary upstream URLs.
No browser cookies or authorization headers are forwarded. Use a trusted image host:
range validation checks the transfer protocol, **not the authenticity or architecture of
an ISO**. Verify any image you rehost against its publisher's signed checksums.

A relay still needs outbound access to its configured host. GitHub Pages has no Node
backend, and an environment with restricted network access cannot fetch mirrors merely
because this code exists. On Pages, the app falls back to direct browser-readable mirrors
or lets you enter a suitable URL. It never silently substitutes another OS for Mint.

## For an actual everyday Mint computer: put the VM on a server

This needs a server you control, with persistent storage and permission to run a VM.
There is no free, permanent cloud computer hidden inside a static GitHub repository.
The minimum deployment is:

```text
browser ── HTTPS + authenticated WebSocket ── noVNC / websockify
                                                  │
                                             localhost VNC
                                                  │
                                             QEMU / KVM
                                                  │
                                      Mint + persistent qcow2 disk
```

Here is a concrete starting point for an **existing Debian/Ubuntu x86-64 server with
`/dev/kvm` available**. These commands are for that server, not the browser emulator and
not an instruction to install Mint on your low-storage laptop.

1. Install QEMU/KVM, noVNC and websockify on the server. Reserve enough server RAM and
   disk space for your chosen Mint edition and your files (for example 4 GB guest RAM and
   a 32 GB dynamically growing virtual disk). Confirm your account can access `/dev/kvm`.
2. On the **server**, get a currently supported 64-bit Mint ISO from the
   [official download page](https://linuxmint.com/download.php). Verify the ISO using
   [Mint's verification instructions](https://linuxmint-installation-guide.readthedocs.io/en/latest/verify.html).
   Do not use an unverified OS image from a random repository.
3. Create the virtual disk and run the installer:

```bash
sudo apt install qemu-system-x86 qemu-utils novnc websockify
mkdir -p "$HOME/mint-vm"
qemu-img create -f qcow2 "$HOME/mint-vm/mint.qcow2" 32G

# Set ISO to the verified file you downloaded ON THE SERVER.
ISO="$HOME/mint-vm/linuxmint-verified-64bit.iso"
qemu-system-x86_64 \
  -enable-kvm -machine q35 -cpu host -smp 2 -m 4096 \
  -drive file="$HOME/mint-vm/mint.qcow2",format=qcow2,if=virtio \
  -cdrom "$ISO" -boot order=d \
  -nic user,model=virtio-net-pci \
  -vga std -display none -vnc 127.0.0.1:1
```

4. In another **server** terminal, expose its loopback VNC display through noVNC:

```bash
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901
```

5. Put port 6080 behind an **authenticated HTTPS reverse proxy** on your domain, including
   WebSocket upgrade forwarding. Expose only that HTTPS entry point. Do **not** open the
   unauthenticated VNC or websockify ports to the public internet. Open your server's
   `/vnc.html` in the browser; browser-facing URLs must use that server's HTTPS origin,
   not your browser computer's `localhost`.
6. Install Mint onto the virtual disk through that desktop. After installation, shut down
   the guest, restart QEMU with `-boot order=c` and without `-cdrom`, and supervise both
   processes with systemd (or your hosting platform's process manager). Back up the disk
   while the guest is shut down, or use a consistent VM backup method.

The repository intentionally does not claim to provision or operate this remote service.
A host, security setup, persistent volume, and resources must exist first. Without KVM,
QEMU can emulate a 64-bit guest in software, but that is much slower and is not a good
substitute for a responsive daily-use computer.

## Saving a browser session is optional local storage

**Tools → Save session here** saves one snapshot in IndexedDB, after confirmation. It is
not a cloud backup. It is capped at 128 MB and checks available browser quota. It supports
built-in or verified streamed images without an extra hard disk; local file images and
installations use the existing **Download state / Load state file** path instead.

The welcome screen offers **Resume session** and **Delete saved session**. Resume checks
emulator version, memory/device settings and source metadata; streamed images must remain
available at the same size and must contain the same bytes. A size check alone cannot
verify image identity. The original image URL is still needed because unread streamed
blocks are not embedded in the snapshot. New work is temporary until you save again.

Private mode, eviction, a cleared site-data store, or a browser quota failure can make a
saved session unavailable. There is no autosave, and the app warns before closing a live
guest. Deleting the saved session frees its browser storage without deleting a running VM.

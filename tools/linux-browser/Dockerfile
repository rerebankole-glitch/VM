# A deliberately small 32-bit desktop. All packages are signature-checked by apk.
FROM docker.io/i386/alpine:3.23

RUN apk update && apk upgrade && apk add --no-cache \
    alpine-base alpine-conf openrc agetty linux-virt linux-firmware-none \
    xorg-server xf86-video-fbdev xf86-input-mouse xf86-input-keyboard \
    xinit xset xwininfo fluxbox xterm dillo ca-certificates font-dejavu

COPY guest/ /
RUN chmod +x /root/.xinitrc \
    && echo 'root:' | chpasswd \
    && sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab \
    && echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab \
    && echo 'webvm' > /etc/hostname \
    && for service in devfs dmesg mdev hwdrivers; do rc-update add "$service" sysinit; done \
    && for service in hwclock modules sysctl hostname syslog bootmisc; do rc-update add "$service" boot; done \
    && rc-update add killprocs shutdown \
    && mkinitfs -F 'base virtio 9p' "$(cat /usr/share/kernel/virt/kernel.release)" \
    && mkdir -p /opt/webvm/provenance \
    && cp /lib/apk/db/installed /opt/webvm/provenance/apk-installed.txt \
    && apk info -v > /opt/webvm/provenance/packages.txt \
    && cat /etc/alpine-release > /opt/webvm/provenance/alpine-version.txt \
    && cat /usr/share/kernel/virt/kernel.release > /opt/webvm/provenance/kernel-version.txt

# fbdev, Dillo and Fluxbox do not use GPU acceleration. Remove the unused Mesa
# GPU/LLVM payload, documentation and APK caches, not anything linked by Xorg
# or the browser. This is a demo image, not a general-purpose APK installation.
RUN rm -rf /usr/lib/dri /usr/lib/libLLVM* /usr/lib/xorg/modules/extensions/libglx.so \
    /usr/lib/xorg/modules/libglamoregl.so /usr/share/doc /usr/share/man /var/cache/apk/* \
    && ldd /usr/bin/Xorg && ldd /usr/bin/dillo

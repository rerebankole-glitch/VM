export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
if [ "$(tty)" = /dev/tty1 ] && [ -z "$DISPLAY" ]; then
    # Prefer a 16:9 framebuffer before X starts. vesafb may refuse; that's fine.
    fbset -g 1280 720 1280 720 32 >/tmp/fbset.log 2>&1 \
        || fbset -g 1024 576 1024 576 32 >/tmp/fbset.log 2>&1 \
        || true
    # startx's xauth hard-link locks can stall on a 9p root. This standalone
    # demo uses a local Unix X socket only, so launch xinit directly instead.
    exec xinit /root/.xinitrc -- /usr/libexec/Xorg :0 vt1 -keeptty -nolisten tcp -extension GLX
fi

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "$(tty)" = /dev/tty1 ] && [ -z "$DISPLAY" ]; then
    # startx's xauth hard-link locks can stall on a 9p root. This standalone
    # demo uses a local Unix X socket only, so launch xinit directly instead.
    exec xinit /root/.xinitrc -- /usr/libexec/Xorg :0 vt1 -keeptty -nolisten tcp -extension GLX
fi

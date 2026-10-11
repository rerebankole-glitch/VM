export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "$(tty)" = /dev/tty1 ] && [ -z "$DISPLAY" ]; then
    exec startx /root/.xinitrc -- :0 -nolisten tcp -extension GLX
fi

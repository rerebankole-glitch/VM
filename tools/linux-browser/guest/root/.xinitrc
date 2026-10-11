#!/bin/sh
# Networking is optional and must never delay the local desktop.
if ip link show eth0 >/dev/null 2>&1; then
    ip link set eth0 up
    udhcpc -b -q -i eth0 > /tmp/network.log 2>&1 &
fi
xset s off
xset -dpms
xsetroot -solid '#152c3d' 2>/dev/null || true
fluxbox > /tmp/fluxbox.log 2>&1 &
wm=$!
dillo -g 960x640+32+24 file:///opt/webvm/welcome.html > /tmp/dillo.log 2>&1 &
# QA listens on serial: an actual mapped browser window, not just kernel text.
for attempt in $(seq 1 60); do
    if xwininfo -root -tree 2>/dev/null | grep -q 'WebVM Linux'; then
        echo WEBVM_BROWSER_WINDOW_READY > /dev/ttyS0
        break
    fi
    sleep 1
done
wait "$wm"

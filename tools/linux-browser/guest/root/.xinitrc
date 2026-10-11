#!/bin/sh
# Dillo's local file helper uses TCP loopback even when guest internet is off.
ip link set lo up
# Networking is optional and must never delay the local desktop.
if ip link show eth0 >/dev/null 2>&1; then
    ip link set eth0 up
    udhcpc -b -q -i eth0 > /tmp/network.log 2>&1 &
fi
xset s off
xset -dpms
xsetroot -solid '#0b1c22' 2>/dev/null || true
fluxbox > /tmp/fluxbox.log 2>&1 &
wm=$!
# Geometry is a 16:9 window; Fluxbox also maximises Dillo from ~/.fluxbox/apps.
dillo file:///opt/webvm/welcome.html > /tmp/dillo.log 2>&1 &
# QA listens on serial: an actual mapped browser window, not just kernel text.
for attempt in $(seq 1 90); do
    if xwininfo -root -tree 2>/dev/null | grep -q 'WebVM Linux'; then
        echo WEBVM_BROWSER_WINDOW_READY > /dev/ttyS0
        break
    fi
    sleep 1
done
wait "$wm"

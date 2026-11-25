#!/bin/sh
set -eu
umask 077
export HOME=/home/cua DISPLAY=:1 XDG_RUNTIME_DIR=/run/user/1000
cd "$HOME"
# The exclusive profile volume outlives the container and its browser processes.
rm -f -- .config/chromium/SingletonLock .config/chromium/SingletonCookie .config/chromium/SingletonSocket
mkdir -m 1777 /tmp/.X11-unix
/usr/bin/Xtigervnc :1 -geometry 1280x900 -depth 24 -localhost yes -SecurityTypes None -nolisten tcp &
x_pid=$!
trap 'kill "$x_pid" 2>/dev/null || true' EXIT
trap 'exit 0' TERM INT
attempt=0
until [ -S /tmp/.X11-unix/X1 ]; do
    kill -0 "$x_pid"
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || exit 1
    sleep .1
done
/usr/bin/dbus-run-session -- /usr/bin/xfce4-session &
wait "$x_pid"

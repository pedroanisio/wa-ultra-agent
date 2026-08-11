#!/bin/sh
# Start a virtual display, then hand the process over to the server.
#
# This replaces `xvfb-run`, which hangs in this image when it is PID 1: it is a
# shell wrapper that starts Xvfb and then waits, and under container init
# semantics its command never ran — Xvfb appeared in the process table while
# node never did, with nothing on stdout to say why. Starting Xvfb explicitly is
# a few more lines and removes the guesswork.
set -e

DISPLAY_NUM="${WA_DISPLAY_NUM:-99}"
SCREEN="${WA_SCREEN:-1280x900x24}"

Xvfb ":${DISPLAY_NUM}" -screen 0 "$SCREEN" -nolisten tcp &
XVFB_PID=$!

export DISPLAY=":${DISPLAY_NUM}"

# Chromium fails to connect if it starts before the X socket exists, so wait for
# the socket rather than sleeping a hopeful interval.
i=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "Xvfb did not create /tmp/.X11-unix/X${DISPLAY_NUM} within 10s" >&2
    exit 1
  fi
  # If Xvfb died, say so instead of timing out silently.
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "Xvfb exited during startup" >&2
    exit 1
  fi
  sleep 0.1
done

echo "Xvfb ready on ${DISPLAY} (${SCREEN})"

# Clear Chromium's singleton lock before launching.
#
# Chromium refuses to open a profile whose SingletonLock names a different host
# ("the profile appears to be in use by another Chromium process on another
# computer"). A container's hostname changes on every recreate, so the lock left
# by the previous run is ALWAYS stale here — and without this, the first restart
# after any `compose up` breaks the session until someone deletes it by hand.
#
# Safe because exactly one browser uses this profile: the volume belongs to this
# service, and the process holding the lock cannot have survived the restart.
PROFILE="${WA_PROFILE_DIR:-/data/profile}"
if [ -d "$PROFILE" ]; then
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie" 2>/dev/null || true
  echo "cleared stale Chromium singleton locks in $PROFILE"
fi

# exec so the server becomes PID 1 and receives SIGTERM directly: without it,
# compose's stop would kill this shell and leave Chromium orphaned, which
# corrupts the session profile.
exec node src/server.js

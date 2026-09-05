#!/usr/bin/env bash
# Opens the RAMTECH dashboard full-screen (kiosk) on the Orange Pi's display.
# Launched by the desktop session on login (see deploy/install.sh).
set -u
URL="http://localhost:${PORT:-3000}"

# Wait for the server (systemd service) to answer before opening the browser.
for _ in $(seq 1 90); do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

# Find a Chromium-family browser.
BIN=""
for c in chromium chromium-browser google-chrome-stable google-chrome; do
  if command -v "$c" >/dev/null 2>&1; then BIN="$(command -v "$c")"; break; fi
done
[ -z "$BIN" ] && { echo "kiosk: no chromium found"; exit 1; }

# Keep the screen awake (best effort; X11).
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true
# Hide the mouse cursor if unclutter is present.
if command -v unclutter >/dev/null 2>&1; then (unclutter -idle 1 &) 2>/dev/null; fi

exec "$BIN" \
  --kiosk "$URL" \
  --user-data-dir="$HOME/.config/ramtech-kiosk" \
  --autoplay-policy=no-user-gesture-required \
  --start-fullscreen --noerrdialogs --disable-infobars \
  --disable-session-crashed-bubble --disable-features=Translate \
  --check-for-update-interval=31536000 --password-store=basic \
  --no-first-run --no-default-browser-check \
  --overscroll-history-navigation=0

#!/usr/bin/env bash
# macOS / Linux stopper (Windows users: use stop.bat).
cd "$(dirname "$0")/app" || exit 1
echo "Stopping spotify-tv-jam..."

# 1) Close the full-screen (kiosk) TV window — matched by its isolated profile,
#    so your normal browser is untouched.
pkill -f "$PWD/.data/kiosk" 2>/dev/null

# 2) Stop the server by the PID it wrote (exact — leaves other Node apps alone).
if [ -f ".data/server.pid" ]; then
  kill "$(cat .data/server.pid)" 2>/dev/null
  rm -f ".data/server.pid"
else
  pkill -f "$PWD.*server.js" 2>/dev/null
fi

echo "Done. Everything is stopped."

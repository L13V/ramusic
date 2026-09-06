#!/usr/bin/env bash
# macOS / Linux launcher (Windows users: use start.bat).
cd "$(dirname "$0")/app" || exit 1
echo
echo "==== spotify-tv-jam ===="
echo
echo "This terminal RUNS the app. To stop everything:"
echo "   - press Ctrl+C here (or close this terminal), and"
echo "   - run ./stop.sh (closes the full-screen TV window too)."
echo

[ -d node_modules ] || { echo "Installing dependencies, this can take a minute..."; npm install; }

URL="http://localhost:${PORT:-3000}"
KIOSK_PROFILE="$PWD/.data/kiosk"

# Open the kiosk (full-screen) TV window in its own isolated profile after the
# server has a moment to come up. Runs in the background; stop.sh closes it.
(
  sleep 5
  # An array, not a string: the profile path is under the repo, and splitting an
  # unquoted "$COMMON" tore --user-data-dir in half for anyone whose checkout
  # lives in a directory with a space in it.
  COMMON=(--new-window --kiosk "--user-data-dir=$KIOSK_PROFILE"
          --autoplay-policy=no-user-gesture-required "$URL")
  if [ "$(uname)" = "Darwin" ]; then
    open -na "Google Chrome" --args "${COMMON[@]}" 2>/dev/null \
      || open -na "Microsoft Edge" --args "${COMMON[@]}" 2>/dev/null \
      || open -na "Brave Browser" --args "${COMMON[@]}" 2>/dev/null
  else
    # Google Chrome first: it ships Widevine, so the Web Playback SDK can play.
    for B in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
      if command -v "$B" >/dev/null 2>&1; then "$B" "${COMMON[@]}" >/dev/null 2>&1 & break; fi
    done
  fi
) &

npm start

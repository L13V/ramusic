#!/usr/bin/env bash
# One-shot installer for Orange Pi 5 (and other Debian/Ubuntu/Armbian ARM64
# boards). Sets the app up to auto-start on boot and open full-screen.
#
#   cd spotify-tv-jam && bash deploy/install.sh
#
# Safe to re-run. Uses sudo for package install + the systemd service.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"          # project root
USER_NAME="${SUDO_USER:-$USER}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
echo "==> Installing RAMTECH TV from $DIR (user: $USER_NAME)"

# ── 1. Packages ──────────────────────────────────────────────
sudo apt-get update -y
sudo apt-get install -y curl
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20 (ARM64)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  echo "==> Installing Chromium…"
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser || true
fi
sudo apt-get install -y unclutter x11-xserver-utils 2>/dev/null || true

# ── 2. App deps ──────────────────────────────────────────────
echo "==> npm install"
( cd "$DIR/app" && npm install --omit=dev )

# ── 2b. Audio player: librespot (via raspotify) so the Pi outputs sound ──
# ARM Chromium can't do Spotify's DRM web player, so the Pi plays through
# librespot — a headless Spotify Connect device. We name it to match
# WEBPLAYER_NAME so the server can find and control it.
if ! systemctl list-unit-files 2>/dev/null | grep -q '^raspotify'; then
  echo "==> Installing librespot (raspotify)…"
  curl -sSL https://dtcooper.github.io/raspotify/install.sh | sudo sh || \
    echo "  ⚠ raspotify install failed — install librespot manually (see README)."
fi
if [ -f /etc/raspotify/conf ]; then
  sudo sed -i 's/^#\?\s*LIBRESPOT_NAME=.*/LIBRESPOT_NAME="RAMTECH TV"/' /etc/raspotify/conf
  grep -q '^LIBRESPOT_NAME=' /etc/raspotify/conf || echo 'LIBRESPOT_NAME="RAMTECH TV"' | sudo tee -a /etc/raspotify/conf >/dev/null
  sudo sed -i 's/^#\?\s*LIBRESPOT_INITIAL_VOLUME=.*/LIBRESPOT_INITIAL_VOLUME="60"/' /etc/raspotify/conf
  sudo systemctl restart raspotify 2>/dev/null || true
fi

# The Pi plays via librespot, not the browser SDK — turn the SDK off so no dead
# "Play on this TV" button appears. (WEBPLAYER_NAME stays as the device name.)
if [ -f "$DIR/app/.env" ] && grep -q '^WEBPLAYER=' "$DIR/app/.env"; then
  sed -i 's/^WEBPLAYER=.*/WEBPLAYER=false/' "$DIR/app/.env"
fi

# ── 3. Server as a systemd service (auto-starts, auto-restarts) ──
NODE_BIN="$(command -v node)"
echo "==> Installing systemd service (server)"
sudo tee /etc/systemd/system/spotify-tv-jam.service >/dev/null <<EOF
[Unit]
Description=RAMTECH Spotify TV Jam server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$DIR/app
ExecStart=$NODE_BIN $DIR/app/server.js
Restart=always
RestartSec=3
# Give the server access to the desktop's display so the remote sign-in can
# open a real Spotify window during setup. Adjust if your board uses Wayland.
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME_DIR/.Xauthority

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now spotify-tv-jam

# ── 4. Kiosk browser auto-start (desktop session) ────────────
chmod +x "$DIR/app/deploy/kiosk.sh"
mkdir -p "$HOME_DIR/.config/autostart"
tee "$HOME_DIR/.config/autostart/ramtech-kiosk.desktop" >/dev/null <<EOF
[Desktop Entry]
Type=Application
Name=RAMTECH TV Kiosk
Comment=Full-screen Spotify dashboard
Exec=$DIR/app/deploy/kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
chown -R "$USER_NAME":"$USER_NAME" "$HOME_DIR/.config/autostart" 2>/dev/null || true

echo
echo "==> Done."
echo "    Server:  systemctl status spotify-tv-jam   (logs: journalctl -u spotify-tv-jam -f)"
echo "    Audio:   systemctl status raspotify        (the 'RAMTECH TV' Connect device)"
echo "    Kiosk:   opens on the next desktop login / reboot"
echo
echo "    ONE-TIME: on your phone's Spotify app (same account, Premium), open the"
echo "    devices menu and tap 'RAMTECH TV' once to authorize it. After that the Pi"
echo "    plays on its own whenever a guest joins the Jam."
echo
echo "    Reboot now to launch it all:  sudo reboot"

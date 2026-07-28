#!/bin/bash
# RAMTECH OS image customization. Run by the Armbian build inside the arm64
# chroot (qemu) just before the image is finalized. Network is available.
# The userpatches/overlay directory is mounted at /tmp/overlay.
#
# Args from Armbian: $1=RELEASE $2=LINUXFAMILY $3=BOARD $4=BUILD_DESKTOP
set -e
export DEBIAN_FRONTEND=noninteractive

OVERLAY=/tmp/overlay
ROOT=/opt/ramtech
RAMTECH_USER=ramtech

echo "=== RAMTECH customize: release=$1 family=$2 board=$3 ==="

# ── 1. Node.js 20 (nodesource apt repo — no curl|bash) ───────
apt-get update
apt-get install -y ca-certificates curl gnupg jq
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs

# ── 2. Kiosk stack (X11 — the app's remote sign-in opens a real window) ──
apt-get install -y --no-install-recommends \
  xserver-xorg-core xserver-xorg-legacy xserver-xorg-input-libinput \
  xinit openbox x11-xserver-utils unclutter \
  chromium fonts-noto-core \
  alsa-utils
# Allow startx from the autologin tty (rootless X on a bare console).
cat > /etc/X11/Xwrapper.config <<'EOF'
allowed_users=anybody
needs_root_rights=yes
EOF

# ── 3. Audio: librespot via raspotify (the "RAMTECH TV" Connect device) ──
curl -fL -o /tmp/raspotify.deb https://dtcooper.github.io/raspotify/raspotify-latest_arm64.deb
apt-get install -y /tmp/raspotify.deb || dpkg -i /tmp/raspotify.deb || true
rm -f /tmp/raspotify.deb
mkdir -p /etc/raspotify
cat > /etc/raspotify/conf <<'EOF'
LIBRESPOT_NAME="RAMTECH TV"
LIBRESPOT_INITIAL_VOLUME="60"
LIBRESPOT_QUIET=
EOF
systemctl enable raspotify 2>/dev/null || true

# ── 4. User + autologin ──────────────────────────────────────
useradd -m -s /bin/bash "$RAMTECH_USER" || true
usermod -aG video,render,audio,input,tty,plugdev,sudo "$RAMTECH_USER" 2>/dev/null || \
  usermod -aG video,audio,input,tty,sudo "$RAMTECH_USER"
getent group netdev >/dev/null && usermod -aG netdev "$RAMTECH_USER"
echo "$RAMTECH_USER:ramtech" | chpasswd
passwd -l root || true                       # console login is user "ramtech"
rm -f /root/.not_logged_in_yet               # disable the first-login wizard

mkdir -p /etc/systemd/system/getty@tty1.service.d
cp "$OVERLAY/systemd/getty-autologin.conf" /etc/systemd/system/getty@tty1.service.d/autologin.conf

install -o "$RAMTECH_USER" -g "$RAMTECH_USER" -m 0755 "$OVERLAY/kiosk/xinitrc" "/home/$RAMTECH_USER/.xinitrc"
install -o "$RAMTECH_USER" -g "$RAMTECH_USER" -m 0644 "$OVERLAY/kiosk/bash_profile" "/home/$RAMTECH_USER/.bash_profile"

# ── 5. App payload: install the latest GitHub release (same path as OTA) ──
mkdir -p "$ROOT/releases" "$ROOT/data/app" "$ROOT/data/admin" "$ROOT/ota" "$ROOT/bin"
cp "$OVERLAY/bin/"*.sh "$ROOT/bin/"
chmod +x "$ROOT/bin/"*.sh

REPO="$(head -n1 "$OVERLAY/seed/repo.txt" 2>/dev/null | tr -d '[:space:]')"
TARBALL=""
VERSION=""
if [ -n "$REPO" ] && [ "$REPO" != "OWNER/REPO" ]; then
  echo "=== Fetching latest release from $REPO ==="
  REL_JSON="$(curl -fsS -m 30 -H 'accept: application/vnd.github+json' -H 'user-agent: ramtech-build' \
    "https://api.github.com/repos/$REPO/releases/latest" || true)"
  VERSION="$(printf '%s' "$REL_JSON" | jq -r '.tag_name // empty')"
  URL="$(printf '%s' "$REL_JSON" | jq -r '[.assets[] | select(.name | startswith("ramtech-app-") and endswith(".tar.gz"))][0].browser_download_url // empty')"
  if [ -n "$URL" ]; then
    TARBALL=/tmp/ramtech-app.tar.gz
    curl -fL --retry 3 -o "$TARBALL" "$URL"
  fi
fi
# Offline fallback: a tarball pre-placed in the overlay.
if [ -z "$TARBALL" ]; then
  SEED_TGZ="$(ls "$OVERLAY"/seed/ramtech-app-*.tar.gz 2>/dev/null | head -n1 || true)"
  if [ -n "$SEED_TGZ" ]; then
    TARBALL="$SEED_TGZ"
    VERSION="$(basename "$SEED_TGZ" .tar.gz | sed 's/^ramtech-app-//')"
  fi
fi
if [ -z "$TARBALL" ]; then
  echo "!!! No app payload: set a real repo in userpatches/overlay/seed/repo.txt (with a"
  echo "!!! published release) or drop ramtech-app-<ver>.tar.gz into overlay/seed/."
  exit 1
fi

DEST="$ROOT/releases/$VERSION"
mkdir -p "$DEST"
tar -xzf "$TARBALL" -C "$DEST"
[ -f "$DEST/VERSION" ] || echo "$VERSION" > "$DEST/VERSION"
cp -f "$OVERLAY/seed/env.default" "$ROOT/data/.env"
ln -sfn "$ROOT/data/app" "$DEST/app/.data"
ln -sfn "$ROOT/data/.env" "$DEST/app/.env"
ln -sfn "releases/$VERSION" "$ROOT/current"
chmod +x "$DEST/app/deploy/"*.sh 2>/dev/null || true
# Prefill the admin's update source with the same repo.
[ -n "$REPO" ] && [ "$REPO" != "OWNER/REPO" ] && \
  printf '{\n  "repo": "%s",\n  "autoUpdate": false\n}\n' "$REPO" > "$ROOT/data/admin/settings.json"
# The app (runs as ramtech) owns its data; admin state stays root-only.
chown -R "$RAMTECH_USER":"$RAMTECH_USER" "$ROOT/data/app" "$ROOT/data/.env" "$ROOT/releases"

# ── 6. Services ──────────────────────────────────────────────
cp "$OVERLAY/systemd/spotify-tv-jam.service" /etc/systemd/system/
cp "$OVERLAY/systemd/ramtech-admin.service" /etc/systemd/system/
cp "$OVERLAY/systemd/ramtech-ota-check.service" /etc/systemd/system/
cp "$OVERLAY/systemd/ramtech-ota-check.timer" /etc/systemd/system/
systemctl enable spotify-tv-jam ramtech-admin
# (ramtech-ota-check.timer ships disabled; toggled from the admin UI)

# ── 7. Branding ──────────────────────────────────────────────
echo ramtech > /etc/hostname
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tramtech/' /etc/hosts
else
  printf '127.0.1.1\tramtech\n' >> /etc/hosts
fi
install -m 0755 "$OVERLAY/branding/20-ramtech" /etc/update-motd.d/20-ramtech
sed -i 's/^PRETTY_NAME=.*/PRETTY_NAME="RAMTECH OS (Armbian trixie)"/' /etc/os-release || true

apt-get clean
# Armbian's apt-cache manager requires the rootfs lists dir to be empty between
# apt runs — our apt-get update above populated it, which aborts the build.
rm -rf /var/lib/apt/lists/*
echo "=== RAMTECH customize done: $VERSION ==="

#!/usr/bin/env bash
# Runs once per boot, before the app services. On a live image the kiosk user is
# created at boot by live-config (username=ramtech), so anything that needs that
# user to exist — its password, its groups, ownership of the app's state — can't
# be done at build time and is done here instead.
set -u

ROOT="${RAMTECH_ROOT:-/opt/ramtech}"
USER_NAME=ramtech

# live-config normally creates the user; create it ourselves if it didn't.
if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash -c "RAMTECH" "$USER_NAME"
fi

# Console login for support: ramtech / ramtech. Root stays locked.
echo "$USER_NAME:ramtech" | chpasswd
passwd -l root >/dev/null 2>&1 || true

for g in video render audio input tty plugdev netdev sudo; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$USER_NAME"
done

# The session files live in /etc/skel; copy them in if the home predates them
# (a persistence partition written by an older image).
for f in .xinitrc .bash_profile; do
  [ -e "/home/$USER_NAME/$f" ] || cp -a "/etc/skel/$f" "/home/$USER_NAME/$f" 2>/dev/null || true
done
chown -R "$USER_NAME":"$USER_NAME" "/home/$USER_NAME" 2>/dev/null || true

# The app runs as ramtech and owns its state; admin state stays root-only.
mkdir -p "$ROOT/data/app" "$ROOT/data/admin" "$ROOT/ota"
[ -f "$ROOT/data/.env" ] || touch "$ROOT/data/.env"
chown -R "$USER_NAME":"$USER_NAME" "$ROOT/data/app" "$ROOT/data/.env" "$ROOT/releases" 2>/dev/null || true

# Warn loudly on the console if persistence never came up — without it every
# reboot loses the Spotify sign-in, and that is worth noticing.
if ! findmnt -rno TARGET /run/live/persistence/* >/dev/null 2>&1 \
   && ! grep -qs ramtech-data /proc/mounts; then
  echo "RAMTECH: no persistence partition mounted — settings will NOT survive a reboot." >&2
fi

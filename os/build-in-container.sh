#!/usr/bin/env bash
# Builds the RAMTECH OS x86_64 live image. Runs *inside* the container built
# from os/Dockerfile — see os/build.sh for the host-side entry point.
#
#   /src   the repo, read-only-ish (only os/out is written)
#   /build live-build's working tree (a container volume; keeps the apt cache)
set -euo pipefail

SRC=/src
WORK=/build
OUT="$SRC/os/out"
PERSIST_MB="${PERSIST_MB:-4096}"

VERSION="${RAMTECH_VERSION:-$(git -C "$SRC" describe --tags --always --dirty 2>/dev/null || echo dev)}"

echo "==> RAMTECH OS $VERSION (persistence ${PERSIST_MB} MB)"

# ── 1. Assemble the live-build config tree ───────────────────
mkdir -p "$WORK" "$OUT"
cd "$WORK"
# Always start from a clean chroot. live-build records per-stage "already done"
# markers, and a run that failed part-way leaves those markers pointing at a
# chroot its own error teardown has since removed packages from — the next build
# then skips straight past the repair and fails somewhere unrelated. Removing the
# stage markers by hand rather than with `lb clean` keeps cache/ (the debootstrap
# tarball and every downloaded .deb) and doesn't also drop the config stage.
rm -rf config chroot binary .build chroot.files binary.modified_timestamps
rm -f chroot.packages.live chroot.packages.install
cp -r "$SRC/os/live" config
# The hook reads the shared overlay from inside the chroot, so ship it there.
mkdir -p config/includes.chroot/opt
cp -r "$SRC/os/overlay" config/includes.chroot/opt/ramtech-overlay
# Belt and braces against a Windows checkout: a CR in a shell script or a
# .plymouth file fails deep inside the chroot with a message that names the
# wrong problem entirely.
find config -type f ! -name '*.tar.gz' ! -name '*.png' -exec sed -i 's/\r$//' {} +
find config -type f \( -name '*.sh' -o -name '*.hook.*' \) -exec chmod +x {} +

# GRUB's stock template sets default=0 but never a timeout, so the menu waits
# for a keypress forever — fatal for a panel with no keyboard. Seed the whole
# template from the installed live-build (so it tracks upstream) and patch in
# an auto-boot, drop the startup beep, and clear the leftover theme title.
mkdir -p config/bootloaders
cp -a /usr/share/live/build/bootloaders/grub-pc config/bootloaders/
sed -i '/^insmod play$/,$ d' config/bootloaders/grub-pc/config.cfg
cat >> config/bootloaders/grub-pc/config.cfg <<'GRUBCFG'
set timeout=2
GRUBCFG
sed -i 's|^title-text:.*|title-text: ""|' config/bootloaders/grub-pc/live-theme/theme.txt

BOOTAPPEND="boot=live components quiet splash \
persistence persistence-label=ramtech-data \
username=ramtech user-fullname=RAMTECH hostname=ramtech \
noeject loglevel=2 vt.global_cursor_default=0 plymouth.ignore-serial-consoles"

# --firmware-chroot false: it drags in every firmware-* package, including
# firmware-b43legacy-installer, which downloads Broadcom blobs from a
# third-party site during install — a build failure whenever that host is
# down, for hardware an Intel OPS module does not have. The package list
# names what is actually needed instead.
lb config \
  --distribution trixie \
  --architectures amd64 \
  --archive-areas "main contrib non-free non-free-firmware" \
  --binary-images iso-hybrid \
  --bootloaders "syslinux,grub-efi" \
  --uefi-secure-boot enable \
  --debian-installer none \
  --memtest none \
  --apt-recommends false \
  --apt-indices false \
  --firmware-chroot false \
  --linux-flavours amd64 \
  --image-name "ramtech-os" \
  --iso-application "RAMTECH OS" \
  --iso-publisher "RAMTECH" \
  --iso-volume "RAMTECH_OS" \
  --bootappend-live "$BOOTAPPEND"

# ── 2. Build ─────────────────────────────────────────────────
lb build "$@" 2>&1 | tee "$OUT/build.log"

ISO="$(ls "$WORK"/ramtech-os-amd64.hybrid.iso "$WORK"/*.hybrid.iso 2>/dev/null | head -n1)"
[ -f "$ISO" ] || { echo "!!! live-build produced no ISO — see $OUT/build.log"; exit 1; }

# ── 3. Wrap it into the USB image (see os/finish-image.sh) ───
export WORK OUT PERSIST_MB
export RAMTECH_VERSION="$VERSION"
bash "$SRC/os/finish-image.sh" "$ISO"

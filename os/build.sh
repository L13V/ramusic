#!/usr/bin/env bash
# Build the RAMTECH OS image for Orange Pi 5 using the Armbian build framework.
#
# From Windows:   wsl bash os/build.sh
# From WSL/Linux: bash os/build.sh
#
# The Armbian tree lives on the WSL ext4 filesystem (~/armbian/build) — building
# on /mnt/c is not supported (9p performance + case-sensitivity). This script
# copies os/userpatches/ in and runs ./compile.sh ramtech.
set -e

BUILD_DIR="${ARMBIAN_BUILD_DIR:-$HOME/armbian/build}"
SELF="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$BUILD_DIR/.git" ]; then
  echo "==> Cloning armbian/build into $BUILD_DIR (first run)…"
  mkdir -p "$(dirname "$BUILD_DIR")"
  git clone --depth=1 https://github.com/armbian/build "$BUILD_DIR"
fi

echo "==> Syncing userpatches…"
mkdir -p "$BUILD_DIR/userpatches"
cp -r "$SELF/userpatches/." "$BUILD_DIR/userpatches/"
# Windows checkouts may carry CRLF — the chroot scripts must be LF.
find "$BUILD_DIR/userpatches" -type f -exec sed -i 's/\r$//' {} +
chmod +x "$BUILD_DIR/userpatches/customize-image.sh"

cd "$BUILD_DIR"
echo "==> Building (first run compiles the kernel — expect 1–2 h)…"
TERM=xterm-256color ./compile.sh ramtech "$@"

echo
echo "==> Done. Images:"
ls -lh "$BUILD_DIR"/output/images/ | tail -5
echo "Flash the .img.xz with balenaEtcher or USBImager on Windows."

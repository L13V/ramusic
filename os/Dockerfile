# Builder image for RAMTECH OS (x86_64 live USB).
#
# live-build needs a Debian host, root, and loop devices — so the build always
# runs in this container, whether you start it from Windows, macOS or Linux.
# See os/build.sh (host side) and os/build-in-container.sh (inside).
FROM debian:trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
      live-build debootstrap \
      xorriso squashfs-tools isolinux syslinux syslinux-common \
      grub-efi-amd64-bin grub-pc-bin mtools dosfstools e2fsprogs \
      gdisk fdisk util-linux parted \
      ca-certificates curl gnupg jq rsync pigz procps file \
 && rm -rf /var/lib/apt/lists/*

# QEMU + OVMF are only used by `os/build.sh --smoke-test`, which boots the
# finished image headlessly to prove it reaches the kiosk.
RUN apt-get update && apt-get install -y --no-install-recommends \
      qemu-system-x86 ovmf seabios netcat-openbsd netpbm \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

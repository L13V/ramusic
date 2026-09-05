#!/usr/bin/env bash
# Turns live-build's hybrid ISO into the USB image that ships: same bytes, plus
# a labelled ext4 persistence partition appended to the end.
#
# Windows cannot create an ext4 filesystem, so baking the partition into the
# image is what lets the imager be a single byte-for-byte copy on every
# platform. Split out from build-in-container.sh so it can be re-run against an
# ISO that is already built.
#
#   bash os/finish-image.sh [path/to.iso]
set -euo pipefail

WORK="${WORK:-/build}"
OUT="${OUT:-/src/os/out}"
PERSIST_MB="${PERSIST_MB:-4096}"
VERSION="${RAMTECH_VERSION:-dev}"
IMAGE_BASE="ramtech-os-${VERSION}-x86_64"

ISO="${1:-}"
[ -n "$ISO" ] || ISO="$(ls "$WORK"/*.hybrid.iso 2>/dev/null | head -n1)"
[ -f "$ISO" ] || { echo "!!! No hybrid ISO found (looked in $WORK)"; exit 1; }

mkdir -p "$OUT"
IMG="$OUT/$IMAGE_BASE.img"
ALIGN=$((1024 * 1024))
SECT=512

iso_bytes=$(stat -c%s "$ISO")
start_bytes=$(((iso_bytes + ALIGN - 1) / ALIGN * ALIGN))
persist_bytes=$((PERSIST_MB * 1024 * 1024))
# +1 MiB of slack at the end so a GPT backup header has somewhere to live.
total_bytes=$((start_bytes + persist_bytes + ALIGN))

echo "==> ISO $(numfmt --to=iec "$iso_bytes") + ${PERSIST_MB} MB persistence"
rm -f "$IMG"
cp --sparse=always "$ISO" "$IMG"
truncate -s "$total_bytes" "$IMG"

label="$(sfdisk --json "$IMG" | jq -r '.partitiontable.label // "dos"')"
echo "==> Partition table is $label; appending persistence at $((start_bytes / SECT))"
if [ "$label" = gpt ]; then
  # Relocate the backup GPT to the new end of the disk, then claim the space.
  sgdisk --move-second-header "$IMG" >/dev/null
  sgdisk --new "0:$((start_bytes / SECT)):+${PERSIST_MB}M" \
         --typecode 0:8300 --change-name 0:ramtech-data "$IMG" >/dev/null
else
  # --wipe never: the iso9660 signature covering partition 1 must survive, it is
  # the filesystem the machine boots from.
  printf 'start=%s, size=%s, type=83\n' "$((start_bytes / SECT))" "$((persist_bytes / SECT))" \
    | sfdisk --append --wipe never --no-reread "$IMG" >/dev/null
fi

# Map the partition region directly rather than via `losetup -P`: a container
# has no udev, so partition device nodes are never created for it.
LOOP="$(losetup --show -f --offset "$start_bytes" --sizelimit "$persist_bytes" "$IMG")"
cleanup() { umount /mnt/persist 2>/dev/null || true; losetup -d "$LOOP" 2>/dev/null || true; }
trap cleanup EXIT

mkfs.ext4 -q -L ramtech-data -m 0 "$LOOP"
mkdir -p /mnt/persist
mount "$LOOP" /mnt/persist
# "/ union" = the whole filesystem is overlaid, so OTA updates under
# /opt/ramtech/releases and the Spotify tokens in /opt/ramtech/data both survive.
echo "/ union" > /mnt/persist/persistence.conf
cleanup
trap - EXIT

echo "==> Layout:"
sfdisk -l "$IMG"

echo "==> Compressing (a few minutes)…"
pigz -9 -f "$IMG"
cd "$OUT"
sha256sum "$IMAGE_BASE.img.gz" > "$IMAGE_BASE.img.gz.sha256"
cp -f "$ISO" "$OUT/$IMAGE_BASE.iso"

echo
echo "==> Done:"
ls -lh "$OUT"

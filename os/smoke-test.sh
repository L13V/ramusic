#!/usr/bin/env bash
# Boots the finished image in QEMU under UEFI and screenshots the framebuffer at
# intervals, so a build can be proven to actually reach the kiosk without
# burning a stick. Run via `bash os/build.sh --smoke-test`, or directly inside
# the builder container. Screenshots land in os/out/smoke/.
set -euo pipefail

OUT=/src/os/out
SHOTS="$OUT/smoke"
IMG_GZ="$(ls "$OUT"/ramtech-os-*.img.gz 2>/dev/null | head -n1)"
[ -n "$IMG_GZ" ] || { echo "No image in $OUT — build first."; exit 1; }

mkdir -p "$SHOTS"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# The VM writes to its own copy. Keeping it lets you mount the persistence
# partition afterwards and read the journal from the boot that just happened —
# which is the only way to debug a boot that ends on a black screen.
DISK="$WORK/disk.img"
if [ "${SMOKE_KEEP_DISK:-0}" = 1 ]; then
  DISK="$SHOTS/disk.img"
fi
echo "==> Decompressing $(basename "$IMG_GZ")…"
pigz -dc "$IMG_GZ" > "$DISK"

# A live boot writes to the persistence partition, so give QEMU a throwaway copy
# of the firmware vars too.
cp /usr/share/OVMF/OVMF_VARS_4M.fd "$WORK/vars.fd" 2>/dev/null \
  || cp /usr/share/OVMF/OVMF_VARS.fd "$WORK/vars.fd"
CODE=/usr/share/OVMF/OVMF_CODE_4M.fd
[ -f "$CODE" ] || CODE=/usr/share/OVMF/OVMF_CODE.fd

ACCEL=tcg
[ -w /dev/kvm ] && ACCEL=kvm
echo "==> Booting (accel=$ACCEL; TCG is software emulation and is slow)…"

qemu-system-x86_64 \
  -machine q35,accel=$ACCEL -smp 2 -m 4096 \
  -drive if=pflash,format=raw,unit=0,readonly=on,file="$CODE" \
  -drive if=pflash,format=raw,unit=1,file="$WORK/vars.fd" \
  -drive file="$DISK",format=raw,if=none,id=usbdisk \
  -device qemu-xhci -device usb-storage,drive=usbdisk \
  -vga std -display none \
  -nic user,model=virtio-net-pci \
  -monitor tcp:127.0.0.1:4444,server,nowait \
  -serial file:"$SHOTS/serial.log" &
QEMU_PID=$!
trap 'kill $QEMU_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

shot() { # <label>
  printf 'screendump %s\n' "$WORK/$1.ppm" | timeout 10 nc -q1 127.0.0.1 4444 >/dev/null 2>&1 || return 0
  [ -s "$WORK/$1.ppm" ] && pnmtopng "$WORK/$1.ppm" > "$SHOTS/$1.png" 2>/dev/null || true
}

elapsed=0
for t in 20 40 60 90 130 180 240 300; do
  sleep $((t - elapsed)); elapsed=$t
  kill -0 $QEMU_PID 2>/dev/null || { echo "!!! QEMU exited early"; break; }
  shot "t${t}s"
  echo "  … ${t}s"
done

kill $QEMU_PID 2>/dev/null || true
wait $QEMU_PID 2>/dev/null || true
echo "==> Screenshots in os/out/smoke/:"
ls -la "$SHOTS"

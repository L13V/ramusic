#!/usr/bin/env bash
# Build the RAMTECH OS x86_64 live USB image.
#
#   bash os/build.sh                 # build (~30 min the first time, ~15 after)
#   bash os/build.sh --clean         # throw away the live-build tree and its caches
#   bash os/build.sh --smoke-test    # after building, boot it in QEMU/UEFI
#
# Everything happens in a Debian container (os/Dockerfile), so this is the same
# command on Windows (Git Bash or WSL), macOS and Linux — the only requirement
# is Docker. Output lands in os/out/.
set -euo pipefail

SELF="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=ramtech-os-builder
VOLUME=ramtech-os-build
CLEAN=0
SMOKE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --clean) CLEAN=1 ;;
    --smoke-test) SMOKE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }

# Git Bash on Windows rewrites /src into a Windows path unless we opt out, and
# Docker Desktop wants C:/… rather than /c/… for the bind mount source.
export MSYS_NO_PATHCONV=1
HOST_SRC="$SELF"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) HOST_SRC="$(cd "$SELF" && pwd -W)" ;; esac

echo "==> Building the builder image…"
# Fall back to an image built earlier: the base-image metadata lookup needs the
# registry even when every layer is already local, so an offline machine would
# otherwise be unable to rebuild an OS image it has all the pieces for.
if ! docker build -t "$IMAGE" "$HOST_SRC/os"; then
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "!!! Could not build the builder image and none is cached."; exit 1
  fi
  echo "!!! docker build failed — carrying on with the cached $IMAGE image."
fi

# The container has no git, so name the image from the host's checkout.
VERSION="${RAMTECH_VERSION:-$(git -C "$SELF" describe --tags --always --dirty 2>/dev/null || echo dev)}"
echo "==> Version: $VERSION"

if [ "$CLEAN" = 1 ]; then
  echo "==> Removing the live-build working volume…"
  docker volume rm -f "$VOLUME" >/dev/null || true
fi

echo "==> Building the OS image…"
# --privileged: live-build needs loop devices, mount and a real /proc in the chroot.
docker run --rm --privileged \
  -v "$HOST_SRC:/src" \
  -v "$VOLUME:/build" \
  -e "RAMTECH_VERSION=$VERSION" \
  -e "PERSIST_MB=${PERSIST_MB:-4096}" \
  "$IMAGE" bash /src/os/build-in-container.sh "${ARGS[@]+"${ARGS[@]}"}"

if [ "$SMOKE" = 1 ]; then
  echo "==> Smoke test: booting the image under UEFI…"
  docker run --rm --privileged \
    -v "$HOST_SRC:/src" \
    "$IMAGE" bash /src/os/smoke-test.sh
fi

echo
echo "Image: $SELF/os/out/"
echo "Write it to a USB stick with the RAMTECH Imager (imager/) — or with"
echo "balenaEtcher / Rufus, which both understand the .img.gz directly."

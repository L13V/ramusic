#!/usr/bin/env bash
# RAMTECH OTA installer.
#   ramtech-ota-apply.sh <tarball-url> <version>   install a release
#   ramtech-ota-apply.sh --rollback                return to the previous release
#
# Launched detached (systemd-run --unit=ramtech-ota) by the admin service so it
# survives restarting both the app and the admin itself. Progress is written to
# $ROOT/ota/status.json which the admin UI polls.
#
# Env overrides (used by the WSL sandbox tests): RAMTECH_ROOT, RAMTECH_RESTART_APP,
# RAMTECH_RESTART_ADMIN, RAMTECH_HEALTH_URL, RAMTECH_HEALTH_TIMEOUT.
set -u

ROOT="${RAMTECH_ROOT:-/opt/ramtech}"
STATUS="$ROOT/ota/status.json"
PREV_FILE="$ROOT/ota/previous"
HEALTH_URL="${RAMTECH_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TIMEOUT="${RAMTECH_HEALTH_TIMEOUT:-90}"
RESTART_APP="${RAMTECH_RESTART_APP:-systemctl restart spotify-tv-jam}"
RESTART_ADMIN="${RAMTECH_RESTART_ADMIN:-systemctl restart ramtech-admin}"

mkdir -p "$ROOT/ota" "$ROOT/releases"

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }
set_status() { # state [version] [error]
  local err="${3:-}"
  printf '{"state":"%s","version":"%s","error":"%s","updatedAt":"%s"}\n' \
    "$1" "${2:-}" "$(json_escape "$err")" "$(date -Is)" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

flip_current() { # <releases/vX.Y.Z relative target>
  ln -sfn "$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
}

link_shared() { # <release dir> — point the app at persistent state
  mkdir -p "$ROOT/data/app"
  [ -f "$ROOT/data/.env" ] || touch "$ROOT/data/.env"
  ln -sfn "$ROOT/data/app" "$1/app/.data"
  ln -sfn "$ROOT/data/.env" "$1/app/.env"
}

health_check() {
  local i=0
  while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}

restart_and_verify() { # returns 0 if app healthy after restart
  $RESTART_APP || true
  set_status verifying "${1:-}"
  health_check
}

finish_success() { # <version-or-label> <release-dir-or-empty>
  # Refresh the out-of-release scripts from the new release (updates the updater).
  if [ -n "${2:-}" ] && [ -d "$2/bin" ]; then
    cp -f "$2"/bin/*.sh "$ROOT/bin/" 2>/dev/null && chmod +x "$ROOT/bin/"*.sh
  fi
  # Prune: keep only current + previous.
  local keep1 keep2 d
  keep1="$(basename "$(readlink -f "$ROOT/current")")"
  keep2="$(basename "${3:-x-none}")"
  for d in "$ROOT/releases"/*/; do
    d="${d%/}"
    case "$(basename "$d")" in "$keep1"|"$keep2") ;; *) rm -rf "$d";; esac
  done
  set_status success "$1"
  # Admin restarts last — it may be replacing itself.
  $RESTART_ADMIN || true
}

# ── Rollback mode ────────────────────────────────────────────
if [ "${1:-}" = "--rollback" ]; then
  PREV="$(cat "$PREV_FILE" 2>/dev/null || true)"
  if [ -z "$PREV" ] || [ ! -d "$ROOT/$PREV" ]; then
    set_status failed "" "No previous release to roll back to."; exit 1
  fi
  CUR_TARGET="$(readlink "$ROOT/current" 2>/dev/null || true)"
  set_status installing "$(basename "$PREV")"
  flip_current "$PREV"
  printf '%s' "${CUR_TARGET}" > "$PREV_FILE"   # allow rolling "forward" again
  if restart_and_verify "$(basename "$PREV")"; then
    finish_success "$(basename "$PREV")" "$ROOT/$PREV" "$CUR_TARGET"
  else
    set_status failed "$(basename "$PREV")" "Rollback target failed its health check."
    exit 1
  fi
  exit 0
fi

# ── Install mode ─────────────────────────────────────────────
URL="${1:-}"; VER="${2:-}"
if [ -z "$URL" ] || [ -z "$VER" ]; then
  set_status failed "" "usage: ramtech-ota-apply.sh <url> <version>"; exit 2
fi
DEST_REL="releases/$VER"
DEST="$ROOT/$DEST_REL"

set_status downloading "$VER"
TARBALL="$ROOT/ota/download.tar.gz"
if ! curl -fL --retry 3 -m 600 -o "$TARBALL" "$URL"; then
  set_status failed "$VER" "Download failed."; exit 1
fi

set_status installing "$VER"
rm -rf "$DEST.part" "$DEST"
mkdir -p "$DEST.part"
if ! tar -xzf "$TARBALL" -C "$DEST.part"; then
  rm -rf "$DEST.part"; set_status failed "$VER" "Archive extraction failed."; exit 1
fi
rm -f "$TARBALL"
if [ ! -f "$DEST.part/app/server.js" ] || [ ! -f "$DEST.part/admin/server.js" ]; then
  rm -rf "$DEST.part"; set_status failed "$VER" "Archive is missing app/ or admin/."; exit 1
fi
[ -f "$DEST.part/VERSION" ] || printf '%s\n' "$VER" > "$DEST.part/VERSION"
mv -T "$DEST.part" "$DEST"
link_shared "$DEST"

PREV_TARGET="$(readlink "$ROOT/current" 2>/dev/null || true)"
flip_current "$DEST_REL"

if restart_and_verify "$VER"; then
  # Record the rollback pointer only now — if the new release had failed, the
  # old pointer must survive so a later manual rollback still works.
  [ -n "$PREV_TARGET" ] && printf '%s' "$PREV_TARGET" > "$PREV_FILE"
  finish_success "$VER" "$DEST" "${PREV_TARGET:-}"
else
  # Health check failed → automatic rollback.
  if [ -n "$PREV_TARGET" ] && [ -d "$ROOT/$PREV_TARGET" ]; then
    flip_current "$PREV_TARGET"
    $RESTART_APP || true
    if health_check; then
      set_status rolledback "$VER" "New version failed its health check — rolled back to $(basename "$PREV_TARGET")."
    else
      set_status failed "$VER" "New version unhealthy AND rollback unhealthy — manual attention needed."
    fi
  else
    set_status failed "$VER" "New version failed its health check; no previous release to roll back to."
  fi
  exit 1
fi

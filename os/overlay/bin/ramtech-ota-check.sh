#!/usr/bin/env bash
# Daily OTA check (systemd timer: ramtech-ota-check.timer). Installs the newest
# GitHub release automatically — but only when auto-update is enabled in the
# admin UI (data/admin/settings.json: {"autoUpdate": true, "repo": "owner/name"}).
set -u

ROOT="${RAMTECH_ROOT:-/opt/ramtech}"
SETTINGS="$ROOT/data/admin/settings.json"
APPLY="$ROOT/bin/ramtech-ota-apply.sh"

[ -f "$SETTINGS" ] || { echo "no settings — skip"; exit 0; }
AUTO="$(jq -r '.autoUpdate // false' "$SETTINGS" 2>/dev/null)"
REPO="$(jq -r '.repo // empty' "$SETTINGS" 2>/dev/null)"
[ "$AUTO" = "true" ] || { echo "auto-update disabled — skip"; exit 0; }
[ -n "$REPO" ] || { echo "no repo configured — skip"; exit 0; }

CURRENT="$(cat "$ROOT/current/VERSION" 2>/dev/null || echo v0.0.0)"
REL_JSON="$(curl -fsS -m 20 -H 'accept: application/vnd.github+json' -H 'user-agent: ramtech-ota' \
  "https://api.github.com/repos/$REPO/releases/latest")" || { echo "GitHub unreachable"; exit 0; }

LATEST="$(printf '%s' "$REL_JSON" | jq -r '.tag_name // empty')"
URL="$(printf '%s' "$REL_JSON" | jq -r '[.assets[] | select(.name | startswith("ramtech-app-") and endswith(".tar.gz"))][0].browser_download_url // empty')"
SHA_URL="$(printf '%s' "$REL_JSON" | jq -r '[.assets[] | select(.name | startswith("ramtech-app-") and endswith(".tar.gz.sha256"))][0].browser_download_url // empty')"
if [ -z "$LATEST" ] || [ -z "$URL" ]; then echo "no usable release"; exit 0; fi

# The tag becomes a directory name the apply script rm -rf's as root. This path
# is unattended (a daily timer), so it gets the same check the UI path does.
case "$LATEST" in
  v[0-9]*.[0-9]*.[0-9]*|[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "refusing release tag \"$LATEST\" — expected a plain vX.Y.Z"; exit 0;;
esac
case "$LATEST" in
  */*|*..*) echo "refusing release tag \"$LATEST\" — path separators"; exit 0;;
esac

# Newest of the two versions, by version-sort. Equal → nothing to do.
HIGHEST="$(printf '%s\n%s\n' "${CURRENT#v}" "${LATEST#v}" | sort -V | tail -1)"
if [ "$HIGHEST" = "${CURRENT#v}" ]; then echo "up to date ($CURRENT)"; exit 0; fi

echo "updating $CURRENT → $LATEST"
if [ -n "$SHA_URL" ]; then
  exec "$APPLY" "$URL" "$LATEST" --sha256-url "$SHA_URL"
fi
exec "$APPLY" "$URL" "$LATEST"

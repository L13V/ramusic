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
[ -n "$LATEST" ] && [ -n "$URL" ] || { echo "no usable release"; exit 0; }

# Newest of the two versions, by version-sort. Equal → nothing to do.
HIGHEST="$(printf '%s\n%s\n' "${CURRENT#v}" "${LATEST#v}" | sort -V | tail -1)"
if [ "$HIGHEST" = "${CURRENT#v}" ]; then echo "up to date ($CURRENT)"; exit 0; fi

echo "updating $CURRENT → $LATEST"
exec "$APPLY" "$URL" "$LATEST"

#!/usr/bin/env bash
# Update AmoreChat from GitHub Releases, or switch to a specific version.
#   sudo bash deploy/update.sh            # latest release
#   sudo bash deploy/update.sh v0.1.0     # a specific version
#   sudo bash deploy/update.sh /root/new  # offline: a folder with files copied from Releases:
#                                         # amorechat-source.tar.gz + manifest.json + amorechat-app.tar.gz
#                                         # (+ the runtime/deps parts if they changed), or the full
#                                         # amorechat-offline-amd64.tar.gz
# After the first run you can simply use:  sudo amorechat-update [version]
# Your data (data/), settings (.env), Caddyfile and certs/ are kept.
# Everything runs inside main(), which bash parses fully before running:
# this script replaces itself mid-run when switching versions.
main() {
set -euo pipefail
cd "${AMORECHAT_DIR:-$(dirname "$0")/..}"

REPO="${AMORECHAT_REPO:-amor7/AmoreChat}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash deploy/update.sh [version]"
  exit 1
fi
command -v curl >/dev/null 2>&1 || apt-get install -y curl

TAG="${1:-}"
LOCAL=""
if [ -n "$TAG" ] && [ -d "$TAG" ]; then
  # Offline update from files copied to the server (no GitHub needed).
  LOCAL="$(cd "$TAG" && pwd)"
  [ -f "$LOCAL/amorechat-source.tar.gz" ] || { echo "!! $LOCAL/amorechat-source.tar.gz not found."; exit 1; }
  TAG="v$(tar xzOf "$LOCAL/amorechat-source.tar.gz" amorechat/package.json | grep -m1 '"version"' | cut -d'"' -f4)"
fi
if [ -z "$TAG" ]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)
  [ -n "$TAG" ] || { echo "!! Could not reach GitHub to find the latest version."; exit 1; }
fi
case "$TAG" in v*) ;; *) TAG="v${TAG}" ;; esac

CURRENT="v$(grep -m1 '"version"' package.json | sed -E 's/.*"([0-9][^"]*)".*/\1/')"
echo ">> Installed: ${CURRENT}   Target: ${TAG}"
if [ "$CURRENT" = "$TAG" ] && [ "${FORCE:-}" != "1" ]; then
  echo ">> Already on ${TAG}. (Use FORCE=1 to reinstall.)"
  exit 0
fi
LOWEST=$(printf '%s\n%s\n' "${CURRENT#v}" "${TAG#v}" | sort -V | head -n1)
if [ "$CURRENT" != "$TAG" ] && [ "$LOWEST" = "${TAG#v}" ]; then
  echo "!! ${TAG} is OLDER than ${CURRENT}. A newer database may not work with an older version."
  echo "   A backup is taken first; to restore it see README (Backup and restore)."
  read -rp "Continue with the downgrade? [y/N] " ok </dev/tty
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || exit 1
fi

if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  echo ">> Backing up the database..."
  docker compose exec -T app node server/src/backup-cli.js </dev/null || echo "!! Backup failed, continuing"
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/${REPO}/releases/download/${TAG}"

if [ -n "$LOCAL" ]; then
  cp "$LOCAL/amorechat-source.tar.gz" "$TMP/source.tar.gz"
else
  echo ">> Downloading ${TAG} source..."
  curl -fL --retry 3 -o "$TMP/source.tar.gz" "${BASE}/amorechat-source.tar.gz" || { echo "!! Version ${TAG} not found."; exit 1; }
fi
if [ -d .git ] && [ -z "$LOCAL" ]; then
  # Git checkout: move to the release tag so `git status` stays clean.
  git fetch -q --tags --force origin && git checkout -q -f "$TAG"
else
  # The archive holds code only, so data/, .env, Caddyfile and certs/ are untouched.
  tar xzf "$TMP/source.tar.gz" --strip-components=1
fi
# New versions may need new settings (e.g. the voice server secret); existing values are kept.
[ -f deploy/ensure-env.sh ] && bash deploy/ensure-env.sh

# Images. A release comes in parts (see deploy/make-release.sh): only what this server doesn't
# have yet is downloaded - usually just the app code (a few MB) instead of the whole ~185 MB.
# Downloads are kept in a cache and resume where they stopped if the connection drops.
CACHE=/var/cache/amorechat
mkdir -p "$CACHE"
# get <file>: from the local folder, or downloaded (resumable) from the release.
get() {
  if [ -n "$LOCAL" ]; then
    [ -f "$LOCAL/$1" ] && echo "$LOCAL/$1"
    return
  fi
  local out="$CACHE/$1"
  if [ -f "$out" ] && gzip -t "$out" 2>/dev/null; then echo "$out"; return; fi
  echo ">> Downloading $1..." >&2
  local i
  for i in 1 2 3 4 5; do
    curl -fL --retry 3 -C - -o "$out" "${BASE}/$1" >&2 && gzip -t "$out" 2>/dev/null && { echo "$out"; return; }
    echo "   (connection dropped; resuming...)" >&2
    sleep 3
  done
  rm -f "$out" # broken beyond resuming: start over next time
  return 1
}
jval() { grep -m1 "\"$1\"" "$2" | sed -E 's/.*: *"([^"]*)".*/\1/'; }

MANIFEST=""
if [ -n "$LOCAL" ]; then
  [ -f "$LOCAL/manifest.json" ] && MANIFEST="$LOCAL/manifest.json"
elif [ "$(uname -m)" = "x86_64" ] && curl -fsSL --retry 3 -o "$TMP/manifest.json" "${BASE}/manifest.json"; then
  MANIFEST="$TMP/manifest.json"
fi

LOADED=""
if [ -n "$MANIFEST" ]; then
  RUNTIME=$(jval runtime "$MANIFEST")
  DEPS=$(jval deps "$MANIFEST")
  NEED_DEPS=""
  for img in caddy livekit; do
    ref=$(jval "$img" "$MANIFEST")
    want=$(jval "${img}Id" "$MANIFEST")
    have=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)
    # The very same image may already be here under another name (e.g. caddy:2-alpine before
    # it was pinned): just give it the new name instead of downloading it again.
    if [ "$have" != "$want" ] && [ -n "$want" ] && docker image inspect "$want" >/dev/null 2>&1; then
      docker tag "$want" "$ref" && have=$want
    fi
    [ "$have" = "$want" ] || NEED_DEPS=1
  done
  if docker image inspect "amorechat-runtime:$RUNTIME" >/dev/null 2>&1; then
    echo ">> Runtime $RUNTIME already here (no download)"
  elif f=$(get "amorechat-runtime-$RUNTIME-amd64.tar.gz"); then
    gunzip -c "$f" | docker load
  else
    echo "!! This version needs amorechat-runtime-$RUNTIME-amd64.tar.gz (or the full amorechat-offline-amd64.tar.gz) from the release"
  fi
  if [ -z "$NEED_DEPS" ]; then
    echo ">> Caddy and LiveKit already up to date (no download)"
  elif f=$(get "amorechat-deps-$DEPS-amd64.tar.gz"); then
    gunzip -c "$f" | docker load
  else
    echo "!! New Caddy/LiveKit: also copy amorechat-deps-$DEPS-amd64.tar.gz from the release (the old ones keep working meanwhile)"
  fi
  if docker image inspect "amorechat-runtime:$RUNTIME" >/dev/null 2>&1 && f=$(get amorechat-app.tar.gz); then
    echo ">> Building the new version on this server (no internet needed)..."
    mkdir -p "$TMP/app"
    tar xzf "$f" -C "$TMP/app"
    docker build -q --build-arg "RUNTIME=$RUNTIME" -t amorechat:latest "$TMP/app" >/dev/null && LOADED=1
  fi
fi
if [ -z "$LOADED" ]; then
  # Older releases (one big file) or a folder holding only the full bundle.
  if [ -n "$LOCAL" ] && [ -f "$LOCAL/amorechat-offline-amd64.tar.gz" ]; then
    gunzip -c "$LOCAL/amorechat-offline-amd64.tar.gz" | docker load && LOADED=1
  elif [ -z "$LOCAL" ] && [ "$(uname -m)" = "x86_64" ] && f=$(get amorechat-offline-amd64.tar.gz); then
    gunzip -c "$f" | docker load && LOADED=1
  fi
fi
if [ -n "$LOADED" ]; then
  docker compose up -d --no-build --remove-orphans
  # Downloads are done with: free the cache; old images that nothing uses any more go too.
  rm -f "$CACHE"/*.tar.gz
  docker image prune -f >/dev/null 2>&1 || true
else
  echo ">> No prebuilt image for this server; building from source (needs Docker Hub + npm access)..."
  docker compose up -d --build --remove-orphans
fi

# Caddy reads its config only at start: pick up address changes from .env.
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || docker compose restart caddy >/dev/null 2>&1 || true
[ -f deploy/install-command.sh ] && bash deploy/install-command.sh . || true
echo ">> AmoreChat ${TAG} is running. Next time just run: sudo amorechat-update"
}

main "$@"
exit

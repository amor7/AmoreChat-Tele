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

REPO="${AMORECHAT_REPO:-amor7/AmoreChat-Tele}"

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

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/${REPO}/releases/download/${TAG}"
CACHE=/var/cache/amorechat
jval() { grep -m1 "\"$1\"" "$2" | sed -E 's/.*: *"([^"]*)".*/\1/'; }

# Free space, before the backup, the rollback copy and `docker load` write anything. The helper
# is found next to the code being updated (this script may run from a temp copy); installs from
# before it existed just skip the check. Exit 4 = nothing was changed (the panel shows "failed").
if [ -f deploy/disk-check.sh ]; then
  . deploy/disk-check.sh
  # The manifest says which image parts this update loads (same rules as the image section
  # below); online it is fetched now (a few hundred bytes) and reused there.
  PRE_MANIFEST=""
  if [ -n "$LOCAL" ]; then
    [ -f "$LOCAL/manifest.json" ] && PRE_MANIFEST="$LOCAL/manifest.json"
  elif [ "$(uname -m)" = "x86_64" ] && curl -fsSL --retry 3 --max-time 60 -o "$TMP/manifest.json" "${BASE}/manifest.json" 2>/dev/null; then
    PRE_MANIFEST="$TMP/manifest.json"
  fi
  # update_parts: the release files that will really be loaded, one per line.
  update_parts() {
    local m="$PRE_MANIFEST" img need_deps=""
    if [ -z "$m" ]; then
      echo amorechat-offline-amd64.tar.gz
      return 0
    fi
    docker image inspect "amorechat-runtime:$(jval runtime "$m")" >/dev/null 2>&1 || echo "amorechat-runtime-$(jval runtime "$m")-amd64.tar.gz"
    for img in caddy livekit; do
      docker image inspect "$(jval "$img" "$m")" >/dev/null 2>&1 || docker image inspect "$(jval "${img}Id" "$m")" >/dev/null 2>&1 || need_deps=1
    done
    [ -z "$need_deps" ] || echo "amorechat-deps-$(jval deps "$m")-amd64.tar.gz"
    echo amorechat-app.tar.gz
  }
  # part_mb <file>: its size in MB (rounded up): from the folder offline, online the
  # Content-Length of the release download (after redirects); nothing when it can't be known.
  part_mb() {
    if [ -n "$LOCAL" ]; then
      [ -f "$LOCAL/$1" ] && amore_size_mb "$LOCAL/$1"
      return 0
    fi
    local len
    len=$(curl -fsSIL --max-time 20 "${BASE}/$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }' || true)
    case "$len" in ''|0|*[!0-9]*) return 0 ;; esac
    echo $(( (len + 1048575) / 1048576 ))
  }
  LOAD_MB=0     # gzip size of everything `docker load`/`docker build` will unpack
  DOWNLOAD_MB=0 # what still has to be downloaded into the cache
  KNOWN=1
  for part in $(update_parts); do
    mb=$(part_mb "$part")
    if [ -z "$mb" ]; then KNOWN=""; continue; fi
    LOAD_MB=$(( LOAD_MB + mb ))
    # Already downloaded completely (kept from an earlier try): nothing more goes to the cache.
    if [ -z "$LOCAL" ] && ! { [ -f "$CACHE/$part" ] && gzip -t "$CACHE/$part" 2>/dev/null; }; then
      DOWNLOAD_MB=$(( DOWNLOAD_MB + mb ))
    fi
  done
  # A size that can't be known (no answer from the release, a part missing from the folder):
  # assume the full bundle (~200 MB).
  [ -n "$KNOWN" ] || { LOAD_MB=200; DOWNLOAD_MB=200; }
  # Images unpack to roughly 3x their gzip size. A usual app-only update is a few MB; the floor
  # is the room a build needs around it.
  DOCKER_NEED=$(( LOAD_MB * 3 ))
  [ "$DOCKER_NEED" -ge 300 ] || DOCKER_NEED=300
  # Project folder: the database backup (as big as the database) + the new code and its rollback
  # copy (that one is in the cache folder, usually on the same disk, where needs are added up).
  PROJECT_NEED=$(( 150 + $(amore_size_mb data/amorechat.db) ))
  # Cache: downloads are kept there (resumable), plus 20 %; offline nothing is downloaded.
  CACHE_NEED=0
  [ -n "$LOCAL" ] || CACHE_NEED=$(( (DOWNLOAD_MB * 12 + 9) / 10 ))
  if DOCKER_ROOT=$(amore_docker_root); then
    amore_disk_check "$PROJECT_NEED" "$PWD" "$CACHE_NEED" "$CACHE" "$DOCKER_NEED" "$DOCKER_ROOT" || exit 4
  else
    echo "!! هشدار: Docker در دسترس نیست؛ فضای پوشه‌ی Docker بررسی نشد." >&2
    amore_disk_check "$PROJECT_NEED" "$PWD" "$CACHE_NEED" "$CACHE" || exit 4
  fi
fi

if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  echo ">> Backing up the database..."
  docker compose exec -T app node server/src/backup-cli.js </dev/null || echo "!! Backup failed, continuing"
fi

# Release signature: SHA256SUMS signed with the project's key. It is checked with the key of the
# version installed NOW (before anything new is unpacked), and every file used below must match it,
# so files changed on the way (download, USB stick) are refused.
SIG="$TMP/sig"
mkdir -p "$SIG"
if [ -n "$LOCAL" ]; then
  cp "$LOCAL/SHA256SUMS" "$LOCAL/SHA256SUMS.sig" "$SIG/" 2>/dev/null || true
else
  curl -fsSL --retry 3 -o "$SIG/SHA256SUMS" "${BASE}/SHA256SUMS" 2>/dev/null && curl -fsSL --retry 3 -o "$SIG/SHA256SUMS.sig" "${BASE}/SHA256SUMS.sig" 2>/dev/null || true
fi
SIGNED=""
if [ -f "$SIG/SHA256SUMS.sig" ] && [ -f deploy/release-signing.pub ]; then
  # Offline: every file of the folder is checked now, before anything is unpacked.
  bash deploy/verify-release.sh "${LOCAL:-$SIG}" "$PWD/deploy/release-signing.pub" || exit 1
  SIGNED=1
elif [ -f deploy/release-signing.pub ] && [ "${AMORECHAT_ALLOW_UNSIGNED:-}" != "1" ]; then
  echo "!! ${TAG} has no release signature (SHA256SUMS + SHA256SUMS.sig)."
  [ -n "$LOCAL" ] && echo "   Copy those two files from the release next to the others."
  echo "   Only for a version from before signing: AMORECHAT_ALLOW_UNSIGNED=1 sudo amorechat-update ${TAG}"
  exit 1
fi
# check <name in the release> <file>: matches the signed list (when the release is signed).
check() {
  [ -n "$SIGNED" ] || return 0
  local want
  want=$(awk -v n="$1" '{ sub(/^\*/, "", $2) } $2 == n { print $1 }' "$SIG/SHA256SUMS")
  if [ -z "$want" ] || [ "$(sha256sum < "$2" | cut -d' ' -f1)" != "$want" ]; then
    echo "!! $1 does not match the signed release (changed or damaged); nothing was installed."
    rm -f "$CACHE/$1" 2>/dev/null || true
    exit 1
  fi
}
if [ -n "$LOCAL" ]; then
  cp "$LOCAL/amorechat-source.tar.gz" "$TMP/source.tar.gz"
else
  echo ">> Downloading ${TAG} source..."
  curl -fL --retry 3 -o "$TMP/source.tar.gz" "${BASE}/amorechat-source.tar.gz" || { echo "!! Version ${TAG} not found."; exit 1; }
fi
check amorechat-source.tar.gz "$TMP/source.tar.gz"

# What to go back to if the new version doesn't start: the code and scripts of now, and the app
# image. The database stays: changes to it only add things, which an older version ignores (and the
# backup above is there). data/, .env, Caddyfile and certs/ are not touched by updates anyway.
ROLLBACK=/var/cache/amorechat/rollback
CAN_GO_BACK=""
rm -rf "$ROLLBACK"
mkdir -p "$ROLLBACK"
if tar czf "$ROLLBACK/code.tar.gz" --exclude=./data --exclude=./certs --exclude=./.env --exclude=./Caddyfile --exclude=./node_modules --exclude=./.git . \
  && docker tag amorechat:latest amorechat:rollback 2>/dev/null; then
  CAN_GO_BACK=1
fi
# The app answers from inside its container with the version just installed: no network needed.
started_ok() {
  local i
  for i in $(seq 1 $(( ${HEALTH_WAIT:-180} / 5 ))); do
    if docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/config </dev/null 2>/dev/null | grep -q "\"version\":\"${TAG#v}\""; then
      return 0
    fi
    sleep 5
  done
  return 1
}
go_back() {
  echo "!! The new version did not start."
  if [ -z "$CAN_GO_BACK" ]; then
    echo "!! Nothing to go back to; see: docker compose logs app"
    exit 1
  fi
  echo "!! going back to ${CURRENT}..."
  tar xzf "$ROLLBACK/code.tar.gz"
  docker tag amorechat:rollback amorechat:latest
  # Recreated, or Docker just starts the same broken containers again.
  docker compose up -d --no-build --force-recreate --remove-orphans app ovpn
  docker compose up -d --no-build --remove-orphans
  if TAG="$CURRENT" started_ok; then
    echo "!! Back on ${CURRENT}. See the log above for what went wrong."
  else
    echo "!! ${CURRENT} did not come back either; see: docker compose logs app"
  fi
  exit 3
}

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
MANIFEST=""
if [ -n "$LOCAL" ]; then
  [ -f "$LOCAL/manifest.json" ] && MANIFEST="$LOCAL/manifest.json"
elif [ "$(uname -m)" = "x86_64" ] && { [ -s "$TMP/manifest.json" ] || curl -fsSL --retry 3 -o "$TMP/manifest.json" "${BASE}/manifest.json"; }; then
  MANIFEST="$TMP/manifest.json"
fi
[ -n "$MANIFEST" ] && check manifest.json "$MANIFEST"

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
    # Their versions are pinned, so the name and version are enough: the id can differ between
    # Docker versions, and loading the same file again would not change it.
    [ -n "$have" ] || NEED_DEPS=1
  done
  if docker image inspect "amorechat-runtime:$RUNTIME" >/dev/null 2>&1; then
    echo ">> Runtime $RUNTIME already here (no download)"
  elif f=$(get "amorechat-runtime-$RUNTIME-amd64.tar.gz"); then
    check "amorechat-runtime-$RUNTIME-amd64.tar.gz" "$f"
    gunzip -c "$f" | docker load
  else
    echo "!! This version needs amorechat-runtime-$RUNTIME-amd64.tar.gz (or the full amorechat-offline-amd64.tar.gz) from the release"
  fi
  if [ -z "$NEED_DEPS" ]; then
    echo ">> Caddy and LiveKit already up to date (no download)"
  elif f=$(get "amorechat-deps-$DEPS-amd64.tar.gz"); then
    check "amorechat-deps-$DEPS-amd64.tar.gz" "$f"
    gunzip -c "$f" | docker load
  else
    echo "!! New Caddy/LiveKit: also copy amorechat-deps-$DEPS-amd64.tar.gz from the release (the old ones keep working meanwhile)"
  fi
  if docker image inspect "amorechat-runtime:$RUNTIME" >/dev/null 2>&1 && f=$(get amorechat-app.tar.gz); then
    check amorechat-app.tar.gz "$f"
    echo ">> Building the new version on this server (no internet needed)..."
    mkdir -p "$TMP/app"
    tar xzf "$f" -C "$TMP/app"
    docker build -q --build-arg "RUNTIME=$RUNTIME" -t amorechat:latest "$TMP/app" >/dev/null && LOADED=1
  fi
fi
if [ -z "$LOADED" ]; then
  # Older releases (one big file) or a folder holding only the full bundle.
  if [ -n "$LOCAL" ] && [ -f "$LOCAL/amorechat-offline-amd64.tar.gz" ]; then
    check amorechat-offline-amd64.tar.gz "$LOCAL/amorechat-offline-amd64.tar.gz"
    gunzip -c "$LOCAL/amorechat-offline-amd64.tar.gz" | docker load && LOADED=1
  elif [ -z "$LOCAL" ] && [ "$(uname -m)" = "x86_64" ] && f=$(get amorechat-offline-amd64.tar.gz); then
    check amorechat-offline-amd64.tar.gz "$f"
    gunzip -c "$f" | docker load && LOADED=1
  fi
fi
if [ -n "$LOADED" ]; then
  docker compose up -d --no-build --remove-orphans || go_back
else
  echo ">> No prebuilt image for this server; building from source (needs Docker Hub + npm access)..."
  docker compose up -d --build --remove-orphans || go_back
fi
echo ">> Checking that the new version started..."
started_ok || go_back
# It works. Downloads are done with: free the cache; old images that nothing uses any more go too.
rm -f "$CACHE"/*.tar.gz
docker image prune -f >/dev/null 2>&1 || true

# Caddy reads its config only at start: pick up address changes from .env.
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || docker compose restart caddy >/dev/null 2>&1 || true
[ -f deploy/install-command.sh ] && bash deploy/install-command.sh . || true
echo ">> AmoreChat ${TAG} is running. Next time just run: sudo amorechat-update"
}

main "$@"
exit

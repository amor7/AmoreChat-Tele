#!/usr/bin/env bash
# Builds the release files into a folder (default: release-out). Run from the project folder
# after `npm ci` (and with android-dist/amorechat.apk in place, if any):
#   amorechat-app.tar.gz                     the app code (a few MB; every update downloads it)
#   amorechat-runtime-<id>-amd64.tar.gz      Node.js + ffmpeg + libraries (only when they change)
#   amorechat-deps-<id>-amd64.tar.gz         Caddy + LiveKit images (only when they change)
#   manifest.json                            which runtime/deps this version needs
#   amorechat-offline-amd64.tar.gz           everything in one file (new and fully offline installs)
set -euo pipefail
OUT=${1:-release-out}
mkdir -p "$OUT"
VERSION=$(node -p "require('./package.json').version")
CADDY=caddy:2.11.7-alpine
LIVEKIT=livekit/livekit-server:v1.13.7

# The runtime's id depends on the libraries only, not on our own version number (which every
# release changes): otherwise each update would download the runtime again.
RUNTIME=$(node -e "
const fs = require('fs');
const h = require('crypto').createHash('sha256');
const noVersion = (o) => (delete o.version, o);
const lock = noVersion(JSON.parse(fs.readFileSync('package-lock.json', 'utf8')));
for (const k of ['', 'server', 'web']) if (lock.packages[k]) noVersion(lock.packages[k]);
h.update(fs.readFileSync('Dockerfile.runtime'));
h.update(JSON.stringify(lock));
for (const f of ['package.json', 'server/package.json', 'web/package.json']) h.update(JSON.stringify(noVersion(JSON.parse(fs.readFileSync(f, 'utf8')))));
console.log(h.digest('hex').slice(0, 12));
")
echo ">> runtime $RUNTIME"
docker build -f Dockerfile.runtime -t "amorechat-runtime:$RUNTIME" .

[ -f web/dist/index.html ] || npm run build
APP=$(mktemp -d)
mkdir -p "$APP/web" "$APP/android-dist"
cp -r server "$APP/"
rm -rf "$APP/server/test" "$APP/server/node_modules"
cp -r web/dist "$APP/web/dist"
cp package.json CHANGELOG.md "$APP/"
if [ -f android-dist/amorechat.apk ]; then cp android-dist/amorechat.apk "$APP/android-dist/"; fi
cp deploy/Dockerfile.app "$APP/Dockerfile"
tar czf "$OUT/amorechat-app.tar.gz" -C "$APP" .
docker build --build-arg "RUNTIME=$RUNTIME" -t amorechat:latest "$APP"
rm -rf "$APP"

docker pull -q "$CADDY" >/dev/null
docker pull -q "$LIVEKIT" >/dev/null
CADDY_ID=$(docker image inspect -f '{{.Id}}' "$CADDY")
LIVEKIT_ID=$(docker image inspect -f '{{.Id}}' "$LIVEKIT")
DEPS=$(printf '%s%s' "$CADDY_ID" "$LIVEKIT_ID" | sha256sum | cut -c1-12)

docker save "amorechat-runtime:$RUNTIME" | gzip > "$OUT/amorechat-runtime-$RUNTIME-amd64.tar.gz"
docker save "$CADDY" "$LIVEKIT" | gzip > "$OUT/amorechat-deps-$DEPS-amd64.tar.gz"
# The full bundle also carries the runtime's tag, so the next update after a fresh install is small.
docker save amorechat:latest "amorechat-runtime:$RUNTIME" "$CADDY" "$LIVEKIT" | gzip > "$OUT/amorechat-offline-amd64.tar.gz"

cat > "$OUT/manifest.json" <<EOF
{
  "version": "$VERSION",
  "runtime": "$RUNTIME",
  "deps": "$DEPS",
  "caddy": "$CADDY",
  "caddyId": "$CADDY_ID",
  "livekit": "$LIVEKIT",
  "livekitId": "$LIVEKIT_ID"
}
EOF
ls -lh "$OUT"

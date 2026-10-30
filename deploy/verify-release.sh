#!/usr/bin/env bash
# Checks that release files really come from the AmoreChat release (and were not changed on the
# way, e.g. on a USB stick): SHA256SUMS must carry a valid signature of the project's release key,
# and every file of the folder that is listed there must match it.
#   bash deploy/verify-release.sh <folder with SHA256SUMS + SHA256SUMS.sig> [public key]
# Exits 1 on any problem.
set -euo pipefail
DIR="${1:?usage: verify-release.sh <folder> [public key]}"
PUB="${2:-$(cd "$(dirname "$0")" && pwd)/release-signing.pub}"

if [ ! -f "$DIR/SHA256SUMS" ] || [ ! -f "$DIR/SHA256SUMS.sig" ]; then
  echo "!! No signature in $DIR (SHA256SUMS and SHA256SUMS.sig from the release are needed)."
  exit 1
fi
[ -f "$PUB" ] || { echo "!! Release public key not found: $PUB"; exit 1; }
if ! openssl pkeyutl -verify -pubin -inkey "$PUB" -rawin -in "$DIR/SHA256SUMS" -sigfile "$DIR/SHA256SUMS.sig" >/dev/null 2>&1; then
  echo "!! The signature is NOT valid: these files were not made by the AmoreChat release, or were changed."
  exit 1
fi
bad=0
while read -r sum name; do
  name="${name#\*}"
  [ -f "$DIR/$name" ] || continue
  if [ "$(sha256sum < "$DIR/$name" | cut -d' ' -f1)" != "$sum" ]; then
    echo "!! $name does not match the signed release (changed or damaged)."
    bad=1
  fi
done < "$DIR/SHA256SUMS"
[ "$bad" = 0 ] || exit 1
echo ">> Release signature OK"

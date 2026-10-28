#!/usr/bin/env bash
# Builds docker-offline-ubuntu-<version>-amd64.tar.gz: Ubuntu's docker.io + docker-compose-v2
# packages with every dependency a fresh Ubuntu lacks, and install-docker.sh, for servers that
# can't reach any package repository. Needs Docker and internet (run in CI on each release).
#   bash deploy/make-docker-bundle.sh 24.04 [out-dir]
set -euo pipefail
V=$1
OUT=${2:-.}
NAME=docker-offline-ubuntu-$V-amd64
WORK=$(mktemp -d)
mkdir -p "$WORK/$NAME/debs"
docker run --rm -v "$WORK/$NAME/debs":/out "ubuntu:$V" bash -c '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install --download-only --no-install-recommends -y -qq docker.io docker-compose-v2 >/dev/null
  cp /var/cache/apt/archives/*.deb /out/
  chmod a+r /out/*.deb'
cp deploy/install-docker.sh "$WORK/$NAME/"
echo "$V" > "$WORK/$NAME/ubuntu-version"
cat > "$WORK/$NAME/README.txt" <<EOF
Docker + Docker Compose for Ubuntu $V (amd64), installable with no internet.
  tar xzf $NAME.tar.gz
  cd $NAME
  sudo bash install-docker.sh
Or put $NAME.tar.gz next to AmoreChat's install.sh: it uses it by itself.
EOF
tar czf "$OUT/$NAME.tar.gz" -C "$WORK" "$NAME"
ls -lh "$OUT/$NAME.tar.gz"
ls "$WORK/$NAME/debs" | sed 's/^/   /'
rm -rf "$WORK"

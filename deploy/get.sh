#!/usr/bin/env bash
# One-line fresh install of AmoreChat (latest, or a chosen version):
#   curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat/main/deploy/get.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat/main/deploy/get.sh | sudo bash -s -- v0.1.0
# Installs into ./amorechat (set AMORECHAT_DIR to change).
# Wrapped in main() so bash has the whole script before running it (it arrives through a pipe).
main() {
set -euo pipefail

REPO="${AMORECHAT_REPO:-amor7/AmoreChat}"
DIR="${AMORECHAT_DIR:-amorechat}"
TAG="${1:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo."
  exit 1
fi
command -v curl >/dev/null 2>&1 || { apt-get update && apt-get install -y curl; }

if [ -z "$TAG" ]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)
  [ -n "$TAG" ] || { echo "!! Could not reach GitHub to find the latest version."; exit 1; }
fi
case "$TAG" in v*) ;; *) TAG="v${TAG}" ;; esac

if [ -f "${DIR}/docker-compose.yml" ]; then
  echo "!! ${DIR} already exists. To update it run: cd ${DIR} && sudo bash deploy/update.sh ${TAG}"
  exit 1
fi

BASE="https://github.com/${REPO}/releases/download/${TAG}"
echo ">> Installing AmoreChat ${TAG} into ./${DIR}"
mkdir -p "$DIR"
curl -fL --retry 3 "${BASE}/amorechat-source.tar.gz" | tar xz -C "$DIR" --strip-components=1
if [ "$(uname -m)" = "x86_64" ]; then
  curl -fL --retry 3 -o "${DIR}/amorechat-offline-amd64.tar.gz" "${BASE}/amorechat-offline-amd64.tar.gz" || true
fi
cd "$DIR"
# Ask here (older versions' install.sh read the domain from stdin, which is this pipe).
if [ ! -f .env ]; then
  read -rp "Domain pointing to this server (e.g. chat.example.ir): " DOMAIN </dev/tty
  sed "s/^DOMAIN=.*/DOMAIN=${DOMAIN}/" .env.example > .env
fi
bash deploy/install.sh </dev/null
# The bundle is only needed once; updates download their own.
rm -f amorechat-offline-*.tar.gz
}

main "$@"

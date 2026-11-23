#!/usr/bin/env bash
# One-line fresh install of AmoreChat-Tele (latest, or a chosen version):
#   curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat-Tele/main/deploy/get.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat-Tele/main/deploy/get.sh | sudo bash -s -- v1.0.0
# Installs into ./amorechat-tele (set AMORECHAT_DIR to change).
main() {
set -euo pipefail

REPO="${AMORECHAT_REPO:-amor7/AmoreChat-Tele}"
DIR="${AMORECHAT_DIR:-amorechat-tele}"
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

# Free space before the ~200 MB bundle is downloaded: a full disk would leave a cut-off bundle
# that install.sh then fails on. Run through curl|bash, so a small copy of the check is kept here;
# keep in sync with deploy/disk-check.sh (install.sh then checks again with the real bundle size).
if [ "${SKIP_DISK_CHECK:-}" = "1" ]; then
  echo "!! هشدار: بررسی فضای دیسک رد شد (SKIP_DISK_CHECK=1)." >&2
else
  short=""
  # Install folder: the ~200 MB bundle + 20 % + 150 MB for the code. Docker: the bundle unpacks
  # to about 3x (a fresh install always loads all of it). A hung daemon is given 10 s.
  DROOT=""
  if command -v docker >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
      DROOT=$(timeout 10 docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
    else
      DROOT=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
    fi
  fi
  # <min_mb> <path>: the nearest existing parent is measured (df -Pk also works on busybox).
  for pair in "400 ${DIR}" "600 ${DROOT}"; do
    need=${pair%% *}; p=${pair#* }
    [ -n "$p" ] || continue
    case "${AMORECHAT_MIN_FREE_MB:-}" in ''|*[!0-9]*) ;; *) need=$AMORECHAT_MIN_FREE_MB ;; esac
    while [ ! -e "$p" ] && [ "$p" != "/" ] && [ "$p" != "." ]; do p=$(dirname "$p"); done
    free=$(df -Pk "$p" 2>/dev/null | awk 'NR==2 { print int($4 / 1024) }' || true)
    case "$free" in ''|*[!0-9]*) continue ;; esac
    if [ "$free" -lt "$need" ]; then
      echo "!! فضای دیسک کافی نیست: ${p}   آزاد: ${free} MB   لازم: حدود ${need} MB" >&2
      short=1
    fi
  done
  if [ -n "$short" ]; then
    echo "   هیچ چیزی نصب نشد. فضا آزاد کنید (docker image prune -f، rm -rf /var/cache/amorechat)" >&2
    echo "   یا با مسئولیت خودتان: ... | sudo SKIP_DISK_CHECK=1 bash   (یا عدد دیگر: sudo AMORECHAT_MIN_FREE_MB=... bash)" >&2
    exit 4
  fi
fi

BASE="https://github.com/${REPO}/releases/download/${TAG}"
echo ">> Installing AmoreChat-Tele ${TAG} into ./${DIR}"
mkdir -p "$DIR"
curl -fL --retry 3 "${BASE}/amorechat-source.tar.gz" | tar xz -C "$DIR" --strip-components=1 || \
  curl -fL --retry 3 "https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz" | tar xz -C "$DIR" --strip-components=1
if [ "$(uname -m)" = "x86_64" ]; then
  curl -fL --retry 3 -o "${DIR}/amorechat-offline-amd64.tar.gz" "${BASE}/amorechat-offline-amd64.tar.gz" || true
fi
cd "$DIR"
if [ ! -f .env ]; then
  read -rp "Domain pointing to this server (e.g. chat.example.ir): " DOMAIN </dev/tty
  sed "s/^DOMAIN=.*/DOMAIN=${DOMAIN}/" .env.example > .env
fi
bash deploy/install.sh </dev/null
rm -f amorechat-offline-*.tar.gz
}

main "$@"

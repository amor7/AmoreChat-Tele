#!/usr/bin/env bash
# Install or update AmoreChat on Ubuntu (22.04/24.04).
# Usage: sudo bash deploy/install.sh
#   Optional: sudo DOMAIN=chat.example.ir TLS_MODE=internal ALSO_IP=1 bash deploy/install.sh   (no questions)
# If an amorechat-offline-*.tar.gz bundle sits in the project folder, images are
# loaded from it, so no access to Docker Hub or npm is needed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash deploy/install.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  # Offline: the docker-offline-ubuntu-<version>-amd64.tar.gz release file next to this folder.
  . /etc/os-release
  DOCKER_BUNDLE=$(ls -t docker-offline-ubuntu-"${VERSION_ID:-}"-amd64.tar.gz ../docker-offline-ubuntu-"${VERSION_ID:-}"-amd64.tar.gz 2>/dev/null | head -n1 || true)
  if [ -n "$DOCKER_BUNDLE" ]; then
    echo ">> Installing Docker from ${DOCKER_BUNDLE} (no internet needed)..."
    bash deploy/install-docker.sh "$DOCKER_BUNDLE"
  else
    echo ">> Installing Docker from Ubuntu repositories..."
    echo "   (no internet/mirror? put docker-offline-ubuntu-${VERSION_ID:-<version>}-amd64.tar.gz from the release in this folder)"
    apt-get update
    apt-get install -y docker.io docker-compose-v2
    systemctl enable --now docker
  fi
fi

# ask "question" default: asks on the terminal (the question always shows, also when the script
# is piped or its output redirected); no terminal = the default answer.
ask() {
  local ans=""
  if { : </dev/tty; } 2>/dev/null; then
    printf '%s' "$1" >/dev/tty
    read -r ans </dev/tty || ans=""
  fi
  echo "${ans:-$2}"
}

if [ ! -f .env ]; then
  DOMAIN="${DOMAIN:-}"
  [ -n "$DOMAIN" ] || DOMAIN=$(ask "Domain or IP of this server (e.g. chat.example.ir or 185.1.2.3): " "")
  sed "s/^DOMAIN=.*/DOMAIN=${DOMAIN}/" .env.example > .env
  echo ">> Wrote .env"
fi

# SSL for a new install: Let's Encrypt needs international internet (now and for every renewal);
# "internal" is this server's own certificate authority and works fully offline, even on a bare IP;
# "off" is plain HTTP (chat works; calls and voice chats need HTTPS: browsers only allow the
# microphone on a secure connection).
DOMAIN_VAL=$(grep '^DOMAIN=' .env | cut -d= -f2)
IS_IP=0
[[ "$DOMAIN_VAL" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && IS_IP=1
if ! grep -q '^TLS_MODE=' .env; then
  if [ -z "${TLS_MODE:-}" ]; then
    echo "SSL (https):"
    if [ "$IS_IP" = 1 ]; then
      echo "  1) Server's own SSL - works fully offline; each device installs it once from http://${DOMAIN_VAL}/ca"
      echo "  2) No SSL (http)    - chat only: calls and voice chats need SSL"
      m=$(ask "Choose 1 or 2 [1]: " 1)
      if [ "$m" = "2" ]; then TLS_MODE=off; else TLS_MODE=internal; fi
    else
      echo "  1) Let's Encrypt    - needs international internet now and every ~60 days"
      echo "  2) Server's own SSL - works fully offline; each device installs it once from http://${DOMAIN_VAL}/ca"
      echo "  3) No SSL (http)    - chat only: calls and voice chats need SSL"
      m=$(ask "Choose 1, 2 or 3 [1]: " 1)
      case "$m" in 2) TLS_MODE=internal ;; 3) TLS_MODE=off ;; *) TLS_MODE=auto ;; esac
    fi
  fi
  echo "TLS_MODE=${TLS_MODE}" >> .env
  echo ">> SSL mode: ${TLS_MODE}"
fi

# A domain can also be reached by the server's IP: keeps working when the domain can't be
# resolved (its DNS hosted abroad during a shutdown) and when someone only knows the IP.
if [ "$IS_IP" = 0 ] && ! grep -q '^ALSO_IP=' .env; then
  if [ -z "${ALSO_IP:-}" ]; then
    a=$(ask "Also answer on this server's IP address (works even when the domain can't be found)? [Y/n]: " y)
    case "$a" in n | N) ALSO_IP=0 ;; *) ALSO_IP=1 ;; esac
  fi
  echo "ALSO_IP=${ALSO_IP}" >> .env
fi

mkdir -p data certs
# The app runs as uid 1000 (user "node") inside the container.
chown -R 1000:1000 data
bash deploy/ensure-env.sh

BUNDLE=$(ls -t amorechat-offline-*.tar.gz 2>/dev/null | head -n1 || true)
if [ -n "${BUNDLE}" ]; then
  echo ">> Loading images from ${BUNDLE}..."
  gunzip -c "${BUNDLE}" | docker load
  docker compose up -d --no-build
else
  # No offline bundle: build from the source in this folder (e.g. after `git pull`).
  echo ">> Building from source (needs Docker Hub + npm access)..."
  docker compose up -d --build
fi

bash deploy/install-command.sh .

# Wait for the app to be up (a fresh install prints the owner's setup code once it starts).
echo ">> Waiting for AmoreChat to start..."
for _ in $(seq 1 60); do
  if docker compose logs app 2>/dev/null | grep -qE "SETUP CODE|Server listening"; then break; fi
  sleep 1
done
sleep 1
docker compose ps
echo
D=$(grep ^DOMAIN= .env | cut -d= -f2)
MODE=$(grep ^TLS_MODE= .env | tail -n1 | cut -d= -f2)
PIP=$(grep ^PUBLIC_IP= .env | cut -d= -f2)
[[ "$D" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && [ "$MODE" = "auto" ] && MODE=internal
if [ "$MODE" = "off" ]; then MAIN="http://$D"; else MAIN="https://$D"; fi
echo "Addresses:"
echo "  $MAIN"
if grep -q '^ALSO_IP=1' .env && [ -n "$PIP" ] && [ "$PIP" != "$D" ]; then
  echo "  https://$PIP   (server's own SSL: install it once from http://$PIP/ca)"
  echo "  http://$PIP    (no SSL: chat only)"
fi
[ "$MODE" = "off" ] && echo "  (no SSL: chat works; calls and voice chats need SSL)"
echo
if docker compose logs app 2>/dev/null | grep -q "SETUP CODE"; then
  docker compose logs app | grep "SETUP CODE" | tail -n1
  echo "Open $MAIN and register the owner account with the code above."
else
  echo "Done. Open $MAIN"
  echo "(New server? The owner setup code: sudo docker compose logs app | grep 'SETUP CODE')"
fi
if [ "$MODE" = "internal" ]; then
  echo
  echo ">> Server's own SSL: on every phone/computer first open  http://$D/ca"
  echo "   and install the certificate (the Android app does not need it: http://$D/app)"
fi
echo "To update later run: sudo amorechat-update   (or a version: sudo amorechat-update v1.2.3)"
echo "Without GitHub access: copy the release files to a folder and run: sudo amorechat-update /path/to/folder"

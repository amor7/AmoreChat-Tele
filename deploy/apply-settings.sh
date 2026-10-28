#!/usr/bin/env bash
# After editing .env (DOMAIN, TLS_MODE, ALSO_IP, ALLOW_HTTP, PUBLIC_IP...) or replacing the files
# in certs/: apply everything without updating the version.
#   sudo bash deploy/apply-settings.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash deploy/apply-settings.sh"
  exit 1
fi
bash deploy/ensure-env.sh
docker compose up -d --no-build
# Caddy reads its config and certificate files only at start.
docker compose restart caddy >/dev/null
sleep 3
if docker compose logs caddy --since 10s 2>&1 | grep -qi '"level":"error"'; then
  echo "!! Caddy reported an error:"
  docker compose logs caddy --since 10s 2>&1 | grep -i '"level":"error"' | tail -5
  exit 1
fi
echo ">> Settings applied."

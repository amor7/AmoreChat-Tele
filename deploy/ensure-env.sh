#!/usr/bin/env bash
# Fills in settings newer versions need, without touching existing values.
# Called by install.sh and update.sh from the project folder.
set -euo pipefail

touch .env
has() { grep -q "^$1=." .env; }

if ! has LIVEKIT_API_SECRET; then
  sed -i '/^LIVEKIT_API_SECRET=/d' .env
  echo "LIVEKIT_API_SECRET=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')" >> .env
  echo ">> Generated a LiveKit secret in .env"
fi

if ! has PUBLIC_IP; then
  IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)
  sed -i '/^PUBLIC_IP=/d' .env
  echo "PUBLIC_IP=${IP}" >> .env
  echo ">> Detected server IP: ${IP:-unknown} (PUBLIC_IP in .env)"
  if [ -z "$IP" ] || echo "$IP" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'; then
    echo "!! That looks like a private address. Put the server's PUBLIC IP in .env (PUBLIC_IP=...)"
    echo "   or calls will not connect, then run: sudo docker compose up -d"
  fi
fi

if ! grep -q '^TLS_MODE=' .env; then
  echo "TLS_MODE=auto" >> .env
fi

# The Caddy config follows the address settings in .env (DOMAIN, TLS_MODE, ALSO_IP, ALLOW_HTTP).
bash deploy/caddy-config.sh

# Open the media ports on ufw if it is active (the provider's cloud firewall must be opened by hand).
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for p in 80/tcp 443/tcp 443/udp 7881/tcp 7882/udp 3478/udp; do ufw allow "$p" >/dev/null; done
  echo ">> ufw: opened 80, 443, 7881/tcp, 7882/udp, 3478/udp"
fi

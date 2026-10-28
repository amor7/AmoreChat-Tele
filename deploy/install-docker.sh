#!/usr/bin/env bash
# Installs Docker + Docker Compose with no internet, from the packages in a
# docker-offline-ubuntu-<version>-amd64.tar.gz release file (Ubuntu's own docker.io and
# docker-compose-v2 with everything they need).
#   sudo bash install-docker.sh                         (inside the unpacked folder), or
#   sudo bash deploy/install-docker.sh docker-offline-ubuntu-24.04-amd64.tar.gz
# Packages already on the server in the same or a newer version are left alone.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${1:-}" ]; then
  DIR=$(mktemp -d)
  tar xzf "$1" -C "$DIR"
  [ -d "$DIR/debs" ] || DIR="$DIR/$(ls "$DIR" | head -n1)"
fi
[ -d "$DIR/debs" ] || { echo "!! No debs/ folder found (unpack the docker-offline-*.tar.gz first)"; exit 1; }

# The packages were built for one Ubuntu version: say so if this server runs another.
. /etc/os-release
WANT=$(cat "$DIR/ubuntu-version" 2>/dev/null || echo "")
if [ -n "$WANT" ] && [ "${VERSION_ID:-}" != "$WANT" ]; then
  echo "!! These packages are for Ubuntu $WANT, this server runs ${PRETTY_NAME:-unknown}."
  echo "   Download docker-offline-ubuntu-${VERSION_ID:-?}-amd64.tar.gz instead."
  exit 1
fi

todo=()
for deb in "$DIR"/debs/*.deb; do
  pkg=$(dpkg-deb -f "$deb" Package)
  ver=$(dpkg-deb -f "$deb" Version)
  have=$(dpkg-query -W -f='${Status} ${Version}' "$pkg" 2>/dev/null || true)
  if [[ "$have" == "install ok installed "* ]] && dpkg --compare-versions "${have##* }" ge "$ver"; then
    continue
  fi
  todo+=("$deb")
done

if [ ${#todo[@]} -gt 0 ]; then
  echo ">> Installing ${#todo[@]} packages..."
  if ! dpkg -i "${todo[@]}"; then
    # Something that doesn't fit this server's other packages: Docker doesn't need it, so take
    # it back out instead of leaving dpkg (and apt) with half-installed packages.
    dpkg --configure -a || true
    broken=$(dpkg -l | awk '/^i[UF]/{print $2}' | grep -vE '^(docker|containerd|runc)' || true)
    if [ -n "$broken" ]; then
      echo ">> Not needed by Docker and could not be installed, removed again: $broken"
      # shellcheck disable=SC2086
      dpkg --remove $broken || true
    fi
  fi
else
  echo ">> All packages already installed"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker --version
docker compose version
echo ">> Docker is ready."

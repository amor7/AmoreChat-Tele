#!/usr/bin/env bash
# Updates asked for in the admin panel (owner only). The app cannot run Docker, so it writes
# data/update/request and the systemd path unit made by install-command.sh runs this, as root:
#   inspect  data/update/host.json: the version and the Docker images of this server (so the panel
#            can say which release files are still needed), and a copy of the release key
#   apply    installs the files uploaded to data/update/incoming with deploy/update.sh: the same
#            checks as by hand, the signature against the key of the version installed now
# Everything runs inside main(): update.sh replaces this file while it runs.
main() {
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
U="$DIR/data/update"
[ -f "$U/request" ] || exit 0
req=$(head -c 20 "$U/request" | tr -cd 'a-z')
rm -f "$U/request"

inspect() {
  cp "$DIR/deploy/release-signing.pub" "$U/release-signing.pub.tmp" 2>/dev/null && mv "$U/release-signing.pub.tmp" "$U/release-signing.pub"
  local version images
  version=$(grep -m1 '"version"' "$DIR/package.json" | cut -d'"' -f4)
  images=$(docker image ls --no-trunc --format '"{{.Repository}}:{{.Tag}} {{.ID}}"' 2>/dev/null | paste -sd, -)
  printf '{"at":%s,"version":"%s","images":[%s]}\n' "$(date +%s)" "$version" "$images" > "$U/host.json.tmp" && mv "$U/host.json.tmp" "$U/host.json"
  chmod 644 "$U/host.json" "$U/release-signing.pub" 2>/dev/null
}

case "$req" in
  inspect) inspect ;;
  apply)
    printf '{"state":"running","at":%s}\n' "$(date +%s)" > "$U/result.json"
    : > "$U/log.txt"
    chmod 644 "$U/result.json" "$U/log.txt"
    state=failed
    # No terminal: a downgrade question (update.sh) is answered "no".
    if AMORECHAT_DIR="$DIR" bash "$DIR/deploy/update.sh" "$U/incoming" </dev/null >> "$U/log.txt" 2>&1; then
      state=done
      rm -rf "$U/incoming"
    fi
    printf '{"state":"%s","at":%s}\n' "$state" "$(date +%s)" > "$U/result.json"
    chmod 644 "$U/result.json" "$U/log.txt"
    inspect
    ;;
esac
}
main "$@"

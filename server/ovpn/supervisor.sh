#!/bin/sh
# The "ovpn" service (docker-compose.yml): runs the admin's OpenVPN configs for the Tele VPN.
# The app writes data/ovpn/<id>/ (see server/src/tele/ovpn.js); for each one this runs openvpn with
# its own tunnel (ovpn<id>); up.sh then opens a SOCKS port (20000 + id) whose connections leave
# only through that tunnel. A changed "gen" restarts it, a removed folder stops it.
# Nothing else of the container goes through the tunnels (no routes are taken from the server).
D=/data/ovpn
RUN=/run/ovpn
mkdir -p "$RUN" /dev/net
[ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200
here=$(cd "$(dirname "$0")" && pwd)

stop() {
  id=$1
  [ -f "$RUN/$id.pid" ] && kill "$(cat "$RUN/$id.pid")" 2>/dev/null
  # openvpn runs down.sh on exit; this is for when it did not get to.
  [ -f "$RUN/$id.socks" ] && kill "$(cat "$RUN/$id.socks")" 2>/dev/null
  rm -f "$RUN/$id.pid" "$RUN/$id.gen" "$RUN/$id.socks"
}

start() {
  id=$1
  dir="$D/$id"
  auth=""
  [ -f "$dir/auth.txt" ] && auth="--auth-user-pass $dir/auth.txt"
  : > "$dir/log"
  # shellcheck disable=SC2086
  openvpn --config "$dir/client.ovpn" --dev "ovpn$id" --dev-type tun --route-nopull \
    --script-security 2 --up "/bin/sh $here/up.sh" --down "/bin/sh $here/down.sh" --setenv OVPN_ID "$id" \
    --verb 3 --connect-retry 5 60 --auth-nocache --auth-retry nointeract $auth >> "$dir/log" 2>&1 &
  echo $! > "$RUN/$id.pid"
  cat "$dir/gen" > "$RUN/$id.gen" 2>/dev/null
}

echo "ovpn: watching $D"
while :; do
  # Running ones whose folder is gone (proxy removed or turned off).
  for f in "$RUN"/*.pid; do
    [ -f "$f" ] || continue
    id=$(basename "$f" .pid)
    [ -f "$D/$id/client.ovpn" ] || { echo "ovpn: stop $id"; stop "$id"; }
  done
  for dir in "$D"/*/; do
    [ -f "$dir/client.ovpn" ] || continue
    id=$(basename "$dir")
    case "$id" in *[!0-9]*) continue ;; esac
    pid=$(cat "$RUN/$id.pid" 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      echo "ovpn: start $id"
      stop "$id"
      start "$id"
    elif [ "$(cat "$dir/gen" 2>/dev/null)" != "$(cat "$RUN/$id.gen" 2>/dev/null)" ]; then
      echo "ovpn: restart $id (changed)"
      stop "$id"
      sleep 1
      start "$id"
    fi
    # Keep the log small.
    if [ "$(wc -c < "$dir/log" 2>/dev/null || echo 0)" -gt 300000 ]; then tail -c 100000 "$dir/log" > "$dir/log.tmp" && cat "$dir/log.tmp" > "$dir/log" && rm -f "$dir/log.tmp"; fi
  done
  sleep 3
done

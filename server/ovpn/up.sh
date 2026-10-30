#!/bin/sh
# openvpn "up" (see supervisor.sh): what is bound to this tunnel goes through it (its own routing
# table, chosen by the outgoing interface), and a SOCKS server on port 20000 + id, with the password
# the app wrote, sends every connection out through this tunnel only.
set -e
id="$OVPN_ID"
dir="/data/ovpn/$id"
table=$((1000 + id))
port=$((20000 + id))
ip route replace default dev "$dev" table "$table"
ip -6 route replace default dev "$dev" table "$table" 2>/dev/null || true
ip rule del oif "$dev" table "$table" 2>/dev/null || true
ip rule add oif "$dev" table "$table"
pass=$(cat "$dir/socks.auth")
cat > "/run/ovpn/$id.json" <<EOF
{"log":{"level":"warn"},
 "inbounds":[{"type":"socks","tag":"in","listen":"0.0.0.0","listen_port":$port,"users":[{"username":"tele","password":"$pass"}]}],
 "outbounds":[{"type":"direct","tag":"vpn","bind_interface":"$dev"}],
 "route":{"final":"vpn"}}
EOF
sing-box run -c "/run/ovpn/$id.json" >> "$dir/log" 2>&1 &
echo $! > "/run/ovpn/$id.socks"
echo "${ifconfig_local:-up}" > "$dir/up"

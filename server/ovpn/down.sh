#!/bin/sh
# openvpn "down" (see up.sh): the SOCKS port and the routing rule of this tunnel go away.
id="$OVPN_ID"
rm -f "/data/ovpn/$id/up"
[ -f "/run/ovpn/$id.socks" ] && kill "$(cat "/run/ovpn/$id.socks")" 2>/dev/null
rm -f "/run/ovpn/$id.socks"
ip rule del oif "$dev" table $((1000 + id)) 2>/dev/null || true
exit 0

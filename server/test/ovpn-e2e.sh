#!/usr/bin/env bash
# OpenVPN for the Tele VPN, for real (compose job of ci.yml, with the stack running and the owner's
# cookie in /tmp/jar): a test OpenVPN server next to the stack, a .ovpn added in the admin API, the
# ovpn service connects it, its SOCKS port reaches a page that only exists inside the tunnel, and
# the app's own test reaches Telegram through it.
set -euo pipefail
ID=""
# On a failure: what each side saw.
dump() {
  rc=$?
  [ "$rc" = 0 ] && return
  echo "!! failed ($rc)"
  [ -n "$ID" ] && sudo tail -n 40 "data/ovpn/$ID/log" || true
  docker logs ovpn-test-server 2>&1 | tail -n 30 || true
  docker exec ovpn-test-server sh -c 'ip addr; netstat -ltn; ps' || true
  docker compose exec -T ovpn sh -c 'ip rule; ip route show table all | grep -v "^local\|ff00\|fe80"; netstat -ltn; ps' || true
}
trap dump EXIT
API=https://127.0.0.1/api
CURL=(curl -sS --cacert /tmp/ca.crt -b /tmp/jar -H 'x-requested-with: amorechat')
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(docker compose ps -q app)")
P=/tmp/ovpn-pki
rm -rf "$P" && mkdir -p "$P" && cd "$P"

# A small PKI: CA, server and client certificates.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=test-ca -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=server -keyout server.key -out server.csr 2>/dev/null
printf 'extendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile server.ext -out server.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=client -keyout client.key -out client.csr 2>/dev/null
printf 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n' > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile client.ext -out client.crt 2>/dev/null
chmod 644 ./*

cat > server.conf <<'EOF'
port 1194
proto udp
dev tun
ca /pki/ca.crt
cert /pki/server.crt
key /pki/server.key
dh none
server 10.8.0.0 255.255.255.0
topology subnet
keepalive 5 30
verb 3
EOF
# The server: OpenVPN, a page at 10.8.0.1:8080 (only reachable through the tunnel), and NAT so the
# tunnel also reaches the internet (Telegram).
docker rm -f ovpn-test-server >/dev/null 2>&1 || true
docker run -d --name ovpn-test-server --network "$NET" --cap-add NET_ADMIN --sysctl net.ipv4.ip_forward=1 -v "$P:/pki:ro" alpine:3.22 sh -c '
  apk add -q --no-cache openvpn iptables busybox-extras >/dev/null
  mkdir -p /dev/net /www && [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200
  echo "inside-the-tunnel" > /www/index.html
  iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -j MASQUERADE
  (until ip addr show tun0 2>/dev/null | grep -q 10.8.0.1; do sleep 1; done; httpd -f -p 10.8.0.1:8080 -h /www) &
  exec openvpn --config /pki/server.conf' >/dev/null

# The client file as a VPN seller would give it (with lines the app must drop).
{
  printf 'client\ndev tun\nproto udp\nremote ovpn-test-server 1194\nnobind\nremote-cert-tls server\nredirect-gateway def1\nscript-security 2\nup /bin/false\n'
  printf '<ca>\n%s\n</ca>\n<cert>\n%s\n</cert>\n<key>\n%s\n</key>\n' "$(cat ca.crt)" "$(cat client.crt)" "$(cat client.key)"
} > client.ovpn
BODY=$(python3 -c 'import json,sys; print(json.dumps({"name": "ovpn e2e", "openvpn": {"ovpn": open("client.ovpn").read()}}))')
cd - >/dev/null
R=$("${CURL[@]}" -H 'content-type: application/json' -d "$BODY" "$API/admin/tele/proxies")
echo "$R" | head -c 300; echo
ID=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["proxy"]["id"])')

echo ">> waiting for the tunnel (proxy $ID)"
for i in $(seq 1 60); do sudo test -f "data/ovpn/$ID/up" && break; sleep 2; done
docker compose logs ovpn --tail 20
sudo tail -n 30 "data/ovpn/$ID/log" || true
sudo test -f "data/ovpn/$ID/up" || { echo "!! the tunnel did not come up"; docker logs ovpn-test-server | tail -30; exit 1; }
echo ">> tunnel address: $(sudo cat "data/ovpn/$ID/up")"
# The dropped lines did not reach openvpn.
! sudo grep -E '^(up|script-security|redirect-gateway)' "data/ovpn/$ID/client.ovpn"

PASS=$(sudo cat "data/ovpn/$ID/socks.auth")
PORT=$((20000 + ID))
echo ">> the SOCKS port reaches the page inside the tunnel"
page=""
for i in 1 2 3 4 5 6; do
  page=$(docker run --rm --network "$NET" curlimages/curl:8.11.1 -sS --max-time 15 --socks5 "tele:$PASS@ovpn:$PORT" http://10.8.0.1:8080/) && break
  sleep 3
done
[ "$page" = "inside-the-tunnel" ] || { echo "!! got: $page"; exit 1; }
echo ">> without the password: refused"
! docker run --rm --network "$NET" curlimages/curl:8.11.1 -s --max-time 10 --socks5 "ovpn:$PORT" http://10.8.0.1:8080/
echo ">> the ovpn container itself does not route through the tunnel"
docker compose exec -T ovpn ip route | tee /tmp/routes.txt
! grep -qE '^(0\.0\.0\.0/1|128\.0\.0\.0/1|default .*ovpn)' /tmp/routes.txt

echo ">> the app's test: Telegram through the tunnel"
R=$("${CURL[@]}" -X POST -H 'content-type: application/json' -d '{}' --max-time 180 "$API/admin/tele/proxies/$ID/probe")
echo "$R" | head -c 400; echo
echo "$R" | grep -q '"lastStatus":"healthy"'

echo ">> turned off: the tunnel stops"
"${CURL[@]}" -X PATCH -H 'content-type: application/json' -d '{"enabled":false}' "$API/admin/tele/proxies/$ID" >/dev/null
for i in $(seq 1 20); do docker compose exec -T ovpn sh -c "ip link show ovpn$ID" >/dev/null 2>&1 || break; sleep 1; done
! docker compose exec -T ovpn sh -c "ip link show ovpn$ID" >/dev/null 2>&1
"${CURL[@]}" -X DELETE "$API/admin/tele/proxies/$ID" >/dev/null
docker rm -f ovpn-test-server >/dev/null
echo "OpenVPN e2e: passed"

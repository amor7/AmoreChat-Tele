#!/usr/bin/env bash
# Like a real user during a shutdown: get the server's certificate from http://<server>/ca.crt,
# trust it (browser + Node), then run the full end-to-end test against https://<server>.
# Usage: isolated-client.sh https://chat.test <setupCode>
set -euo pipefail
BASE="$1"
HOST="${BASE#https://}"
for i in $(seq 1 60); do curl -sf "http://${HOST}/ca.crt" -o /e2e/ca.crt && break; sleep 2; done
grep -q 'BEGIN CERTIFICATE' /e2e/ca.crt
mkdir -p "$HOME/.pki/nssdb"
certutil -d "sql:$HOME/.pki/nssdb" -N --empty-password 2>/dev/null || true
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n amorechat -i /e2e/ca.crt
echo ">> trusted the server CA"
for i in $(seq 1 60); do curl -sf --cacert /e2e/ca.crt "${BASE}/healthz" && break; sleep 2; done
echo
NODE_EXTRA_CA_CERTS=/e2e/ca.crt node rtc-e2e.mjs "$BASE" "$2"

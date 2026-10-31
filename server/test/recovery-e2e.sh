#!/usr/bin/env bash
# Getting out of trouble, for real (compose job of ci.yml, with the stack running and the owner's
# cookie in /tmp/jar): a backup is checked and restored from the panel, and a release that does not
# start is taken back by itself.
set -euo pipefail
API=https://127.0.0.1/api
CURL=(curl -sS --cacert /tmp/ca.crt -b /tmp/jar -H 'x-requested-with: amorechat')
JSON=(-H 'content-type: application/json')
trap 'rc=$?; [ "$rc" = 0 ] || { echo "!! failed ($rc)"; sudo cat data/update/log.txt 2>/dev/null | tail -30; docker compose logs app --tail 30; }' EXIT
up() { for i in $(seq 1 90); do curl -sf --cacert /tmp/ca.crt https://127.0.0.1/healthz >/dev/null && return 0; sleep 2; done; return 1; }

echo ">> a backup is made and checked"
CHAT=$("${CURL[@]}" "$API/chats" | python3 -c 'import json,sys; print([c["id"] for c in json.load(sys.stdin)["chats"] if c["type"]=="saved"][0])')
NAME=$("${CURL[@]}" -X POST "${JSON[@]}" -d '{}' "$API/admin/backups" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
"${CURL[@]}" -X POST "${JSON[@]}" -d '{}' "$API/admin/backups/$NAME/check" | tee /tmp/check.json; echo
grep -q '"ok":true' /tmp/check.json

echo ">> restoring: a wrong password is refused"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "${JSON[@]}" -d '{"password":"wrong"}' "$API/admin/backups/$NAME/restore")
[ "$code" = 403 ]

echo ">> a message after the backup is gone once it is restored"
"${CURL[@]}" -X POST "${JSON[@]}" -d '{"text":"after the backup"}' "$API/chats/$CHAT/messages" >/dev/null
"${CURL[@]}" -X POST "${JSON[@]}" -d '{"password":"Str0ng-Pass-77"}' "$API/admin/backups/$NAME/restore" | tee /tmp/restore.json; echo
grep -q '"ok":true' /tmp/restore.json
for i in $(seq 1 60); do sudo grep -q '"state":"restored"\|"state":"failed"' data/update/result.json 2>/dev/null && break; sleep 2; done
sudo cat data/update/result.json
sudo grep -q '"state":"restored"' data/update/result.json
up
! "${CURL[@]}" "$API/chats/$CHAT/messages" | grep -q 'after the backup'
sudo ls data/backups | grep -q '^before-restore-'

echo ">> a release that does not start: the old version comes back by itself"
want=$(curl -sf --cacert /tmp/ca.crt "$API/config" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
rm -rf /tmp/broken /tmp/brel
mkdir -p /tmp/broken /tmp/brel
git archive --format=tar --prefix=amorechat/ HEAD | tar x -C /tmp/broken
sed -i '1i throw new Error("broken on purpose");' /tmp/broken/amorechat/server/src/index.js
sed -i '0,/"version": "[^"]*"/s//"version": "99.0.0"/' /tmp/broken/amorechat/package.json
tar czf /tmp/brel/amorechat-source.tar.gz -C /tmp/broken amorechat
rc=0
sudo AMORECHAT_ALLOW_UNSIGNED=1 HEALTH_WAIT=60 bash deploy/update.sh /tmp/brel 2>&1 | tee /tmp/broken.log | tail -12 || rc=${PIPESTATUS[0]}
[ "$rc" = 3 ] || { echo "!! update ended with $rc, expected 3"; exit 1; }
grep -q "Back on" /tmp/broken.log
up
curl -sf --cacert /tmp/ca.crt "$API/config" | grep -q "\"version\":\"$want\""
grep -q "\"version\": \"$want\"" package.json
! grep -q 'broken on purpose' server/src/index.js
echo "Recovery e2e: passed"

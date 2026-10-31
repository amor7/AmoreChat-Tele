#!/usr/bin/env bash
# Restarts the app only when it is really stuck (the process runs but stops answering on the server
# itself), and only rarely. A systemd timer runs this every minute (see install-command.sh).
# It looks at Docker's own health check of the app, which never leaves the server: no internet,
# VPN, Telegram or proxy state plays any part, so an outage of those can never cause a restart.
# It does nothing while an update runs, while the server is overloaded (a restart would add load),
# right after a start, or more than a few times a day; then it leaves the app alone and tells the owner.
set -uo pipefail
DIR="${AMORECHAT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$DIR" || exit 0
STATE="${WATCHDOG_STATE:-$DIR/data/watchdog}"
FAIL_STREAK="${WATCHDOG_STREAK:-10}"    # failed checks in a row (Docker checks every 30 s): 5 minutes
UP_MIN="${WATCHDOG_UP_MIN:-600}"        # seconds since the app started before it is judged
COOLDOWN="${WATCHDOG_COOLDOWN:-1800}"   # seconds between restarts
MAX_DAY="${WATCHDOG_MAX_DAY:-3}"        # restarts in 24 hours
now=$(date +%s)

log() {
  mkdir -p "$STATE"
  echo "$(date -u +%FT%TZ) $*" >> "$STATE/log"
  tail -n 200 "$STATE/log" > "$STATE/log.tmp" && mv "$STATE/log.tmp" "$STATE/log"
}

# An update or restore replaces the app on purpose.
[ -f data/update/request ] && exit 0
grep -qE '"state":"(running|queued)"' data/update/result.json 2>/dev/null && exit 0

cid=$(docker compose ps -q app 2>/dev/null) || exit 0
[ -n "$cid" ] || exit 0 # stopped on purpose, or Docker is not answering: not ours to touch
info=$(docker inspect -f '{{.State.Status}} {{.State.StartedAt}} {{if .State.Health}}{{.State.Health.Status}} {{.State.Health.FailingStreak}}{{else}}none 0{{end}}' "$cid" 2>/dev/null) || exit 0
read -r status started health streak <<< "$info"
# Not running: Docker's own restart policy handles that.
[ "$status" = running ] || exit 0
[ "$health" = unhealthy ] || exit 0
[ "${streak:-0}" -ge "$FAIL_STREAK" ] || exit 0
started_at=$(date -d "$started" +%s 2>/dev/null || echo "$now")
[ $((now - started_at)) -ge "$UP_MIN" ] || exit 0

# Too busy to answer is not stuck, and a restart would make it worse.
load="${WATCHDOG_LOAD:-$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)}"
cores=$(nproc 2>/dev/null || echo 1)
if [ "${load%%.*}" -ge $((cores * 3)) ]; then
  log "not restarting: server overloaded (load $load, $cores cores)"
  exit 0
fi

mkdir -p "$STATE"
recent=""
[ -f "$STATE/restarts" ] && recent=$(awk -v t=$((now - 86400)) '$1 > t' "$STATE/restarts")
last=$(printf '%s\n' "$recent" | tail -n 1)
if [ -n "$last" ] && [ $((now - last)) -lt "$COOLDOWN" ]; then
  exit 0
fi
count=$(printf '%s' "$recent" | grep -c . || true)
if [ "$count" -ge "$MAX_DAY" ]; then
  log "not restarting: already $count times in 24 hours"
  printf 'برنامه روی سرور جواب نمی‌دهد و نگهبان در ۲۴ ساعت گذشته %s بار آن را ری‌استارت کرده؛ دیگر کاری نمی‌کند تا بررسی شود.\n' "$count" > "$STATE/note"
  exit 0
fi

log "app stuck ($streak failed checks): restarting"
{ [ -n "$recent" ] && printf '%s\n' "$recent"; echo "$now"; } > "$STATE/restarts"
printf 'برنامه روی سرور گیر کرده بود و نگهبان یک بار آن را ری‌استارت کرد.\n' > "$STATE/note"
docker compose restart app >> "$STATE/log" 2>&1
chown -R 1000:1000 "$STATE" 2>/dev/null || true
exit 0

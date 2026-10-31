#!/usr/bin/env bash
# deploy/watchdog.sh with a stand-in for Docker: when it restarts the app, and when it must not.
# Usage: bash server/test/watchdog.test.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/app/data/update"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
# compose ps -q app / inspect / compose restart app
case "$*" in
  "compose ps -q app") [ "${FAKE_STOPPED:-}" = 1 ] || echo abc123 ;;
  inspect*) echo "${FAKE_INFO}" ;;
  "compose restart app") echo restarted >> "$FAKE_LOG" ;;
esac
EOF
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" FAKE_LOG="$T/restarts.log" AMORECHAT_DIR="$T/app" WATCHDOG_STATE="$T/state" WATCHDOG_LOAD=0.1
old=$(date -u -d '-1 hour' +%FT%TZ)
young=$(date -u -d '-1 minute' +%FT%TZ)
stuck="running $old unhealthy 12"

run() { bash "$ROOT/deploy/watchdog.sh"; }
restarts() { [ -f "$FAKE_LOG" ] && grep -c . "$FAKE_LOG" || echo 0; }
reset() { rm -rf "$T/state" "$FAKE_LOG" "$T/app/data/update/"*; }
expect() { # name, expected restarts
  [ "$(restarts)" = "$2" ] || { echo "FAILED: $1: $(restarts) restarts, expected $2"; exit 1; }
  echo "- $1"
}

FAKE_INFO="running $old healthy 0" run; expect 'healthy: nothing' 0
FAKE_INFO="running $old unhealthy 3" run; expect 'a short hiccup: nothing' 0
FAKE_INFO="running $young unhealthy 12" run; expect 'just started: nothing' 0
FAKE_INFO="restarting $old unhealthy 12" run; expect 'not running: left to Docker' 0
FAKE_INFO="running $old none 0" run; expect 'no health check: nothing' 0
FAKE_STOPPED=1 FAKE_INFO="$stuck" run; expect 'stopped on purpose: nothing' 0

echo '{"state":"running","at":1}' > "$T/app/data/update/result.json"
FAKE_INFO="$stuck" run; expect 'while updating: nothing' 0
reset

WATCHDOG_LOAD=500.0 FAKE_INFO="$stuck" run; expect 'server overloaded: nothing' 0
reset

FAKE_INFO="$stuck" run; expect 'really stuck: one restart' 1
[ -s "$T/state/note" ] || { echo 'FAILED: no note for the owner'; exit 1; }
FAKE_INFO="$stuck" run; expect 'right after a restart: waits' 1

now=$(date +%s)
reset
mkdir -p "$T/state"
printf '%s\n%s\n%s\n' $((now - 20000)) $((now - 15000)) $((now - 10000)) > "$T/state/restarts"
FAKE_INFO="$stuck" run; expect 'three restarts in a day: stops' 0
grep -q 'دیگر کاری نمی‌کند' "$T/state/note" || { echo 'FAILED: owner not told it gave up'; exit 1; }

reset
mkdir -p "$T/state"
printf '%s\n' $((now - 90000)) > "$T/state/restarts"
FAKE_INFO="$stuck" run; expect 'yesterday does not count' 1
! grep -rEi 'telegram|vpn|sing-box|proxy|curl|ping ' <(grep -v '^#' "$ROOT/deploy/watchdog.sh" | grep -v "^  *#") || { echo 'FAILED: the watchdog looks at the network'; exit 1; }
echo 'watchdog: all checks passed'

#!/bin/bash
# A bad network for the soak test: only the app's and LiveKit's ports on loopback (not the test's
# own browser control), cycling through phases like a weak mobile link, with full cuts.
# The phase name goes in $PHASE_FILE, so the report can tell which problems came with which phase.
# Usage: sudo PHASE_FILE=/tmp/netphase bash server/test/netem.sh
set -u
PHASE_FILE=${PHASE_FILE:-/tmp/netphase}
APP_PORT=${APP_PORT:-3101}

tc qdisc del dev lo root 2>/dev/null
# Four bands; normal traffic never lands in the fourth, which is the slow one.
tc qdisc add dev lo root handle 1: prio bands 4 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1
tc qdisc add dev lo parent 1:4 handle 40: netem delay 0ms
for port in "$APP_PORT" 7880 7881 7882 3478; do
  for dir in dport sport; do
    tc filter add dev lo parent 1: protocol ip prio 1 u32 match ip "$dir" "$port" 0xffff flowid 1:4
  done
done

phase() {
  echo "$1" > "$PHASE_FILE"
  shift
  tc qdisc change dev lo parent 1:4 handle 40: netem "$@"
}
cut() {
  phase outage loss 100%
  sleep "$1"
}

trap 'tc qdisc del dev lo root 2>/dev/null; echo off > "$PHASE_FILE"' EXIT
while true; do
  phase good delay 0ms
  sleep 300
  phase mobile delay 150ms 50ms loss 1%
  sleep 420
  cut 20
  phase bad delay 600ms 200ms loss 5%
  sleep 300
  cut 45
  phase bad delay 600ms 200ms loss 5%
  sleep 240
  phase terrible delay 1500ms 500ms loss 10% rate 256kbit
  sleep 240
  cut 90
done

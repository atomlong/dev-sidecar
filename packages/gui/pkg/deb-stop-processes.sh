#!/bin/sh

set -u

binary_pattern='/opt/dev-sidecar/@docmirrordev-sidecar-gui'

if ! command -v pgrep >/dev/null 2>&1; then
  exit 0
fi

find_pids() {
  pgrep -f "$binary_pattern" 2>/dev/null || true
}

pids="$(find_pids)"
if [ -z "$pids" ]; then
  exit 0
fi

kill $pids 2>/dev/null || true

attempt=0
while [ "$attempt" -lt 5 ]; do
  pids="$(find_pids)"
  if [ -z "$pids" ]; then
    exit 0
  fi

  sleep 1
  attempt=$((attempt + 1))
done

pids="$(find_pids)"
if [ -n "$pids" ]; then
  kill -KILL $pids 2>/dev/null || true
fi

exit 0
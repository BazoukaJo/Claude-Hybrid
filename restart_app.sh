#!/usr/bin/env bash
# restart_app.sh — stop + start Claude Hybrid Router on Linux / macOS
# Equivalent to restart_app.bat on Windows.
#
# Usage:
#   ./restart_app.sh
#   ROUTER_PORT=9000 ./restart_app.sh

set -euo pipefail
cd "$(dirname "$0")"

ROUTER_PORT="${ROUTER_PORT:-8082}"

# Stop without reverting env (router is coming right back)
./stop_app.sh keepenv || true

# Wait until the port is fully released (up to 15 s)
echo "Waiting for port ${ROUTER_PORT} to be released..."
for _i in $(seq 1 30); do
  if command -v lsof &>/dev/null; then
    [ -z "$(lsof -ti "tcp:${ROUTER_PORT}" 2>/dev/null)" ] && break
  else
    break   # can't check; proceed optimistically
  fi
  sleep 0.5
done

if command -v lsof &>/dev/null && [ -n "$(lsof -ti "tcp:${ROUTER_PORT}" 2>/dev/null)" ]; then
  echo "ERROR: Port ${ROUTER_PORT} is still in use after stop. Aborting restart." >&2
  exit 1
fi

echo "Port ${ROUTER_PORT} is free. Starting router..."
./start_app.sh

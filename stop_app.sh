#!/usr/bin/env bash
# stop_app.sh — stop Claude Hybrid Router on Linux / macOS and (by default) clear the proxy URL
# Equivalent to stop_app.bat on Windows.
#
# Usage:
#   ./stop_app.sh            stop router AND revert ANTHROPIC_BASE_URL to cloud
#   ./stop_app.sh keepenv    stop router only (keep ANTHROPIC_BASE_URL pointing at router)
#   ROUTER_PORT=9000 ./stop_app.sh

set -euo pipefail
cd "$(dirname "$0")"

ROUTER_PORT="${ROUTER_PORT:-8082}"
KEEP_ENV="${1:-}"
EC=0

# ── Find PID listening on ROUTER_PORT ───────────────────────────────────────
_pid_on_port() {
  local port="$1"
  if command -v lsof &>/dev/null; then
    lsof -ti "tcp:${port}" 2>/dev/null | head -1 || true
    return
  fi
  # Fallback: ss (Linux)
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null \
      | grep ":${port} " \
      | grep -oP 'pid=\K[0-9]+' \
      | head -1 || true
    return
  fi
}

PID="$(_pid_on_port "${ROUTER_PORT}")"

if [ -n "${PID}" ]; then
  echo "Stopping router (PID ${PID}) on port ${ROUTER_PORT}..."
  kill "${PID}" 2>/dev/null || true

  # Wait up to 5 s for the port to be released
  for _i in $(seq 1 10); do
    sleep 0.5
    [ -z "$(_pid_on_port "${ROUTER_PORT}")" ] && break
  done

  # Force-kill if still alive
  if [ -n "$(_pid_on_port "${ROUTER_PORT}")" ]; then
    echo "WARNING: graceful shutdown timed out — sending SIGKILL..." >&2
    kill -9 "${PID}" 2>/dev/null || true
    EC=1
  else
    echo "Router stopped."
  fi
else
  echo "No router process found on port ${ROUTER_PORT}."
fi

# ── Revert proxy env (default) ──────────────────────────────────────────────
if [ "${KEEP_ENV}" = "keepenv" ]; then
  exit "${EC}"
fi

echo ""
echo "Clearing hybrid proxy (Claude settings.json, VS Code terminal env)..."
echo "Claude Code will use cloud until you start the router again (./start_app.sh)."

if ! command -v node &>/dev/null; then
  echo "WARNING: node not found — revert ANTHROPIC_BASE_URL manually:" >&2
  echo "  Delete env.ANTHROPIC_BASE_URL from ~/.claude/settings.json" >&2
  EC=1
else
  node scripts/revert-claude-hybrid-env.js || EC=1
fi

exit "${EC}"

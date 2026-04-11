#!/usr/bin/env bash
# start_app.sh — start Claude Hybrid Router on Linux / macOS
# Equivalent to start_app.bat on Windows.
#
# Usage:
#   ./start_app.sh          start router on default port 8082
#   ROUTER_PORT=9000 ./start_app.sh
#
# After Ctrl+C (or crash), run ./stop_app.sh to clear ANTHROPIC_BASE_URL so
# Claude Code falls back to Anthropic cloud while the router is down.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f "package.json" ]; then
  echo "ERROR: package.json not found. Keep this file in the Claude-Hybrid repo root." >&2
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: node not found in PATH. Install Node.js 18+ and retry." >&2
  exit 1
fi

ROUTER_PORT="${ROUTER_PORT:-8082}"

# ── Already running? sync env and exit ──────────────────────────────────────
_is_healthy() {
  command -v curl &>/dev/null || return 1
  curl -sf --max-time 2 "http://127.0.0.1:${ROUTER_PORT}/api/health" 2>/dev/null \
    | grep -q '"healthy"'
}

if _is_healthy; then
  echo "Claude Hybrid router is already listening on port ${ROUTER_PORT}."
  echo "Syncing hybrid env (merge-claude-hybrid-env)..."
  node scripts/merge-claude-hybrid-env.js
  exit 0
fi

# ── Port conflict check ──────────────────────────────────────────────────────
_pid_on_port() {
  if command -v lsof &>/dev/null; then
    lsof -ti "tcp:${1}" 2>/dev/null | head -1 || true
  fi
}

PORT_PID="$(_pid_on_port "${ROUTER_PORT}")"
if [ -n "${PORT_PID}" ]; then
  echo "ERROR: Port ${ROUTER_PORT} is already in use by PID ${PORT_PID}." >&2
  echo "       Stop that process or use a different ROUTER_PORT." >&2
  exit 1
fi

# ── Apply proxy env ──────────────────────────────────────────────────────────
echo "Applying hybrid routing: ANTHROPIC_BASE_URL -> http://127.0.0.1:${ROUTER_PORT} ..."
if ! node scripts/merge-claude-hybrid-env.js; then
  echo "WARNING: merge-claude-hybrid-env.js failed. Run: npm run merge-env" >&2
fi

# ── Start router (foreground) ────────────────────────────────────────────────
echo "Starting Claude Hybrid Router on port ${ROUTER_PORT}..."
echo "Press Ctrl+C to stop. Run ./stop_app.sh after exit to point Claude Code back at cloud."
echo ""
node router/server.js

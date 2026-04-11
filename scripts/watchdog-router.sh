#!/usr/bin/env bash
# watchdog-router.sh — auto-restart Claude Hybrid Router on Linux / macOS
# Equivalent to watchdog-router.ps1 on Windows.
#
# Monitors the router every 30 s. On failure it tries to restart. After
# MAX_CONSECUTIVE_FAILURES it gives up and reverts ANTHROPIC_BASE_URL so
# Claude Code falls back to Anthropic cloud (zero downtime, zero intervention).
#
# ── Setup ────────────────────────────────────────────────────────────────────
#
# macOS (launchd) — recommended:
#   1. Create ~/Library/LaunchAgents/com.claude-hybrid.watchdog.plist with:
#      <?xml version="1.0" encoding="UTF-8"?>
#      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
#        "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
#      <plist version="1.0"><dict>
#        <key>Label</key><string>com.claude-hybrid.watchdog</string>
#        <key>ProgramArguments</key><array>
#          <string>/bin/bash</string>
#          <string>/path/to/Claude-Hybrid/scripts/watchdog-router.sh</string>
#        </array>
#        <key>RunAtLoad</key><true/>
#        <key>KeepAlive</key><false/>
#        <key>StandardOutPath</key><string>/Users/YOU/.claude/watchdog.log</string>
#        <key>StandardErrorPath</key><string>/Users/YOU/.claude/watchdog.log</string>
#      </dict></plist>
#   2. launchctl load ~/Library/LaunchAgents/com.claude-hybrid.watchdog.plist
#
# Linux (cron) — simplest:
#   crontab -e
#   @reboot /bin/bash /path/to/Claude-Hybrid/scripts/watchdog-router.sh &
#
# Linux (systemd user service) — more robust:
#   See README.md § Autostart.
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   bash scripts/watchdog-router.sh [/path/to/start_app.sh]

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
START_SCRIPT="${1:-${REPO_ROOT}/start_app.sh}"
ROUTER_PORT="${ROUTER_PORT:-8082}"
LOG_FILE="${HOME}/.claude/watchdog.log"
MAX_CONSECUTIVE_FAILURES=3
CHECK_INTERVAL_SECONDS=30
RESTART_GRACE_SECONDS=20   # wait after restart before next health check

mkdir -p "$(dirname "${LOG_FILE}")"

_ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

_log() {
  local level="$1" msg="$2"
  local line
  line="$(_ts) [${level}] ${msg}"
  echo "${line}"
  echo "${line}" >> "${LOG_FILE}"
}

_is_healthy() {
  command -v curl &>/dev/null || return 1
  curl -sf --max-time 3 \
    "http://127.0.0.1:${ROUTER_PORT}/api/health" 2>/dev/null \
    | grep -q '"healthy"'
}

_restart_router() {
  if [ ! -f "${START_SCRIPT}" ]; then
    _log "ERROR" "start script not found: ${START_SCRIPT}"
    return 1
  fi
  # Run in background, detached from this watchdog process
  nohup bash "${START_SCRIPT}" >> "${LOG_FILE}" 2>&1 &
  disown
  _log "INFO" "Router restart initiated (background)"
}

_revert_env() {
  if command -v node &>/dev/null && [ -f "${REPO_ROOT}/scripts/revert-claude-hybrid-env.js" ]; then
    _log "WARN" "Reverting ANTHROPIC_BASE_URL — Claude Code will fall back to cloud"
    node "${REPO_ROOT}/scripts/revert-claude-hybrid-env.js" >> "${LOG_FILE}" 2>&1 || true
  else
    _log "WARN" "Could not revert env (node not found or revert script missing). Remove env.ANTHROPIC_BASE_URL from ~/.claude/settings.json manually."
  fi
}

# ── Main loop ─────────────────────────────────────────────────────────────────
consecutive_failures=0
_log "INFO" "Watchdog started — router port ${ROUTER_PORT}, check every ${CHECK_INTERVAL_SECONDS}s (max ${MAX_CONSECUTIVE_FAILURES} consecutive failures)"

while true; do
  sleep "${CHECK_INTERVAL_SECONDS}"

  if _is_healthy; then
    if [ "${consecutive_failures}" -gt 0 ]; then
      _log "INFO" "Router is healthy again (was ${consecutive_failures} consecutive failure(s))"
    fi
    consecutive_failures=0
    continue
  fi

  consecutive_failures=$(( consecutive_failures + 1 ))
  _log "WARN" "Health check failed (${consecutive_failures}/${MAX_CONSECUTIVE_FAILURES})"

  if [ "${consecutive_failures}" -ge "${MAX_CONSECUTIVE_FAILURES}" ]; then
    _log "ERROR" "Router down after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Reverting env and exiting watchdog."
    _revert_env
    _log "INFO" "Watchdog exiting. Restart manually: ./start_app.sh  (and then re-launch this watchdog)"
    exit 1
  fi

  _restart_router
  # Brief grace period before next health check so the router has time to bind its port
  sleep "${RESTART_GRACE_SECONDS}"
done

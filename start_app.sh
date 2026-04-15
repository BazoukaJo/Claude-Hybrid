#!/usr/bin/env bash
# start_app.sh — start Claude Hybrid Router on Linux / macOS
#
# Auto-installs Ollama if missing, starts the service if not running,
# pulls a starter model if the library is empty, then launches the router.
#
# Usage:
#   ./start_app.sh              start router on default port 8082
#   ROUTER_PORT=9000 ./start_app.sh
#
# After Ctrl+C (or crash), run ./stop_app.sh to clear ANTHROPIC_BASE_URL so
# Claude Code falls back to Anthropic cloud while the router is down.

set -euo pipefail
cd "$(dirname "$0")"

# ── Helpers ──────────────────────────────────────────────────────────────────
_banner()  { echo ""; echo "  $*"; }
_ok()      { echo "  ✓ $*"; }
_warn()    { echo "  ⚠  $*" >&2; }
_err()     { echo "  ✗ ERROR: $*" >&2; }
_step()    { echo ""; echo "$*"; }

# ── Section 1 — Repo sanity ────────────────────────────────────────────────
if [ ! -f "package.json" ]; then
  _err "package.json not found. Keep this file in the Claude-Hybrid repo root."
  exit 1
fi

# ── Section 2 — Node.js check ─────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  _err "node not found in PATH. Install Node.js 18+ and retry."
  exit 1
fi

ROUTER_PORT="${ROUTER_PORT:-8082}"

# ── Section 3 — Ollama detection and auto-install ─────────────────────────
_step "[1/4] Checking Ollama installation..."

_is_ollama_installed() {
  command -v ollama &>/dev/null
}

if ! _is_ollama_installed; then
  _banner "Ollama not found. Installing automatically..."
  echo ""
  echo "  This is a one-time install from https://ollama.com"
  echo ""

  if command -v curl &>/dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
  elif command -v wget &>/dev/null; then
    wget -qO- https://ollama.com/install.sh | sh
  else
    _err "Neither curl nor wget found. Install one of them, then re-run this script."
    _err "Or install Ollama manually from: https://ollama.com/download"
    exit 1
  fi

  # Reload PATH in case installer added a new directory
  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck disable=SC1090
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  if [ -f "$HOME/.profile" ]; then
    source "$HOME/.profile" 2>/dev/null || true
  fi
  # Common macOS Homebrew prefix
  if [ -d "/usr/local/bin" ] && [[ ":$PATH:" != *":/usr/local/bin:"* ]]; then
    export PATH="/usr/local/bin:$PATH"
  fi
  # Common Linux system binary prefix
  if [ -d "/usr/bin" ] && [[ ":$PATH:" != *":/usr/bin:"* ]]; then
    export PATH="/usr/bin:$PATH"
  fi

  if _is_ollama_installed; then
    _ok "Ollama installed successfully."
  else
    _err "Ollama installation appears to have failed."
    _err "Try installing manually: https://ollama.com/download"
    exit 1
  fi
else
  _ok "Ollama is installed."
fi

# ── Section 4 — Ollama service check ──────────────────────────────────────
_step "[2/4] Checking Ollama service..."

_ollama_running() {
  ollama list &>/dev/null
}

if ! _ollama_running; then
  _banner "Ollama service is not running. Starting it in the background..."
  # Allow two resident models by default for parallel small-model agent sessions.
  export OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-2}"
  _ok "Ollama max loaded models: ${OLLAMA_MAX_LOADED_MODELS}"
  # Start ollama serve detached; redirect output to avoid blocking the terminal
  nohup ollama serve &>/dev/null &
  OLLAMA_SERVE_PID=$!
  echo "  Waiting ~5 seconds for service to initialize (PID ${OLLAMA_SERVE_PID})..."
  sleep 5

  if _ollama_running; then
    _ok "Ollama service started successfully."
  else
    _warn "Could not verify Ollama service after start attempt."
    _warn "Continuing anyway — the router will surface an error if Ollama is unreachable."
  fi
else
  _ok "Ollama service is running."
fi

# ── Section 5 — Auto-pull model if library is empty ───────────────────────
_step "[3/4] Checking Ollama model library..."

# Count model rows (skip the header line)
MODEL_COUNT=0
while IFS= read -r line; do
  [[ -n "$line" ]] && MODEL_COUNT=$((MODEL_COUNT + 1))
done < <(ollama list 2>/dev/null | tail -n +2)

if [ "$MODEL_COUNT" -gt 0 ]; then
  _ok "Model library is not empty (${MODEL_COUNT} model(s) found). Skipping auto-pull."
else
  echo ""
  echo "  No models found in Ollama library."
  echo "  Pulling qwen2.5-coder:7b — this is a one-time download of ~4.7 GB."
  echo ""
  echo "  Why qwen2.5-coder:7b?"
  echo "    - Specifically optimized for coding tasks (the primary use case for"
  echo "      Claude Code routing — fixes, refactors, questions, quick answers)"
  echo "    - Strong quality-per-GB ratio for local inference"
  echo "    - Fits in 6 GB+ VRAM or runs on CPU with sufficient RAM"
  echo "    - Reserved for lightweight/local requests; large or complex tasks"
  echo "      still go to Anthropic cloud (saving your API quota)"
  echo ""
  echo "  Pulling now (live progress below)..."
  echo "  ----------------------------------------------------------------"
  if ollama pull qwen2.5-coder:7b; then
    echo "  ----------------------------------------------------------------"
    _ok "Model pulled successfully."
  else
    echo ""
    _warn "ollama pull failed. The router can still start, but local routing"
    _warn "will not work until at least one model is available."
    _warn "Run once Ollama is healthy:  ollama pull qwen2.5-coder:7b"
  fi
fi

# ── Section 6 — Already running? sync env and exit ───────────���────────────
_step "[4/4] Checking port ${ROUTER_PORT} and starting router..."

_is_healthy() {
  command -v curl &>/dev/null || return 1
  curl -sf --max-time 2 "http://127.0.0.1:${ROUTER_PORT}/api/health" 2>/dev/null \
    | grep -q '"healthy"'
}

if _is_healthy; then
  echo "  Claude Hybrid router is already listening on port ${ROUTER_PORT}."
  echo "  Syncing hybrid env (merge-claude-hybrid-env)..."
  node scripts/merge-claude-hybrid-env.js
  exit 0
fi

# ── Section 7 — Port conflict check ───────────────────────────────────────
_pid_on_port() {
  if command -v lsof &>/dev/null; then
    lsof -ti "tcp:${1}" 2>/dev/null | head -1 || true
  elif command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | awk -v p="$1" '$4 ~ ":"p"$" {match($6,/pid=([0-9]+)/,a); print a[1]}' | head -1 || true
  fi
}

PORT_PID="$(_pid_on_port "${ROUTER_PORT}")"
if [ -n "${PORT_PID}" ]; then
  _err "Port ${ROUTER_PORT} is already in use by PID ${PORT_PID}."
  _err "Stop that process or use a different ROUTER_PORT."
  exit 1
fi

# ── Section 8 — Apply proxy env and launch ────────────────────────────────
echo "  Applying hybrid routing: ANTHROPIC_BASE_URL -> http://127.0.0.1:${ROUTER_PORT} ..."
if ! node scripts/merge-claude-hybrid-env.js; then
  _warn "merge-claude-hybrid-env.js failed. Run: npm run merge-env"
fi

echo ""
echo "  Starting Claude Hybrid Router on port ${ROUTER_PORT}..."
echo "  Dashboard: http://127.0.0.1:${ROUTER_PORT}/"
echo "  Press Ctrl+C to stop. Run ./stop_app.sh after exit to restore cloud routing."
echo ""
node router/server.js

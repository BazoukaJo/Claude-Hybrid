# Claude Hybrid — local + cloud auto-routing

Claude Hybrid sends Claude Code traffic to:

- **Ollama (local)** for routine work — fast, private, no per-token API cost  
- **Anthropic Claude** for heavier work — larger context, tool-heavy turns, or complexity keywords  

After setup, use `claude` as usual; routing is automatic.

---

## What you get

| Area | Behavior |
|------|----------|
| **Routing** | Local vs cloud from estimated tokens, tool results *this turn*, and keywords (defaults in `hybrid.config.json`). |
| **Resilience** | If Ollama errors, the router can fall back to cloud. |
| **Protocol** | Anthropic-style requests are translated for Ollama’s OpenAI-compatible API (messages, tools, streaming). |
| **Dashboard** | `http://localhost:8082` — default model, pool / smart routing / speed-assist (auto-saved on change), Ollama runtime, installed library (size + max context), generation sliders (auto-saved), **Generation settings** / **Model details**, router log. Layout max-width ~1280px. |
| **Preview page** | `http://localhost:8082/header-ui` — header + system strip + log only (full controls stay on `/`). |
| **Autostart** | Optional: `setup.ps1` can install a Startup-folder launcher (Ollama + router). |

**Hardware this kit targets:** 16 GB VRAM class GPUs and up; default tag is **`VladimirGav/gemma4-26b-16GB-VRAM:latest`**. Adjust `local.model` if you use a different Ollama name.

---

## One-time setup

### Prerequisites

- **Ollama** (`ollama --version`, recent 0.20+ typical)  
- **Node.js 18+** (`node --version`)  
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`)

### Models (example)

```powershell
ollama pull VladimirGav/gemma4-26b-16GB-VRAM
ollama pull gemma4:e4b
```

### Apply config (env + optional autostart)

```powershell
.\setup.ps1
```

Routing-only (skip model pulls):

```powershell
.\setup.ps1 -RoutingOnly
```

This sets **`ANTHROPIC_BASE_URL=http://localhost:8082`** (User env), prompts for **`ANTHROPIC_API_KEY`** if needed, and can register login autostart.

Restart the IDE after setup so it picks up merged `~/.claude/settings.json` env.

---

## Daily use

| Goal | Command |
|------|---------|
| Start router | `npm start` (repo root), `node .\router\server.js`, or **`start_app.bat`** (Windows, minimized window) |
| Stop / restart (Windows) | **`stop_app.bat`**, **`restart_app.bat`** (uses `ROUTER_PORT`, default 8082) |
| Login autostart (Windows) | Run **`install_startup_shortcut.bat`** once (creates *Claude Hybrid Router.lnk* in your Startup folder; **Win+R** → `shell:startup` to view or remove) |
| Open dashboard | Browser: `http://localhost:8082` (use your `ROUTER_PORT` if overridden) |
| Run tests | `npm test` · full + UI screenshots: `npm run test:all` |

**Pool**, **smart routing**, and **speed assist** write `hybrid.config.json` automatically when you change them (same admin token rules as other mutating routes). **Default model** saves on dropdown change. Main **generation sliders** save after you stop dragging (~½ s debounce).

---

## `hybrid.config.json` (router)

Copy from **`router/hybrid.config.example.json`** if missing. Main keys:

| Key | Role |
|-----|------|
| `listen.host` | Bind address (default `127.0.0.1`). |
| `local.model` | Default Ollama tag. **Empty string or omit the key** to auto-select from installed tags on startup (Ollama must be running). |
| `local.models` | Optional pool list for smart routing; empty = all tags from `ollama list`. |
| `local.smart_routing` | If true, pick among pool by task (vision, tools, size, brief prompts). |
| `local.fast_model` | Optional small tag for brief prompts. **Empty or omit** → auto-pick a smaller installed model (e.g. `gemma4:e4b`) when possible. |
| `routing.tokenThreshold` | Route cloud if estimated transcript tokens exceed this (default 5000). |
| `routing.fileReadThreshold` | Route cloud if the **latest user message** has more than this many `tool_result` blocks. |
| `routing.keywords` | Substrings in the last user message → cloud. |

Changes are picked up when the file is saved (watcher), or after routing / default-model POSTs from the dashboard.  
A root **`.gitignore`** may exclude `router/hybrid.config.json` so machine-specific settings are not committed; keep the **example** file in git.

---

## Routing summary

**Cloud** if any of:

- Estimated tokens (whole transcript) &gt; threshold  
- Tool results in the **current** user message &gt; threshold  
- Last user text contains a configured keyword  

**Otherwise local.**  
Complexity keywords default to things like `architect`, `security audit`, `multi-file`, `deep reason`, etc. (see example JSON).

---

## Useful HTTP routes

| Route | Purpose |
|-------|---------|
| `GET /` | Main dashboard |
| `GET /header-ui` | Header / system / log preview |
| `GET /events` | SSE routing log |
| `GET /api/health` | Router + Ollama reachability |
| `GET /api/system-stats` | CPU / RAM / VRAM / GPU |
| `GET /api/model-status` | `/api/ps`-style loaded models + defaults |
| `GET /api/ollama-models` | Tags (with `context_max` per model via Ollama `/api/show`), loaded names, configured default, pool snapshot |
| `GET /api/stats` | Counters, last route, non-secret config snapshot |
| `GET/POST /api/router/local-routing-config` | Read/write `local.models` pool, `smart_routing`, and `fast_model` (POST may need admin token) |
| `POST /api/local-model` | Set `local.model` (admin if token set) |
| `GET/POST /api/model-params` | Global generation defaults (`.claude/model-params.json`) |
| `GET /api/model-params-full` | Built-in vs global vs per-model vs effective (dashboard settings table) |
| `POST /api/model-params-per-model` | Per-model overrides |
| `POST /api/router/model/start|stop|restart` | Ollama load/unload helpers |
| `GET /api/router/model-details` | Modal payload for **Model details** |
| `POST /api/service/start|stop|restart` | Windows Ollama service (admin if token set) |

If **`ROUTER_ADMIN_TOKEN`** is set, mutating **POST**s need header **`X-Router-Token`** or **`Authorization: Bearer …`**.

---

## Repo layout

| Path | Purpose |
|------|---------|
| `router/server.js` | HTTP entry, proxy, embedded dashboard |
| `router/lib/*.js` | Config, routing logic, model picker, metrics, admin auth |
| `router/public/` | `header-ui.html`, CSS under `/assets/`, `claude-code-icon.svg` (Claude mark path from [Bootstrap Icons](https://github.com/twbs/icons) `claude`, MIT; `/assets/claude-icon.svg` aliases the same file) |
| `router/hybrid.config.example.json` | Template for `hybrid.config.json` |
| `setup.ps1` | Setup entry (`-RoutingOnly`, `-ShortcutOnly`, `-Autostart`, …) |
| `scripts/` | `diagnose-claude-hybrid.ps1`, `merge-claude-hybrid-env.js`, … |
| `tests/` | `npm test` (Node), `npm run test:e2e-ui` (Playwright screenshots; install Chromium once) |
| `powershell-profile-additions.ps1` | Optional shell helpers |

---

## Troubleshooting

**Start router manually**

```powershell
cd <path-to-this-repo>
npm start
# or: node .\router\server.js
```

**Confirm proxy URL**

```powershell
[System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
# expect: http://localhost:8082 (or your ROUTER_PORT)
```

**Diagnostics**

```powershell
.\scripts\diagnose-claude-hybrid.ps1
```

**Ollama / GPU**

```powershell
ollama ps
nvidia-smi
```

**Tests**

```powershell
npm test
npm run test:e2e-ui   # optional; requires: npm i && npx playwright install chromium
```

---

## Development notes

- After edits to **`router/server.js`** or **`router/lib/*`** loaded at startup, **restart** the router (`npm start`).  
- **`npm test`** runs integration tests on a temporary port (no conflict with a router on 8082).

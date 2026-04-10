# CLAUDE.md

Guidance for Claude Code (and similar agents) working in this repository.

## What this project is

A kit that routes Claude Code (and other Anthropic-API-compatible clients) between **local Ollama** and **Anthropic’s API** by task shape. After setup, the user runs `claude` normally; **`ANTHROPIC_BASE_URL`** points at this router.

## Architecture

```text
Claude Code / Cursor / IDE
    |
    | ANTHROPIC_BASE_URL=http://localhost:8082  (or ROUTER_PORT)
    |   Windows User env + ~/.claude/settings.json — setup.ps1 merges both
    v
router/server.js  (Node proxy; no npm deps for the router itself)
    |  router/lib/*.js — config, routing analysis, smart model picker, metrics, admin
    |  router/public/ — CSS, header-ui.html → /assets/, /header-ui
    |
    +-- local  --> Ollama :11434 (OpenAI-compatible /v1/chat/completions)
    +-- cloud  --> api.anthropic.com
```

The proxy maps Anthropic message/tool format to OpenAI-style bodies for Ollama and can fall back to cloud if the local path fails.

## UI surfaces

| URL | Content |
|-----|---------|
| `http://127.0.0.1:8082/` | Main dashboard: local-first explainer, default model, pool / smart routing / speed-assist (auto-save on change), Ollama runtime, installed library (disk size + max context), generation sliders (auto-save), **Settings** / **Info** modals, supporter footer, fixed router log. Content width capped (~1280px). |
| `/header-ui` | Preview: header, system metrics, log — links to `/` for full controls. |
| `/events` | SSE stream of routing decisions. |

## Config files

- **`router/hybrid.config.json`** — Optional; created from **`router/hybrid.config.example.json`** by `setup.ps1` if missing. Watcher reloads on save.  
  Relevant keys: `listen.host`, **`local.model`**, **`local.models`**, **`local.smart_routing`**, **`local.fast_model`** (dashboard updates write the file automatically), **`routing.tokenThreshold`**, **`routing.fileReadThreshold`**, **`routing.keywords`**.  
  If **`local.model`** or **`local.fast_model`** is **missing or empty**, the router **on startup** reads **`GET /api/tags`** and writes sensible defaults into the file (skip with **`ROUTER_SKIP_AUTO_DEFAULT_MODELS=1`**).
- **`.claude/model-params.json`** — Global generation defaults (dashboard **Save** / **Generation settings**).
- **`.claude/model-params-per-model.json`** — Per-model overrides.

Root **`.gitignore`** may exclude `router/hybrid.config.json` and some `.claude/*` JSON so local tuning is not committed.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ROUTER_HOST` | Bind address; default **`127.0.0.1`**. Use **`0.0.0.0`** only with care (LAN + consider `ROUTER_ADMIN_TOKEN`). |
| `ROUTER_PORT` / `PORT` | Listen port; default **8082**. |
| `ROUTER_ADMIN_TOKEN` | If set, mutating **POST** routes require **`X-Router-Token`** or **`Authorization: Bearer`**. |

## Routing rules (high level)

**Cloud** if any:

- Estimated tokens (whole transcript) &gt; `routing.tokenThreshold` (default 5000)
- More than `routing.fileReadThreshold` **`tool_result`** blocks in the **latest user message** only
- Last user message contains any `routing.keywords` entry

**Else local.**  
With **`local.smart_routing`** and multiple models in the pool, **`router/lib/local-model-picker.js`** scores by vision/tools, size, “heavy” vs “brief” prompts, optional **`local.fast_model`**, and **tool results in the latest user message** (Claude Code always sends tools in the schema; the picker uses real `tool_result` volume and mid-turn heuristics, not “tools array present” alone).

## API touches agents often care about

- `GET /api/health`, `/api/model-status`, `/api/ollama-models` (tags include optional `context_max` from `/api/show`), `/api/stats`
- `GET/POST /api/router/local-routing-config` — pool (`local.models`), `smart_routing`, `fast_model`
- `POST /api/local-model` — set default model name
- `GET/POST /api/model-params`, `POST /api/model-params-per-model`, `GET /api/model-params-full`

## Setup commands

```powershell
ollama pull VladimirGav/gemma4-26b-16GB-VRAM
ollama pull gemma4:e4b
.\setup.ps1
# or: .\setup.ps1 -RoutingOnly
```

Restart the IDE after setup. The **Claude consumer desktop app** is not the same integration path as Claude Code; prefer terminal **`claude`** or IDE extensions.

## Manual controls

Restart the Node router after changing **`router/server.js`** or **`router/lib/*`** loaded at startup.

```powershell
npm start
# or: node router\server.js
# Windows: start_app.bat / stop_app.bat / restart_app.bat; install_startup_shortcut.bat → Startup folder .lnk
$env:ANTHROPIC_BASE_URL = ""   # force cloud for this session
claude
[System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
.\scripts\diagnose-claude-hybrid.ps1
node scripts\merge-claude-hybrid-env.js
```

## Tests

```powershell
npm test   # includes tests/daily-routing-scenarios.test.cjs (routine → local, heavy/keywords → cloud vs hybrid.config.example.json)
npm run test:e2e-ui    # Playwright UI screenshots; needs: npm i && npx playwright install chromium
npm run test:all
.\tests\validate-routing.ps1   # live router + Ollama: probes local, keyword cloud, heavy tool-turn (hybrid)
.\tests\run-all.ps1              # Node tests + validate-routing.ps1 when :8082 is up
```

## Agent discipline

- Search (`rg`) before reading large files; avoid redundant full-file reads.
- Default model / pool / thresholds live in **`hybrid.config.json`**; do not hardcode user paths in docs.

## Hardware note (this kit’s reference machine)

RTX 4070 Ti Super (16 GB VRAM), 64 GB RAM — default **`VladimirGav/gemma4-26b-16GB-VRAM:latest`** in code. Adjust `local.model` for the user’s GPU / tag.

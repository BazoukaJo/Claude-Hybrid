# CLAUDE.md

Guidance for Claude Code (and similar agents) working in this repository.

> **Read first:** Treat **[Core behavior](#core-behavior-read-first--prioritize-before-debugging)** as the contract for env + router lifecycle. Before concluding “routing is broken,” verify the client type (**Claude Code CLI** or **VS Code plugin**), whether **`ANTHROPIC_BASE_URL`** still targets this router (vs reverted / cloud), and that **dashboard routing mode** in **`hybrid.config.json`** only applies **after** traffic reaches the proxy. User-facing detail: **`README.md`** § _Core behavior (read this first)_.

## Core behavior (read first — prioritize before debugging)

### Two layers

1. **`ANTHROPIC_BASE_URL`** + **`npm run merge-env`** / **`npm run revert-env`** (and Windows **`start_app.bat`** / **`stop_app.bat`**) determine whether **Claude Code** talks **to this router** or **directly to Anthropic**. If the client bypasses the router, **`hybrid.config.json`** and dashboard controls **do not apply** to that traffic.
2. **`routing.mode`** (**Hybrid** / **Ollama only** / **Claude only**) and local-routing keys govern how the **router** splits work between **Ollama** and **Anthropic** for requests that **already hit** the proxy.

### Lifecycle (keep env aligned with router state)

- **Windows:** **`start_app.bat`** runs **`merge-env`** then starts **`node router/server.js`**. **`stop_app.bat`** stops the process and **by default** runs **`scripts/revert-hybrid-core.bat`** (clear kit proxy from **`~/.claude/settings.json`**, VS Code **`terminal.integrated.env.*`**, User **`ANTHROPIC_BASE_URL`**). **`stop_app.bat keepenv`** stops without reverting.
- **Linux / macOS:** **`./start_app.sh`** and **`./stop_app.sh`** mirror the Windows bat scripts (`chmod +x *.sh` once). `stop_app.sh` calls `node scripts/revert-claude-hybrid-env.js` (reverts `~/.claude/settings.json` + IDE terminal env). **`./stop_app.sh keepenv`** stops without reverting.
- **Manual `npm start`:** run **`npm run merge-env`** when enabling the proxy; **`npm run revert-env`** (and User env script if used on Windows) when returning to cloud-only.
- **Autostart:** Windows — `setup.ps1 -Autostart` / Startup shortcut. macOS — launchd plist wrapping `scripts/watchdog-router.sh`. Linux — crontab `@reboot` or systemd user unit (see `scripts/watchdog-router.sh`).

### Clients

**Claude Code** (CLI and VS Code plugin): use the proxy when env is merged — all model variants route correctly through the proxy. **Automatic recovery (watchdog):** When `-Autostart` is used, a background health watchdog monitors the router every 30 seconds. If the router crashes, the watchdog auto-restarts it (most recoveries within ~1 min). If restart fails after 3+ attempts, the watchdog silently reverts `ANTHROPIC_BASE_URL` so Claude Code falls back to Anthropic cloud — **zero downtime, zero user intervention**. Check **`~/.claude/watchdog.log`** for recovery events.

## What this project is

A kit that routes **Claude Code** (and other Anthropic-API-compatible clients) between **local Ollama** and **Anthropic’s API** by task shape. After setup, the user runs **`claude`** in a terminal (or uses the VS Code plugin with the same env); **`ANTHROPIC_BASE_URL`** points at this router when the lifecycle above is applied.

## Architecture

```text
Claude Code CLI / VS Code plugin
    |
    | ANTHROPIC_BASE_URL=http://127.0.0.1:8082  (default; or ROUTER_PORT)
    |   User env + ~/.claude/settings.json + VS Code terminal.integrated.env.*
    |   setup.ps1 and/or npm run merge-env (scripts/merge-claude-hybrid-env.js)
    v
router/server.js  (Node proxy; no npm deps for the router itself)
    |  router/lib/*.js — config, routing analysis, smart model picker, metrics, admin
    |  router/public/ — CSS, header-ui.html → /assets/, /header-ui
    |
    +-- local  --> Ollama :11434 (OpenAI-compatible /v1/chat/completions)
    +-- cloud  --> api.anthropic.com
```

The proxy maps Anthropic message/tool format to OpenAI-style bodies for Ollama, can fall back across providers when allowed by routing mode, and optionally redacts cloud-bound payloads before forwarding to Anthropic.

## UI surfaces

| URL                      | Content                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http://127.0.0.1:8082/` | Main dashboard: routing-mode controls, local-first explainer, default model, pool / smart routing / speed-assist (auto-save on change), Ollama runtime, installed library (disk size + max context), generation sliders (auto-save), **Settings** / **Info** modals, supporter footer, and fixed footer router log. Footer timestamps follow the configured local timezone. Content width capped (~1280px). |
| `/header-ui`             | Preview: header, system metrics, log — links to `/` for full controls.                                                                                                                                                                                                                                                                                                                                      |
| `/events`                | SSE stream of routing decisions. New clients immediately receive the current in-memory backlog.                                                                                                                                                                                                                                                                                                             |

## Config files

- **`router/hybrid.config.json`** — Optional; created from **`router/hybrid.config.example.json`** by `setup.ps1` if missing. Watcher reloads on save.
  Relevant keys: `listen.host`, **`display.time_zone`**, **`local.model`**, **`local.models`**, **`local.smart_routing`**, **`local.fast_model`**, **`routing.mode`**, **`routing.tokenThreshold`**, **`routing.fileReadThreshold`**, **`routing.keywords`**, and **`privacy.cloud_redaction.*`**. Dashboard updates write the local-routing and routing-mode keys automatically.
  If **`local.model`** or **`local.fast_model`** is **missing or empty**, the router **on startup** reads **`GET /api/tags`** and writes sensible defaults into the file (skip with **`ROUTER_SKIP_AUTO_DEFAULT_MODELS=1`**).
- **`.claude/model-params.json`** — Global generation defaults (dashboard **Save** / **Generation settings**). This is the **repo-local** `.claude/` directory, not `~/.claude/` (Claude Code's global config).
- **`.claude/model-params-per-model.json`** — Per-model overrides. (Also repo-local.)

Root **`.gitignore`** may exclude `router/hybrid.config.json` and some `.claude/*` JSON so local tuning is not committed.

## Environment variables

| Variable                          | Purpose                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROUTER_HOST`                     | Bind address; default **`127.0.0.1`**. Use **`0.0.0.0`** only with care (LAN + consider `ROUTER_ADMIN_TOKEN`).                                                                  |
| `ROUTER_PORT` / `PORT`            | Listen port; default **8082**.                                                                                                                                                  |
| `ROUTER_OLLAMA_HOST`              | Ollama HTTP host for the router (default **`localhost`**). In Docker Compose use the **Ollama** service name; with host Ollama use **`host.docker.internal`**.                  |
| `ROUTER_OLLAMA_PORT`              | Ollama HTTP port (default **11434**).                                                                                                                                           |
| `ROUTER_HYBRID_CONFIG`            | Absolute path to an alternate **`hybrid.config.json`** (see **`router/lib/hybrid-config.js`**).                                                                                 |
| `ROUTER_TIME_ZONE`                | Optional IANA timezone override for footer/log timestamps, e.g. **`America/Toronto`**. If unset, the router uses the configured file value or the local system timezone.        |
| `ROUTER_ADMIN_TOKEN`              | If set, mutating **POST** routes require **`X-Router-Token`** or **`Authorization: Bearer`**.                                                                                   |
| `ROUTER_PROXY_SOCKET_MS`          | Outbound **Anthropic / Ollama** proxy socket idle timeout (ms); resets when bytes move. Default **300000** (5 min). Set **0** to disable (can hang clients if upstream stalls). |
| `ROUTER_SKIP_AUTO_DEFAULT_MODELS` | Skip startup auto-picking for `local.model` / `local.fast_model` when they are empty in config.                                                                                 |

**Claude Code client env** (via `~/.claude/settings.json` and IDE terminal blocks) is updated by **`npm run merge-env`**: **`ANTHROPIC_BASE_URL`**, **`ENABLE_TOOL_SEARCH`**, and optionally **`ANTHROPIC_API_KEY`** if that variable is set in the shell when merge runs. Remove stored API key: **`ROUTER_REMOVE_CLAUDE_API_KEY=1`** with merge (see **`README.md`** quota section).

## Routing rules (high level)

**Cloud** if any:

- Estimated tokens (whole transcript) &gt; `routing.tokenThreshold` (default 5000)
- More than `routing.fileReadThreshold` **`tool_result`** blocks in the **latest user message** only
- Last user message contains any `routing.keywords` entry

**Else local.**
With **`local.smart_routing`** and multiple models in the pool, **`router/lib/local-model-picker.js`** scores by vision/tools, size, “heavy” vs “brief” prompts, optional **`local.fast_model`**, and **tool results in the latest user message**. Broad keywords like `audit` are guarded to avoid needless cloud escalation for short generic prompts. Cloud-bound requests preserve the selected Claude model.

## Privacy redaction

The router supports an **opt-in, cloud-only** privacy layer under **`privacy.cloud_redaction`** in `router/hybrid.config.json`.

- `enabled` turns redaction on for requests forwarded to Anthropic
- `redact_tool_results` applies the same pass to tool-result payloads
- `redact_paths`, `redact_urls`, `redact_emails`, `redact_secrets`, and `redact_ids` mask common sensitive values
- `custom_terms` lets users replace project-specific names or internal codenames
- `redact_identifiers` is a stronger mode that pseudonymizes camelCase / PascalCase / snake_case identifiers

The redactor currently lives in **`router/lib/privacy-redactor.js`**. `/api/stats` exposes whether the feature is enabled and whether tool-result or identifier redaction is active, but it does not expose the custom terms themselves.

## API touches agents often care about

- `GET /api/health`, `/api/model-status`, `/api/ollama-models` (tags include optional `context_max` from `/api/show`), `/api/stats`, `/api/logs`
- `GET /api/quality-log?limit=50` — recent cloud-quality entries, aggregates, and routing suggestions
- `GET /events` seeds the current log backlog and then streams new route events
- `GET/POST /api/router/local-routing-config` — pool (`local.models`), `smart_routing`, `fast_model`
- `GET/POST /api/router/routing-mode` — current `routing.mode`
- `POST /api/local-model` — set default model name
- `GET/POST /api/model-params`, `POST /api/model-params-per-model`, `GET /api/model-params-full`

## Setup commands

```powershell
ollama pull qwen2.5-coder:7b
.\setup.ps1
# or: .\setup.ps1 -RoutingOnly
```

Restart VS Code after setup. If the router log stays empty, run **`npm run merge-env`** (updates `~/.claude/settings.json`, VS Code **`terminal.integrated.env.*`** with **`ANTHROPIC_BASE_URL`** + **`ENABLE_TOOL_SEARCH`**, and aligns User **`ANTHROPIC_BASE_URL`** with **`setup.ps1`**), then **fully quit** VS Code and reopen. On Windows, merge may run **`scripts/notify-environment-windows.ps1`** so User env changes propagate without a full reboot (best-effort).

**Local deploy sanity:** **`npm start`** → dashboard **`http://127.0.0.1:8082/`**; **`npm run diagnose`** (Windows) checks port, listener, and settings. **`npm install`** is only required for **`npm test`** / Playwright, not for running the router.

**Containers:** **`Dockerfile`**, **`docker-compose.yml`** (Ollama **`healthcheck`**, router **`depends_on` → `service_healthy`**), **`docker-compose.host-ollama.yml`**, **`.devcontainer/docker-compose.devcontainer.yml`** (prepended: **`/app`** bind-mount, **`NODE_ENV=development`**, optional **ollama `mem_limit`**), optional **`.devcontainer/docker-compose.router-manual.yml`** (append last in **`dockerComposeFile`** to keep the container up without auto-starting **`node router/server.js`**), **`npm run docker:up` / `docker:down`**, **`npm run docker:config`** / **`docker:config:devcontainer*`** — see **`README.md`**. **`GET /api/health`** exposes **`ollama_host`**, **`ollama_port`**, **`router_listen`**. If **`ROUTER_HOST`** exposes the dashboard on a LAN, set **`ROUTER_ADMIN_TOKEN`** for mutating **POST** routes.

## Manual controls

Restart the Node router after changing **`router/server.js`** or **`router/lib/*`** loaded at startup.

```powershell
# Windows
npm start
# or: node router\server.js
# start_app.bat (runs merge-env, then router); stop_app.bat (stops + reverts proxy in settings, IDE, User env; keepenv = stop only); restart_app.bat; install_startup_shortcut.bat → Startup folder .lnk
$env:ANTHROPIC_BASE_URL = ""   # force cloud for this session
claude
[System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
npm run diagnose
npm run merge-env
```

```bash
# Linux / macOS
chmod +x start_app.sh stop_app.sh restart_app.sh   # once
./start_app.sh        # merge env + start router
./stop_app.sh         # stop router + revert proxy
./stop_app.sh keepenv # stop only
./restart_app.sh      # stop keepenv + wait + start
ANTHROPIC_BASE_URL="" claude   # force cloud for this session
npm run merge-env
# Watchdog: bash scripts/watchdog-router.sh &  (or via launchd / cron — see script header)
```

The dashboard footer log hydrates from `/api/logs` and then follows `/events`, so an empty footer after refresh is a bug rather than expected behavior.

## Tests

```powershell
npm test   # includes tests/daily-routing-scenarios.test.cjs (routine → local, heavy/keywords → cloud vs hybrid.config.example.json)
npm run test:e2e-ui    # Playwright UI screenshots; needs: npm i && npx playwright install chromium
npm run test:all
.\tests\validate-routing.ps1   # live router + Ollama: probes local, keyword cloud, heavy tool-turn (hybrid)
.\tests\run-all.ps1              # Node tests + validate-routing.ps1 when :8082 is up
```

Recent coverage additions include privacy redaction unit tests and a router HTTP test that validates default-model switching does not surface a false error while the new Ollama model is still loading.

## Agent discipline

- Search (`rg`) before reading large files; avoid redundant full-file reads.
- Default model / pool / thresholds live in **`hybrid.config.json`**; do not hardcode user paths in docs.
- Do not debug hybrid routing until **Core behavior** is satisfied: correct client, merged vs reverted **`ANTHROPIC_BASE_URL`**, router actually listening on **`ROUTER_PORT`**.

## Hardware note (this kit’s reference machine)

RTX 4070 Ti Super (16 GB VRAM), 64 GB RAM.

- Keep `deepseek-coder-v2:16b` in pool for stronger local turns.
- Prefer at least one small coder fast lane (`qwen2.5-coder:7b`) and one medium coder model (`qwen3.5:latest` or `devstral:latest`) for robust smart routing.
- `local.vram_gb` should match real hardware so VRAM hard-exclusion and penalties prevent near-limit hangs.

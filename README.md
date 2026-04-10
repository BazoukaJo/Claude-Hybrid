# ClaudeLlama — local + cloud auto-routing

## Core behavior (read this first)

This section is the **contract** for how the kit is meant to work. Everything else in the README assumes you understand it.

### 1. Two layers: “through the router” vs “routing mode inside the router”

| Layer                                                                                                         | What it controls                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ANTHROPIC_BASE_URL`** (and **`npm run merge-env`** / **`npm run revert-env`**)                             | Whether **Claude Code** sends API traffic **to this router** or **directly to Anthropic**. If the URL does **not** point at the router, the dashboard and `hybrid.config.json` **do nothing** for that client. |
| **Dashboard “API routing mode”** (**Hybrid** / **Ollama only** / **Claude only**) in **`hybrid.config.json`** | How the **router** splits traffic between **Ollama** and **Anthropic** **after** the client already hit the router.                                                                                            |

**Default product behavior:** hybrid routing (local for routine turns, cloud when rules say so), configured on the dashboard once the client uses the proxy.

### 2. Router lifecycle and env (must stay in sync)

**Goal:** When the router is **up**, Claude Code should use **local routing** (via the proxy). When the router is **down**, Claude Code should **not** keep pointing at a dead port — it should use **normal Anthropic cloud** (until you start the router again).

| Action                                | What to use (Windows)                                                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start router + apply proxy**        | **`start_app.bat`** — runs **`npm run merge-env`** then starts **`node router/server.js`**. Sets **`ANTHROPIC_BASE_URL`** in **`~/.claude/settings.json`**, **User** env, and **Cursor/VS Code** `terminal.integrated.env.*` where applicable.                        |
| **Stop router + revert proxy**        | **`stop_app.bat`** — stops the listener, then runs **`scripts/revert-hybrid-core.bat`** (revert **`settings.json`**, IDE terminal env, User **`ANTHROPIC_BASE_URL`**). If a pre-router URL was saved, it is restored; otherwise proxy URL is removed (cloud default). |
| **Stop router only, keep env**        | **`stop_app.bat keepenv`**                                                                                                                                                                                                                                            |
| **Manual / Ctrl+C after `npm start`** | Run **`npm run merge-env`** when you start routing; run **`npm run revert-env`** and **`scripts\revert-hybrid-user-env.ps1`** (or **`stop_app.bat`**) when you want **cloud-only** again.                                                                             |

**Autostart (`setup.ps1 -Autostart`, Startup shortcut):** also runs **`merge-env`** before spawning the background router so the same rules apply after login.

### 3. Supported clients (non-negotiable)

| Client                                                        | Uses this router?                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** (`claude` CLI)                                | **Yes** — if **`ANTHROPIC_BASE_URL`** is set (see layer 1).                                                          |
| **Cursor / VS Code** + Claude Code                            | **Yes** — same; use **`merge-env`** so IDE terminals see the URL.                                                    |
| **Claude desktop Windows/Mac app** (standalone Anthropic app) | **No** — does **not** use **`ANTHROPIC_BASE_URL`** for normal chat, so this router cannot see or route that traffic. |

---

## What you get

Once **Claude Code** is pointed at the router, ClaudeLlama sends traffic to:

- **Ollama (local)** for routine work — fast, private, no per-token API cost
- **Anthropic Claude** for heavier work — larger context, tool-heavy turns, or complexity keywords (per **Hybrid** rules and thresholds)

After setup and **`merge-env`**, use **`claude`** as usual; **in-router** routing is automatic for traffic that hits the proxy.

---

| Area             | Behavior                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routing**      | Hybrid routes by transcript size, `tool_result` volume on the latest user turn, and keywords. There are also explicit **Hybrid**, **Claude only**, and **Ollama only** modes in the dashboard.                                                                                                                                                       |
| **Cost control** | Concise prompts can stay local even when they contain broad routing keywords, which reduces unnecessary cloud usage without removing cloud escalation for heavier requests.                                                                                                                                                                          |
| **Privacy**      | Optional cloud-only redaction can mask secrets, paths, URLs, emails, UUID-like IDs, and custom terms before a request is sent to Anthropic. Stronger identifier pseudonymization is also available.                                                                                                                                                  |
| **Resilience**   | If Ollama errors or Claude rate/quota limits are hit, the router can fall back according to the active routing mode. Cloud limit state is surfaced in the dashboard.                                                                                                                                                                                 |
| **Protocol**     | Anthropic-style requests are translated for Ollama’s OpenAI-compatible API, including messages, tools, and streaming. Cloud passthrough keeps the selected Claude model intact.                                                                                                                                                                      |
| **Dashboard**    | **`http://127.0.0.1:8082/`** (or `http://localhost:8082/` — same listener; **`127.0.0.1`** is what `setup.ps1` / `npm run merge-env` set in env to avoid IPv6 localhost quirks) — routing mode, pool, smart routing, speed-assist, Ollama runtime, library, generation sliders, **Generation settings**, **Model details**, footer router log + SSE. |
| **Preview page** | **`http://127.0.0.1:8082/header-ui`** — compact header / system / log; full controls on `/`.                                                                                                                                                                                                                                                         |
| **Autostart**    | Optional: `setup.ps1` can install a Startup-folder launcher for Ollama + router.                                                                                                                                                                                                                                                                     |

**Hardware this kit targets:** 16 GB VRAM class GPUs and up; default tag is **`VladimirGav/gemma4-26b-16GB-VRAM:latest`**. Adjust `local.model` if you use a different Ollama name.

## Screenshot

Started app dashboard with a loaded model and visible pool:

![ClaudeLlama dashboard with loaded model and pool](assets/ux-review-screenshots/claudellama-dashboard-loaded-pool.png)

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

`setup.ps1` sets **User** `ANTHROPIC_BASE_URL` to **`http://127.0.0.1:<PORT>`** (default port **8082**, or **`ROUTER_PORT`**), merges **`~/.claude/settings.json`** (`ANTHROPIC_BASE_URL`, **`ENABLE_TOOL_SEARCH`**, optional API key flow), updates **Cursor/VS Code** terminal env when the merge script runs, seeds the router display timezone from Windows when possible, and can install autostart. It may prompt for **`ANTHROPIC_API_KEY`** when relevant.

After setup, run **`npm run merge-env`** anytime you change **`ROUTER_PORT`** or want to refresh IDE + Claude settings without re-running the full installer.

Restart the IDE **fully** after setup or merge so the editor picks up **`settings.json`** changes.

### Local deployment checklist

| Step | Action                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Install **Ollama**, **Node.js 18+**, **Claude Code** (see Prerequisites).                                                                                                                                                                         |
| 2    | Pull at least one model (`ollama pull …`).                                                                                                                                                                                                        |
| 3    | From repo root: **`.\setup.ps1`** (or **`-RoutingOnly`**).                                                                                                                                                                                        |
| 4    | **`npm run merge-env`** — syncs `~/.claude/settings.json` + IDE **`terminal.integrated.env.*`** (**`ANTHROPIC_BASE_URL`** + **`ENABLE_TOOL_SEARCH`**).                                                                                            |
| 5    | Start router: **Windows:** **`start_app.bat`** (merge env + start). **Any OS:** **`npm start`** or **`node .\router\server.js`** (router uses **no runtime npm dependencies**; **`npm install`** is only needed for **`npm test`** / Playwright). |
| 6    | Verify: **`npm run diagnose`** (Windows) and open **`http://127.0.0.1:8082/`** (use your port if **`ROUTER_PORT`** is set).                                                                                                                       |
| 7    | Run **`claude`** from a **new** integrated terminal or external shell so **`ANTHROPIC_BASE_URL`** is visible.                                                                                                                                     |

For a stronger end-to-end check, run **`npm run diagnose:strict`**. It sends a live probe to **`/v1/messages`** and requires a new route entry in **`/api/logs`** to pass.

**Lifecycle + hybrid vs bypass:** See **[Core behavior (read this first)](#core-behavior-read-this-first)** §§1–2. **`ROUTER_REMOVE_CLAUDE_API_KEY=1 npm run merge-env`** drops **`ANTHROPIC_API_KEY`** from `settings.json` only.

---

## Docker, Podman, and Dev Containers

Same router image works with **Docker Engine**, **Docker Desktop**, **Podman** (`podman compose` / `podman-compose`), and **VS Code Dev Containers**. The devcontainer prepends **`.devcontainer/docker-compose.devcontainer.yml`** so the repo is bind-mounted at **`/app`** (live `router/` + stable **`/app/.claude`** overlay) before the main compose file merges in **`router_claude_data`**.

| File                                 | Purpose                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Dockerfile`**                     | Alpine + Node 22; copies **`router/`**; seeds **`hybrid.config.json`** from the example; **`ROUTER_HOST=0.0.0.0`**.                            |
| **`docker-compose.yml`**             | **Ollama** + **router**; Ollama on **`ollama:11434`**; published **`8082`**, **`11434`**. Optional **NVIDIA** stanza is commented in the file. |
| **`docker-compose.host-ollama.yml`** | **Router only**; **`ROUTER_OLLAMA_HOST=host.docker.internal`** for Ollama on the host (**`extra_hosts: host-gateway`** on Linux).              |

**Typical flow (full stack):**

```bash
docker compose up -d --build
# or: podman compose up -d --build
docker exec -it <ollama-container-name> ollama pull gemma4:e4b   # example model
```

On the **host**, point Claude at the proxy (**`http://127.0.0.1:8082`**) — run **`npm run merge-env`** from this repo (or set **`ANTHROPIC_BASE_URL`** yourself).

**npm scripts:** **`npm run docker:build`**, **`npm run docker:up`**, **`npm run docker:down`**.

**Notes:**

- **Ollama** has a **`healthcheck`** (`ollama list`); **router** uses **`depends_on: condition: service_healthy`** so it starts after the Ollama API is reachable (avoids losing the first requests on cold start).
- **`ROUTER_HOST=0.0.0.0`** listens on all interfaces; if you publish **8082** beyond localhost, set **`ROUTER_ADMIN_TOKEN`** and send **`X-Router-Token`** / **`Authorization: Bearer`** on mutating **POST** routes (see **`CLAUDE.md`**).
- **`GET /api/health`** includes **`ollama_host`**, **`ollama_port`**, **`router_listen`** so you can confirm wiring from scripts or CI.
- Dashboard **Ollama service** start/stop is **Windows-only**; in containers you manage the **Ollama** service separately (compose or the host).
- Override config: bind-mount your file, e.g. **`- ./my-hybrid.config.json:/app/router/hybrid.config.json`**. Or set **`ROUTER_HYBRID_CONFIG`** to an absolute path inside the container.
- Generation JSON lives under **`/app/.claude`** in the image; compose uses a named volume **`router_claude_data`** (or **`router_claude_host`**) so slider saves persist.
- **Dev Containers:** **`.devcontainer/docker-compose.devcontainer.yml`** sets **`NODE_ENV=development`** on **router** and **`mem_limit: 8g`** on **ollama** (tune or remove for larger GPUs); **`.devcontainer/devcontainer.json`** installs **git** via a Dev Container **feature** and runs **`npm install`** after create. To **not** auto-start the router (debugger / manual **`npm start`**), append **`docker-compose.router-manual.yml`** last to **`dockerComposeFile`** in **`devcontainer.json`** (see that file’s comment).
- **Compose checks (needs Docker CLI):** **`npm run docker:config`**, **`npm run docker:config:devcontainer`**, **`npm run docker:config:devcontainer-manual`**.

---

## Daily use

| Goal                        | Command                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start router                | **Windows (recommended):** **`start_app.bat`** (merge env + start, minimized). Else **`npm start`** / **`node .\router\server.js`** — then **`npm run merge-env`** if the proxy URL is not set yet. |
| Stop / restart (Windows)    | **`stop_app.bat`** (stops + clears proxy env by default; **`keepenv`** = stop only), **`restart_app.bat`** (`ROUTER_PORT`, default 8082)                                                            |
| Login autostart (Windows)   | Run **`install_startup_shortcut.bat`** once (creates _ClaudeLlama Router.lnk_ in your Startup folder; **Win+R** → `shell:startup` to view or remove)                                                |
| Open dashboard              | Browser: **`http://127.0.0.1:8082/`** (or `localhost`; use **`ROUTER_PORT`** if not 8082)                                                                                                           |
| Run tests                   | `npm test` · full + UI screenshots: `npm run test:all`                                                                                                                                              |
| Check IDE / Claude env      | **`npm run diagnose`** (Windows PowerShell: `ANTHROPIC_BASE_URL`, `ROUTER_PORT`, listener, `settings.json`, API key hint)                                                                           |
| Strict routed-session check | **`npm run diagnose:strict`** (verifies env alignment + sends a live `/v1/messages` probe and confirms a new route log entry)                                                                       |
| Docker (full stack)         | **`npm run docker:up`** · stop: **`npm run docker:down`** · router-only compose: **`docker compose -f docker-compose.host-ollama.yml up -d --build`**                                               |

**Pool**, **smart routing**, **speed assist**, and **routing mode** write `hybrid.config.json` automatically when you change them. **Default model** saves on dropdown change. Main **generation sliders** save after you stop dragging (~½ s debounce).

### Claude Code: “hit your limit” / quota messages

Banners such as **“You’ve hit your limit for Claude messages”** come from **Anthropic / Claude Code plan limits**, not from this router. Pointing **`ANTHROPIC_BASE_URL`** at the kit **does not remove** subscription message caps; restarts do not reset them until the time shown in the app.

**Optional — pay-as-you-go API key:** Claude Code can use a **Console API key** (with billing enabled) **instead of** subscription for eligible traffic when **`ANTHROPIC_API_KEY`** is set. See Anthropic’s [Environment variables](https://code.claude.com/docs/en/env-vars) (`ANTHROPIC_API_KEY` overrides subscription when present).

To merge a key into **`~/.claude/settings.json`** together with the hybrid URL (key is not printed):

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-api03-..."   # from https://console.anthropic.com
npm run merge-env
Remove-Item Env:ANTHROPIC_API_KEY   # optional: clear this shell
```

Then fully restart the IDE / Claude Code; you may be prompted once to approve API-key auth. To drop the key from `settings.json` later (PowerShell): `$env:ROUTER_REMOVE_CLAUDE_API_KEY='1'; npm run merge-env; Remove-Item Env:ROUTER_REMOVE_CLAUDE_API_KEY`.

Keeping **`routing.mode`** on **`local`** still sends completions through **Ollama** when the proxy is used; the key matters when Claude Code or the router talks to **Anthropic** (e.g. hybrid/cloud or client checks).

---

## `hybrid.config.json` (router)

Copy from **`router/hybrid.config.example.json`** if missing. Main keys:

| Key                                           | Role                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `listen.host`                                 | Bind address. Default: `127.0.0.1`.                                                             |
| `local.model`                                 | Default Ollama tag. Empty or missing lets the router auto-pick from installed tags on startup.  |
| `local.models`                                | Optional pool list for smart routing. Empty means all installed tags are eligible.              |
| `local.smart_routing`                         | If true, pick among pool models by task shape, context need, tools, vision, and prompt weight.  |
| `local.fast_model`                            | Optional smaller local tag preferred for brief or speed-style prompts.                          |
| `routing.mode`                                | `hybrid`, `cloud`, or `local`. The dashboard routing-mode buttons write this key automatically. |
| `routing.tokenThreshold`                      | Route cloud if estimated transcript tokens exceed this. Default: `5000`.                        |
| `routing.fileReadThreshold`                   | Route cloud if the **latest user message** contains more than this many `tool_result` blocks.   |
| `routing.keywords`                            | Substrings in the last user message that bias toward cloud routing.                             |
| `privacy.cloud_redaction.enabled`             | Enable cloud-only privacy filtering before forwarding to Anthropic.                             |
| `privacy.cloud_redaction.redact_tool_results` | Redact tool-result payloads as well as user/system text.                                        |
| `privacy.cloud_redaction.redact_paths`        | Replace Windows and Unix-like absolute paths with stable placeholders.                          |
| `privacy.cloud_redaction.redact_urls`         | Replace URLs with placeholders.                                                                 |
| `privacy.cloud_redaction.redact_emails`       | Replace email addresses with placeholders.                                                      |
| `privacy.cloud_redaction.redact_secrets`      | Replace common token / secret patterns and `api_key`-style assignments.                         |
| `privacy.cloud_redaction.redact_ids`          | Replace UUID-like IDs with placeholders.                                                        |
| `privacy.cloud_redaction.redact_identifiers`  | Optional stronger mode that pseudonymizes camelCase / PascalCase / snake_case identifiers.      |
| `privacy.cloud_redaction.custom_terms`        | Extra project-specific terms to replace before cloud forwarding.                                |

Changes are picked up when the file is saved (watcher), or after routing / default-model POSTs from the dashboard.
A root **`.gitignore`** may exclude `router/hybrid.config.json` so machine-specific settings are not committed; keep the **example** file in git.

## Privacy layer

Privacy redaction is **off by default** and only applies to requests that are about to go to Anthropic. Local Ollama requests are left untouched.

When enabled, the router replaces sensitive content with stable placeholders such as `SECRET_1`, `PATH_1`, or `TERM_1`. The same original value maps to the same placeholder within a request, which keeps the prompt readable enough for Claude while reducing accidental leakage of project names, credentials, internal paths, or infrastructure details.

Recommended first pass:

- Turn on `privacy.cloud_redaction.enabled`
- Keep path, URL, email, secret, ID, and tool-result redaction enabled
- Add a few project names or internal codenames to `custom_terms`
- Leave `redact_identifiers` off unless you specifically want stronger obfuscation and can tolerate more prompt distortion

---

## Routing summary

**Cloud** if any of:

- Estimated tokens (whole transcript) &gt; threshold
- Tool results in the **current** user message &gt; threshold
- Last user text contains a configured keyword

**Otherwise local.**
Complexity keywords default to things like `architect`, `security audit`, `multi-file`, and `deep reason`.

Additional behavior worth knowing:

- Broad keywords such as `audit` are guarded so short, generic prompts do not always escalate to cloud.
- With smart routing enabled, the local picker can choose a different Ollama model from the pool based on tools, vision, context size, and prompt weight.
- The speed-assist model can take brief prompts when it is configured and the request looks latency-sensitive.
- Cloud-model selection is preserved on Claude-bound requests.

---

## Useful HTTP routes

| Route                                       | Purpose                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /`                                     | Main dashboard                                                                                        |
| `GET /header-ui`                            | Header / system / log preview                                                                         |
| `GET /events`                               | SSE routing log stream                                                                                |
| `GET /api/logs`                             | Current in-memory router log backlog for dashboard hydration                                          |
| `GET /api/health`                           | Router + Ollama reachability                                                                          |
| `GET /api/system-stats`                     | CPU / RAM / VRAM / GPU snapshot                                                                       |
| `GET /api/model-status`                     | Loaded models, configured default, pooled cards, effective request context                            |
| `GET /api/ollama-models`                    | Installed tags with `context_max` enrichment and pool snapshot                                        |
| `GET /api/stats`                            | Counters, last route, cloud quota state, and a non-secret config snapshot including privacy status    |
| `GET/POST /api/router/local-routing-config` | Read/write `local.models`, `smart_routing`, and `fast_model`                                          |
| `GET/POST /api/router/routing-mode`         | Read or change `routing.mode`                                                                         |
| `POST /api/local-model`                     | Set `local.model`                                                                                     |
| `GET/POST /api/model-params`                | Global generation defaults in `.claude/model-params.json`                                             |
| `GET /api/model-params-full`                | Built-in vs global vs per-model vs effective view                                                     |
| `POST /api/model-params-per-model`          | Per-model overrides                                                                                   |
| `POST /api/router/model/start`              | Load default model into VRAM (API/automation; no dashboard **Start** button — Ollama loads on demand) |
| `POST /api/router/model/stop`               | Unload the default Ollama model                                                                       |
| `POST /api/router/model/restart`            | Restart the default Ollama model                                                                      |
| `GET /api/router/model-details`             | Modal payload for **Model details**                                                                   |
| `POST /api/service/start`                   | Start Windows Ollama service                                                                          |
| `POST /api/service/stop`                    | Stop Windows Ollama service                                                                           |
| `POST /api/service/restart`                 | Restart Windows Ollama service                                                                        |

If **`ROUTER_ADMIN_TOKEN`** is set, mutating **POST**s need header **`X-Router-Token`** or **`Authorization: Bearer …`**.

---

## Repo layout

| Path                                | Purpose                                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router/server.js`                  | HTTP entry, proxy, embedded dashboard                                                                                                                                                                                         |
| `router/lib/*.js`                   | Config, routing logic, model picker, metrics, admin auth                                                                                                                                                                      |
| `router/public/`                    | `header-ui.html`, CSS under `/assets/`, `claude-code-icon.svg` (Claude mark path from [Bootstrap Icons](https://github.com/twbs/icons) `claude`, MIT; `/assets/claude-icon.svg` aliases the same file)                        |
| `router/hybrid.config.example.json` | Template for `hybrid.config.json`                                                                                                                                                                                             |
| `Dockerfile`, `docker-compose*.yml` | Container image + Compose (Ollama + router, or router + host Ollama)                                                                                                                                                          |
| `.devcontainer/`                    | Dev Container: compose prepend, optional **`docker-compose.router-manual.yml`** (no auto-router), **`devcontainer.json`**                                                                                                     |
| `setup.ps1`                         | Setup entry (`-RoutingOnly`, `-ShortcutOnly`, `-Autostart`, …)                                                                                                                                                                |
| `scripts/`                          | `merge-claude-hybrid-env.js`, `revert-claude-hybrid-env.js` (+ IDE terminal env), `revert-hybrid-user-env.ps1`, `revert-hybrid-core.bat` (**`stop_app.bat`**), `diagnose-claude-hybrid.ps1`, `notify-environment-windows.ps1` |
| `tests/`                            | `npm test` (Node), `npm run test:e2e-ui` (Playwright screenshots; install Chromium once)                                                                                                                                      |
| `powershell-profile-additions.ps1`  | Optional shell helpers                                                                                                                                                                                                        |

---

## Troubleshooting

**Start router manually**

On **Windows**, prefer **`start_app.bat`** from the repo root (runs **`merge-env`** then the router); see **[Core behavior](#core-behavior-read-this-first)** §2. Otherwise:

```powershell
cd <path-to-this-repo>
npm start
# or: node .\router\server.js
```

**Confirm proxy URL**

```powershell
[System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
Get-Content (Join-Path $env:USERPROFILE ".claude\settings.json") -Raw # expect env.ANTHROPIC_BASE_URL → http://127.0.0.1:<PORT>
```

**Diagnostics**

```powershell
npm run diagnose
# or: .\scripts\diagnose-claude-hybrid.ps1
```

**Privacy sanity check**

If you enable cloud redaction, open the dashboard, trigger a cloud-routed request, and inspect `/api/stats` plus the router log footer. The stats payload exposes whether privacy redaction is enabled and whether tool-result / identifier redaction is active, without exposing the redacted terms themselves.

**Ollama / GPU**

```powershell
ollama ps
nvidia-smi
```

**Only cloud / router log never updates when I chat**

You are probably using the **Claude desktop Windows/Mac app**, which does not use **`ANTHROPIC_BASE_URL`**. Chats there never hit this router. Use **`claude`** in a **new** PowerShell or CMD window (after **`npm run merge-env`**) or Claude Code inside **Cursor / VS Code**, then check the dashboard footer log.

**Claude “frozen” / no reply**

If the UI spins forever, the client is often waiting on the router while **Ollama or Anthropic** never sends another byte (stalled generation, dead TCP, or a huge first-token delay). The router now closes idle outbound sockets after **5 minutes** by default and returns **504** so the session can recover instead of hanging. Open **`http://127.0.0.1:8082/`** and check the footer log. For very slow local models, raise **`ROUTER_PROXY_SOCKET_MS`** (e.g. `900000`) or set **`ROUTER_PROXY_SOCKET_MS=0`** only for debugging (disables the safety timeout).

**Tests**

```powershell
npm test
npm run test:e2e-ui   # optional; requires: npm i && npx playwright install chromium
```

---

## Development notes

- After edits to **`router/server.js`** or **`router/lib/*`** loaded at startup, **restart** the router (`npm start`).
- **`npm install`** installs **devDependencies** (e.g. Playwright for **`npm run test:e2e-ui`**). The **router process itself** does not `require()` npm packages.
- **`npm test`** runs integration tests on a temporary port (no conflict with a router on 8082).
- The fixed footer router log hydrates from `/api/logs` and then follows `/events`, so reconnects should keep the log populated instead of showing an empty panel.

Environment variables for the router are summarized in **`CLAUDE.md`** (`ROUTER_HOST`, `ROUTER_PORT`, `ROUTER_ADMIN_TOKEN`, `ROUTER_SKIP_AUTO_DEFAULT_MODELS`, etc.).

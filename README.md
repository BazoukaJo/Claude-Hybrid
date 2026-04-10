# ClaudeLlama — local + cloud auto-routing

ClaudeLlama sends Claude Code traffic to:

- **Ollama (local)** for routine work — fast, private, no per-token API cost
- **Anthropic Claude** for heavier work — larger context, tool-heavy turns, or complexity keywords

After setup, use `claude` as usual; routing is automatic.

---

## What you get

| Area             | Behavior                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Routing**      | Hybrid routes by transcript size, `tool_result` volume on the latest user turn, and keywords. There are also explicit **Hybrid**, **Claude only**, and **Ollama only** modes in the dashboard.                                                                                 |
| **Cost control** | Concise prompts can stay local even when they contain broad routing keywords, which reduces unnecessary cloud usage without removing cloud escalation for heavier requests.                                                                                                    |
| **Privacy**      | Optional cloud-only redaction can mask secrets, paths, URLs, emails, UUID-like IDs, and custom terms before a request is sent to Anthropic. Stronger identifier pseudonymization is also available.                                                                            |
| **Resilience**   | If Ollama errors or Claude rate/quota limits are hit, the router can fall back according to the active routing mode. Cloud limit state is surfaced in the dashboard.                                                                                                           |
| **Protocol**     | Anthropic-style requests are translated for Ollama’s OpenAI-compatible API, including messages, tools, and streaming. Cloud passthrough keeps the selected Claude model intact.                                                                                                |
| **Dashboard**    | `http://localhost:8082` shows routing mode controls, default model, pool, smart routing, speed-assist model, Ollama runtime, installed library, generation sliders, **Generation settings**, **Model details**, and a fixed footer router log with backlog + live SSE updates. |
| **Preview page** | `http://localhost:8082/header-ui` shows the compact header/system/log preview while full controls stay on `/`.                                                                                                                                                                 |
| **Autostart**    | Optional: `setup.ps1` can install a Startup-folder launcher for Ollama + router.                                                                                                                                                                                               |

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

This sets **`ANTHROPIC_BASE_URL=http://localhost:8082`** (User env), prompts for **`ANTHROPIC_API_KEY`** if needed, and can register login autostart.

Restart the IDE after setup so it picks up merged `~/.claude/settings.json` env.

---

## Daily use

| Goal                      | Command                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start router              | `npm start` (repo root), `node .\router\server.js`, or **`start_app.bat`** (Windows, minimized window)                                               |
| Stop / restart (Windows)  | **`stop_app.bat`**, **`restart_app.bat`** (uses `ROUTER_PORT`, default 8082)                                                                         |
| Login autostart (Windows) | Run **`install_startup_shortcut.bat`** once (creates _ClaudeLlama Router.lnk_ in your Startup folder; **Win+R** → `shell:startup` to view or remove) |
| Open dashboard            | Browser: `http://localhost:8082` (use your `ROUTER_PORT` if overridden)                                                                              |
| Run tests                 | `npm test` · full + UI screenshots: `npm run test:all`                                                                                               |

**Pool**, **smart routing**, **speed assist**, and **routing mode** write `hybrid.config.json` automatically when you change them. **Default model** saves on dropdown change. Main **generation sliders** save after you stop dragging (~½ s debounce).

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

| Route                                       | Purpose                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /`                                     | Main dashboard                                                                                     |
| `GET /header-ui`                            | Header / system / log preview                                                                      |
| `GET /events`                               | SSE routing log stream                                                                             |
| `GET /api/logs`                             | Current in-memory router log backlog for dashboard hydration                                       |
| `GET /api/health`                           | Router + Ollama reachability                                                                       |
| `GET /api/system-stats`                     | CPU / RAM / VRAM / GPU snapshot                                                                    |
| `GET /api/model-status`                     | Loaded models, configured default, pooled cards, effective request context                         |
| `GET /api/ollama-models`                    | Installed tags with `context_max` enrichment and pool snapshot                                     |
| `GET /api/stats`                            | Counters, last route, cloud quota state, and a non-secret config snapshot including privacy status |
| `GET/POST /api/router/local-routing-config` | Read/write `local.models`, `smart_routing`, and `fast_model`                                       |
| `GET/POST /api/router/routing-mode`         | Read or change `routing.mode`                                                                      |
| `POST /api/local-model`                     | Set `local.model`                                                                                  |
| `GET/POST /api/model-params`                | Global generation defaults in `.claude/model-params.json`                                          |
| `GET /api/model-params-full`                | Built-in vs global vs per-model vs effective view                                                  |
| `POST /api/model-params-per-model`          | Per-model overrides                                                                                |
| `POST /api/router/model/start`              | Load the default Ollama model                                                                      |
| `POST /api/router/model/stop`               | Unload the default Ollama model                                                                    |
| `POST /api/router/model/restart`            | Restart the default Ollama model                                                                   |
| `GET /api/router/model-details`             | Modal payload for **Model details**                                                                |
| `POST /api/service/start`                   | Start Windows Ollama service                                                                       |
| `POST /api/service/stop`                    | Stop Windows Ollama service                                                                        |
| `POST /api/service/restart`                 | Restart Windows Ollama service                                                                     |

If **`ROUTER_ADMIN_TOKEN`** is set, mutating **POST**s need header **`X-Router-Token`** or **`Authorization: Bearer …`**.

---

## Repo layout

| Path                                | Purpose                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `router/server.js`                  | HTTP entry, proxy, embedded dashboard                                                                                                                                                                  |
| `router/lib/*.js`                   | Config, routing logic, model picker, metrics, admin auth                                                                                                                                               |
| `router/public/`                    | `header-ui.html`, CSS under `/assets/`, `claude-code-icon.svg` (Claude mark path from [Bootstrap Icons](https://github.com/twbs/icons) `claude`, MIT; `/assets/claude-icon.svg` aliases the same file) |
| `router/hybrid.config.example.json` | Template for `hybrid.config.json`                                                                                                                                                                      |
| `setup.ps1`                         | Setup entry (`-RoutingOnly`, `-ShortcutOnly`, `-Autostart`, …)                                                                                                                                         |
| `scripts/`                          | `diagnose-claude-hybrid.ps1`, `merge-claude-hybrid-env.js`, …                                                                                                                                          |
| `tests/`                            | `npm test` (Node), `npm run test:e2e-ui` (Playwright screenshots; install Chromium once)                                                                                                               |
| `powershell-profile-additions.ps1`  | Optional shell helpers                                                                                                                                                                                 |

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

**Privacy sanity check**

If you enable cloud redaction, open the dashboard, trigger a cloud-routed request, and inspect `/api/stats` plus the router log footer. The stats payload exposes whether privacy redaction is enabled and whether tool-result / identifier redaction is active, without exposing the redacted terms themselves.

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
- The fixed footer router log hydrates from `/api/logs` and then follows `/events`, so reconnects should keep the log populated instead of showing an empty panel.

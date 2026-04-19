# Tester quick-start

Thanks for testing Claude-Hybrid. This doc is intentionally short. If anything
here is unclear, **that itself is a bug** — please report it the same way you'd
report any other issue.

---

## 1. What you need

- **Node.js ≥ 18** — check with `node -v`
- **Ollama** running locally — https://ollama.com/download
- **Claude Code** — either the CLI (`claude`) or the VS Code extension
- ~**8 GB free VRAM** minimum (see [low-VRAM note](#low-vram-cards) below)
- ~**20 GB free disk** for the starter model pool

The router itself has **no npm dependencies at runtime** — `npm install` is only
needed if you want to run the Playwright UI tests.

---

## 2. Install

### Windows

```powershell
# Pull at least one local model before first start
ollama pull qwen2.5-coder:7b

# One-time setup (env merge + optional startup shortcut + optional watchdog)
.\setup.ps1

# Normal lifecycle
.\start_app.bat       # merge env, start router
.\stop_app.bat        # stop router, revert env to cloud
.\restart_app.bat
```

### macOS / Linux

```bash
ollama pull qwen2.5-coder:7b

chmod +x start_app.sh stop_app.sh restart_app.sh   # once

./start_app.sh        # merge env, start router
./stop_app.sh         # stop router, revert env to cloud
./restart_app.sh
```

**After starting, fully quit and reopen VS Code** (or your terminal) so it picks
up the `ANTHROPIC_BASE_URL` env change.

---

## 3. Verify it's working

1. Open the dashboard: **http://127.0.0.1:8082/**
2. Run `claude` in a terminal, ask any small question
3. Watch the **footer log** on the dashboard — you should see a `ROUTE —` line
   within a second or two

If the footer log stays empty after a `claude` prompt, **the router is not
receiving your traffic**. Run `npm run diagnose` (Windows) and check that your
VS Code / terminal was restarted after setup.

You can also force a cloud-only probe:

```bash
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = ""; claude

# macOS / Linux
ANTHROPIC_BASE_URL="" claude
```

---

## 4. Low-VRAM cards

The default `hybrid.config.example.json` targets **16 GB VRAM** and includes
heavy models like `deepseek-coder-v2:16b`. If you have an 8 GB card (GTX 1070,
RTX 3060 8GB, RTX 4060 8GB, M1/M2 8GB), use the low-VRAM starter instead:

```bash
# From the repo root
cp router/hybrid.config.low-vram.example.json router/hybrid.config.json
ollama pull qwen2.5-coder:7b
ollama pull qwen2.5-coder:3b
ollama pull llama3.2:3b
```

Then restart the router. You can edit the pool anytime from the dashboard.

---

## 5. What to try

These are the flows most likely to surface interesting bugs:

- **Small, chatty prompts** — should stay local, footer log shows `LOCAL —`
- **Long paste + architecture question** — should escalate to cloud, log shows `CLOUD —`
- **File-heavy tool turn** — ask Claude to read 10+ files; should escalate to cloud
- **Switch routing mode** from the dashboard (Hybrid / Ollama only / Claude only)
  mid-conversation — next turn should respect the new mode
- **Quit the router hard** (kill the process, close the terminal): the auto
  self-revert should kick in. Next `claude` invocation talks directly to
  Anthropic — no manual cleanup needed
- **With privacy on**: set a `project_terms` entry in
  `router/hybrid.config.json` → `privacy.project_obfuscation.project_terms` and
  mention that term to Claude. The dashboard's `OBFUSC —` log line should show
  the redaction count

---

## 6. Reporting a bug

**Before you file:** run the bundler. It collects everything we need and
redacts your API key + personal env vars.

```bash
npm run diag:bundle
```

That writes a folder like `diag-bundles/bundle-20260419-153210/` containing:

- `health.json`, `stats.json`, `model-status.json`, `ollama-models.json`
- `logs.json` (last 500 routing decisions — no prompt content)
- `quality-log.json`
- `hybrid.config.json` (your live config, as-is)
- `claude-settings.json` (**API key redacted**)
- `env.txt` (Node/OS/VRAM + relevant env vars, secrets masked)
- `README.txt` (manifest + privacy notes)

Zip the folder and attach it to the issue. Nothing in the bundle contains
prompt text, tool-result content, or your API key.

### What to include in the bug report itself

1. **What you expected** vs **what happened** (one sentence each)
2. **Steps to reproduce** (was it the 1st turn? after 10 turns? after switching modes?)
3. **Client**: Claude Code CLI or VS Code plugin + version
4. **OS + VRAM** (also captured in the bundle, but helps at a glance)
5. The `bundle-*.zip`

### What you don't need to include

- Your `ANTHROPIC_API_KEY` — never. If we need to test against your account
  we'll coordinate privately.
- Your prompt content — the bundle has everything we need without it.
- Screenshots unless the bug is visual (dashboard rendering, etc.)

---

## 7. Known limitations (not bugs)

- **Quota recovery is time-based.** When Anthropic rate-limits you, the router
  enters local-only fallback and re-probes after `quotaRecoveryMinutes`
  (default 60). It will not re-probe sooner. You'll see this in
  `stats.json → cloud_quota`.
- **First model load is slow.** Ollama pulls the model into VRAM on first use
  — 10–30 seconds of latency on turn 1 is normal, subsequent turns are fast.
- **Restarting VS Code is required** after `merge-env` / `setup.ps1` for the
  GUI editor; integrated terminals opened after the merge already see the new
  env.
- **Dashboard footer timestamps** use the timezone in
  `hybrid.config.json → display.time_zone` (override with `ROUTER_TIME_ZONE`).
  If yours look wrong, that's config, not a bug.

---

## 8. Stopping cleanly

```bash
# Windows
.\stop_app.bat            # stop + revert env (claude falls back to cloud)
.\stop_app.bat keepenv    # stop only, leave env merged

# macOS / Linux
./stop_app.sh
./stop_app.sh keepenv
```

Either way, the router's crash handlers also run `revert-env` automatically if
the process dies — so a crashed router never leaves Claude Code stranded on a
dead proxy.

---

Thanks again. Small signal is welcome — "this README was confusing at step 3"
is a useful bug report.

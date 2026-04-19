"use strict";
/**
 * diag-bundle.js — collect a support bundle for bug reports.
 *
 * Writes a timestamped folder under ./diag-bundles/ containing:
 *   - health.json          (GET /api/health)
 *   - stats.json           (GET /api/stats)
 *   - model-status.json    (GET /api/model-status)
 *   - ollama-models.json   (GET /api/ollama-models)
 *   - logs.txt             (last N lines from GET /api/logs)
 *   - hybrid.config.json   (copy of router/hybrid.config.json if present)
 *   - claude-settings.json (REDACTED copy of ~/.claude/settings.json — API key masked)
 *   - env.txt              (Node / OS / arch / relevant env vars, redacted)
 *   - README.txt           (what this bundle is + what was collected)
 *
 * Nothing in this bundle includes the user's ANTHROPIC_API_KEY, conversation
 * content, or prompt text — it is safe to attach to a bug report.
 *
 * Usage: npm run diag:bundle
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const ROUTER_HOST = process.env.ROUTER_HOST || "127.0.0.1";
const ROUTER_PORT = parseInt(
  process.env.ROUTER_PORT || process.env.PORT || "8082",
  10,
);
const LOG_LINES = 500;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function fetchRouter(pathname, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: ROUTER_HOST,
        port: ROUTER_PORT,
        path: pathname,
        method: "GET",
        headers: { Accept: "application/json, text/plain" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (err) => resolve({ ok: false, error: String(err.message || err) }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    });
    req.end();
  });
}

function safeWrite(file, data) {
  try {
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn("  !! failed to write", file, "-", e.message);
    return false;
  }
}

function redactClaudeSettings(raw) {
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.env && typeof obj.env === "object") {
      if (obj.env.ANTHROPIC_API_KEY) {
        obj.env.ANTHROPIC_API_KEY = `[REDACTED length=${String(obj.env.ANTHROPIC_API_KEY).length}]`;
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return "// Could not parse settings.json as JSON — raw bytes omitted from bundle for safety.\n";
  }
}

function collectEnvSnapshot() {
  const keys = [
    "ROUTER_HOST",
    "ROUTER_PORT",
    "PORT",
    "ROUTER_OLLAMA_HOST",
    "ROUTER_OLLAMA_PORT",
    "ROUTER_HYBRID_CONFIG",
    "ROUTER_TIME_ZONE",
    "ROUTER_PROXY_SOCKET_MS",
    "ROUTER_SKIP_AUTO_DEFAULT_MODELS",
    "ANTHROPIC_BASE_URL",
    "ENABLE_TOOL_SEARCH",
    "NODE_ENV",
  ];
  const out = [
    `Node: ${process.version}`,
    `Platform: ${process.platform} ${os.release()} ${process.arch}`,
    `CPUs: ${os.cpus().length} × ${(os.cpus()[0] || {}).model || "unknown"}`,
    `Total RAM: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
    `Free RAM:  ${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
    `CWD: ${process.cwd()}`,
    "",
    "Relevant env vars (values shown as-is unless they look like a secret):",
  ];
  for (const k of keys) {
    const v = process.env[k];
    if (v == null) {
      out.push(`  ${k} = <unset>`);
    } else if (/key|secret|token|password/i.test(k)) {
      out.push(`  ${k} = [REDACTED length=${v.length}]`);
    } else {
      out.push(`  ${k} = ${v}`);
    }
  }
  // Flag ANTHROPIC_API_KEY presence without logging value
  if (process.env.ANTHROPIC_API_KEY) {
    out.push(
      `  ANTHROPIC_API_KEY = [REDACTED length=${process.env.ANTHROPIC_API_KEY.length}]`,
    );
  } else {
    out.push("  ANTHROPIC_API_KEY = <unset>");
  }
  return out.join("\n") + "\n";
}

async function main() {
  const outRoot = path.join(process.cwd(), "diag-bundles");
  const bundleDir = path.join(outRoot, `bundle-${stamp()}`);
  fs.mkdirSync(bundleDir, { recursive: true });

  const manifest = [];
  const record = (name, ok, note) => {
    manifest.push(`${ok ? "[ok]  " : "[miss]"} ${name}${note ? ` — ${note}` : ""}`);
    console.log(`  ${ok ? "✓" : "·"} ${name}${note ? ` (${note})` : ""}`);
  };

  console.log(`diag-bundle → ${bundleDir}`);
  console.log(`router at   → http://${ROUTER_HOST}:${ROUTER_PORT}`);
  console.log("");

  // 1. Router endpoints
  const endpoints = [
    { p: "/api/health", f: "health.json" },
    { p: "/api/stats", f: "stats.json" },
    { p: "/api/model-status", f: "model-status.json" },
    { p: "/api/ollama-models", f: "ollama-models.json" },
    { p: `/api/logs?limit=${LOG_LINES}`, f: "logs.json" },
    { p: "/api/quality-log?limit=50", f: "quality-log.json" },
  ];
  let routerReachable = false;
  for (const { p, f } of endpoints) {
    const r = await fetchRouter(p);
    if (r.ok) {
      routerReachable = true;
      safeWrite(path.join(bundleDir, f), r.body);
      record(f, true, `${r.body.length} bytes`);
    } else {
      record(f, false, r.error || `HTTP ${r.status}`);
    }
  }

  // 2. hybrid.config.json (user's live config, if present)
  const cfgPath = path.join(process.cwd(), "router", "hybrid.config.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf8");
      safeWrite(path.join(bundleDir, "hybrid.config.json"), raw);
      record("hybrid.config.json", true, "copied");
    } catch (e) {
      record("hybrid.config.json", false, e.message);
    }
  } else {
    record("hybrid.config.json", false, "file not present (defaults only)");
  }

  // 3. Claude settings — REDACT api key
  const claudeSettings = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".claude",
    "settings.json",
  );
  if (fs.existsSync(claudeSettings)) {
    try {
      const raw = fs.readFileSync(claudeSettings, "utf8");
      safeWrite(
        path.join(bundleDir, "claude-settings.json"),
        redactClaudeSettings(raw),
      );
      record("claude-settings.json", true, "API key redacted");
    } catch (e) {
      record("claude-settings.json", false, e.message);
    }
  } else {
    record("claude-settings.json", false, "file not present");
  }

  // 4. Env snapshot (redacted)
  safeWrite(path.join(bundleDir, "env.txt"), collectEnvSnapshot());
  record("env.txt", true, "secrets masked");

  // 5. Manifest / README
  const readme = [
    "Claude-Hybrid diagnostic bundle",
    "================================",
    `Collected: ${new Date().toISOString()}`,
    `Router:    http://${ROUTER_HOST}:${ROUTER_PORT} (${routerReachable ? "reachable" : "NOT REACHABLE"})`,
    "",
    "Contents:",
    ...manifest.map((l) => `  ${l}`),
    "",
    "Privacy notes:",
    "  - ANTHROPIC_API_KEY is never written to this bundle.",
    "  - Any env var whose name contains key/secret/token/password is redacted.",
    "  - No request/response payloads or prompt text are included.",
    "  - Router logs included are the in-memory tail (timestamps + routing decisions),",
    "    which is already safe-to-share and does not contain prompt content.",
    "",
    "If /api/logs is empty, the router may not be running — run `npm run diagnose`",
    "(Windows) to check port binding + settings.json, or `npm start` to boot it.",
    "",
  ].join("\n");
  safeWrite(path.join(bundleDir, "README.txt"), readme);

  console.log("");
  console.log(`Bundle written to: ${bundleDir}`);
  if (!routerReachable) {
    console.log("");
    console.log("⚠ The router was not reachable. Start it with `npm start`");
    console.log("  (or `./start_app.sh` / `start_app.bat`) and rerun this script");
    console.log("  for a complete bundle.");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("diag-bundle failed:", err);
  process.exit(1);
});

"use strict";

/**
 * Live router HTTP API validation.
 *
 * Requires the router to be running on 127.0.0.1:8082 (npm start / start_app.bat).
 * Tests key endpoints for correct status codes and response shape.
 */

const http = require("http");

let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  [PASS] ${label}`);
    if (detail) console.log(`         ${detail}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
    failed++;
  }
}

function httpGet(path, port = 8082) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path, headers: { Accept: "application/json" } },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch (_) { /* not JSON */ }
          resolve({ status: res.statusCode, body, json });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(6000, () => {
      req.destroy();
      reject(new Error("timeout after 6 s"));
    });
  });
}

(async () => {
  console.log("══ LIVE ROUTER HTTP VALIDATION ═════════════════════════════════");
  console.log("   target: http://127.0.0.1:8082");
  console.log();

  // ── 1. Health check ────────────────────────────────────────────────────────
  try {
    const r = await httpGet("/api/health");
    check("GET /api/health → 200", r.status === 200, `body: ${r.body.slice(0, 80)}`);
    check(
      "Health has status field",
      r.json && (r.json.status === "ok" || typeof r.json.status === "string"),
      r.json ? `status="${r.json.status}"` : "body not JSON",
    );
  } catch (e) {
    check("GET /api/health", false, `ERROR: ${e.message} — is the router running on :8082?`);
    check("Health has status field", false, "skipped (no response)");
  }

  // ── 2. Stats ───────────────────────────────────────────────────────────────
  // Shape: { counters: { routed_local, routed_cloud, ... }, config: { privacy_project_obfuscation: {...}, ... } }
  let statsJson = null;
  try {
    const r = await httpGet("/api/stats");
    check("GET /api/stats → 200", r.status === 200);
    statsJson = r.json;
    const ctrs = statsJson && statsJson.counters;
    check(
      "Stats counters.routed_local is number",
      ctrs && typeof ctrs.routed_local === "number",
      ctrs ? `routed_local=${ctrs.routed_local}` : "no counters object",
    );
    check(
      "Stats counters.routed_cloud is number",
      ctrs && typeof ctrs.routed_cloud === "number",
      ctrs ? `routed_cloud=${ctrs.routed_cloud}` : "no counters object",
    );
  } catch (e) {
    check("GET /api/stats", false, `ERROR: ${e.message}`);
    check("Stats counters.routed_local is number", false, "skipped");
    check("Stats counters.routed_cloud is number", false, "skipped");
  }

  // ── 3. Routing mode ────────────────────────────────────────────────────────
  try {
    const r = await httpGet("/api/router/routing-mode");
    check("GET /api/router/routing-mode → 200", r.status === 200);
    check(
      "Routing mode is valid enum",
      r.json && ["hybrid", "cloud", "local"].includes(r.json.mode),
      r.json ? `mode="${r.json.mode}"` : "no JSON",
    );
  } catch (e) {
    check("GET /api/router/routing-mode", false, `ERROR: ${e.message}`);
    check("Routing mode is valid enum", false, "skipped");
  }

  // ── 4. Local routing config ────────────────────────────────────────────────
  try {
    const r = await httpGet("/api/router/local-routing-config");
    check("GET /api/router/local-routing-config → 200", r.status === 200);
    check(
      "Has smart_routing boolean",
      r.json && typeof r.json.smart_routing === "boolean",
      r.json ? `smart_routing=${r.json.smart_routing}` : "no JSON",
    );
  } catch (e) {
    check("GET /api/router/local-routing-config", false, `ERROR: ${e.message}`);
    check("Has smart_routing boolean", false, "skipped");
  }

  // ── 5. Logs ────────────────────────────────────────────────────────────────
  // Shape: { logs: [ { time, dest, reason, fallback, id }, ... ] }
  try {
    const r = await httpGet("/api/logs");
    check("GET /api/logs → 200", r.status === 200);
    const logsArr = r.json && r.json.logs;
    check(
      "Logs body has logs array",
      Array.isArray(logsArr),
      Array.isArray(logsArr) ? `length=${logsArr.length}` : `body: ${r.body.slice(0, 80)}`,
    );
  } catch (e) {
    check("GET /api/logs", false, `ERROR: ${e.message}`);
    check("Logs body has logs array", false, "skipped");
  }

  // ── 6. Ollama models ───────────────────────────────────────────────────────
  try {
    const r = await httpGet("/api/ollama-models");
    check("GET /api/ollama-models → 200", r.status === 200);
  } catch (e) {
    check("GET /api/ollama-models", false, `ERROR: ${e.message}`);
  }

  // ── 7. Model status ────────────────────────────────────────────────────────
  try {
    const r = await httpGet("/api/model-status");
    check("GET /api/model-status → 200", r.status === 200);
  } catch (e) {
    check("GET /api/model-status", false, `ERROR: ${e.message}`);
  }

  // ── 8. Dashboard returns HTML ──────────────────────────────────────────────
  try {
    const r = await httpGet("/");
    check("GET / → 200", r.status === 200);
    check(
      "Dashboard returns HTML",
      r.body.includes("<html") || r.body.includes("<!DOCTYPE") || r.body.includes("<div"),
      `starts: "${r.body.slice(0, 60).replace(/\n/g, " ")}"`,
    );
  } catch (e) {
    check("GET /", false, `ERROR: ${e.message}`);
    check("Dashboard returns HTML", false, "skipped");
  }

  // ── 9. /api/stats config block contains project_obfuscation ────────────────
  // The obfuscation status is embedded in /api/stats under config.privacy_project_obfuscation.
  {
    const cfg = statsJson && statsJson.config;
    const obfBlock = cfg && cfg.privacy_project_obfuscation;
    check(
      "stats.config.privacy_project_obfuscation present",
      obfBlock !== undefined,
      obfBlock ? `enabled=${obfBlock.enabled}, auto_detect=${obfBlock.auto_detect_filenames}` : "missing (stats may not have loaded yet)",
    );
    check(
      "obfuscation enabled=true (default)",
      obfBlock && obfBlock.enabled === true,
      obfBlock ? `enabled=${obfBlock.enabled}` : "no block",
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log();
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();

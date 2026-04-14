"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// ClaudeLlama Router — default http://127.0.0.1:8082 (ROUTER_PORT overrides)
// ─────────────────────────────────────────────────────────────────────────────
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec, execFile } = require("child_process");

// ─── Configuration ────────────────────────────────────────────────────────────
const {
  pathOnly,
  pickRunningModel,
  firstLoadedPsRow,
  listPsModels,
  psModelId,
  maxContextFromShow,
  modelNamesMatch,
} = require("./lib/model-utils");
const {
  analyzeMessages,
  normalizeRoutingMode,
  sanitizeRoutingThresholds,
} = require("./lib/routing-logic");
const { createMetrics } = require("./lib/metrics");
const {
  loadAndApply,
  watchConfig,
  saveLocalModel,
  saveLocalRoutingSettings,
  saveRoutingMode,
  localModelUnsetInConfigFile,
  localFastUnsetInConfigFile,
  configPath,
} = require("./lib/hybrid-config");
const { pickAutoDefaultModels } = require("./lib/auto-default-models");
const {
  resolveLocalPool,
  analyzeLocalTask,
  pickBestLocalModel,
  parseParameterBillions,
} = require("./lib/local-model-picker");
const { requireAdmin, getAdminToken } = require("./lib/admin-auth");
const { matchPresetPatch } = require("./lib/ollama-model-presets");
const {
  getCloudLimitFeedback,
  isCloudLimitResponse,
} = require("./lib/cloud-fallback");
const {
  DEFAULT_CLOUD_REDACTION,
  normalizeCloudRedactionConfig,
  redactCloudRequestBody,
} = require("./lib/privacy-redactor");
const {
  DEFAULT_PROJECT_OBFUSCATION,
  createProjectObfuscator,
  StreamDeobfuscator,
} = require("./lib/project-obfuscator");
const {
  DEFAULT_ABORT_PHRASES,
  checkNonStreamingContent,
  createStreamGuard,
} = require("./lib/cascade-guard");
const {
  selectEnrichmentHead,
  mergeEnrichedModels,
} = require("./lib/ollama-enrich-cap");
const {
  normalizeTimeZone,
  localResolvedTimeZone,
  formatClockTime,
} = require("./lib/time-format");

function normalizeCloudProtocol(input) {
  const v = String(input || "")
    .trim()
    .toLowerCase();
  return v === "http" ? "http" : "https";
}

const CFG = {
  port: (() => {
    const p = Number.parseInt(
      process.env.ROUTER_PORT || process.env.PORT || "8082",
      10,
    );
    return Number.isFinite(p) && p > 0 ? p : 8082;
  })(),
  listenHost: "127.0.0.1",
  display: {
    time_zone: normalizeTimeZone(process.env.ROUTER_TIME_ZONE),
  },
  local: {
    host: String(process.env.ROUTER_OLLAMA_HOST || "").trim() || "localhost",
    port: (() => {
      const p = Number.parseInt(process.env.ROUTER_OLLAMA_PORT || "11434", 10);
      return Number.isFinite(p) && p > 0 ? p : 11434;
    })(),
    model: "VladimirGav/gemma4-26b-16GB-VRAM:latest",
    models: [],
    smart_routing: true,
    fast_model: "",
    /** Abort local stream and retry cloud when model emits incapability phrase. */
    cascadeQuality: true,
  },
  cloud: {
    protocol: normalizeCloudProtocol(process.env.ROUTER_CLOUD_PROTOCOL),
    host:
      String(process.env.ROUTER_CLOUD_HOST || "").trim() || "api.anthropic.com",
    port: (() => {
      const proto = normalizeCloudProtocol(process.env.ROUTER_CLOUD_PROTOCOL);
      const fallback = proto === "http" ? 80 : 443;
      const p = Number.parseInt(
        process.env.ROUTER_CLOUD_PORT || String(fallback),
        10,
      );
      return Number.isFinite(p) && p > 0 ? p : fallback;
    })(),
  },
  privacy: {
    cloud_redaction: { ...DEFAULT_CLOUD_REDACTION },
    project_obfuscation: { ...DEFAULT_PROJECT_OBFUSCATION },
  },
  paramsFile: path.join(__dirname, "..", ".claude", "model-params.json"),
  perModelFile: path.join(
    __dirname,
    "..",
    ".claude",
    "model-params-per-model.json",
  ),
  resourcesDir: path.join(__dirname, "public", "css"),
  ollamaLogoCandidates: [
    path.join(
      __dirname,
      "..",
      "..",
      "ollama-dashboard",
      "app",
      "static",
      "ollama-logo.png",
    ),
    path.join(__dirname, "ollama-logo.png"),
  ],
  routing: {
    mode: "hybrid",
    tokenThreshold: 5000,
    fileReadThreshold: 10,
    keywords: [
      "architect",
      "security audit",
      "audit",
      "design pattern",
      "race condition",
      "performance optim",
      "system design",
      "data model",
      "api design",
      "deep reason",
    ].map((k) => String(k).toLowerCase()),
    /** Terms that force local routing before all other rules (e.g. internal codenames). */
    alwaysLocalTerms: [],
    /** When true + privacyCustomTerms, force local if any privacy term appears in the prompt. */
    forceLocalIfPrivacyTerms: false,
    /** Terms used by forceLocalIfPrivacyTerms to detect sensitive content. */
    privacyCustomTerms: [],
  },
};

const metrics = createMetrics();
const routerDir = __dirname;
function normalizeLocalCfg() {
  if (!Array.isArray(CFG.local.models)) CFG.local.models = [];
  if (typeof CFG.local.smart_routing !== "boolean")
    CFG.local.smart_routing = true;
  if (CFG.local.fast_model == null) CFG.local.fast_model = "";
  else CFG.local.fast_model = String(CFG.local.fast_model).trim();
}
function normalizeRoutingCfg() {
  CFG.routing.mode = normalizeRoutingMode(CFG.routing && CFG.routing.mode);
  sanitizeRoutingThresholds(CFG.routing);
}
function normalizeDisplayCfg() {
  CFG.display =
    CFG.display && typeof CFG.display === "object" ? CFG.display : {};
  CFG.display.time_zone =
    normalizeTimeZone(CFG.display.time_zone) || localResolvedTimeZone();
}
function onConfigReload() {
  loadAndApply(CFG, routerDir);
  normalizeLocalCfg();
  normalizeRoutingCfg();
  normalizeDisplayCfg();
  console.log(
    `[hybrid-config] reloaded listen=${CFG.listenHost} model=${CFG.local.model} mode=${CFG.routing.mode} fast=${CFG.local.fast_model || "(none)"} pool=${CFG.local.models.length || "all-tags"} smart=${CFG.local.smart_routing} thresholds=${CFG.routing.tokenThreshold}/${CFG.routing.fileReadThreshold} tz=${CFG.display.time_zone || "local"}`,
  );
  startIdleUnloadTimer();
}
loadAndApply(CFG, routerDir);
normalizeLocalCfg();
normalizeRoutingCfg();
normalizeDisplayCfg();
watchConfig(routerDir, onConfigReload);

// ─── Model parameters ─────────────────────────────────────────────────────────
const PARAM_DEFAULTS = {
  temperature: 0.8,
  top_p: 0.9,
  top_k: 40,
  num_ctx: 16384,  // raised from 4096 — gives Ollama 16k context by default
  seed: 0,
  num_predict: -1,
  repeat_penalty: 1.1,
  repeat_last_n: 64,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
  min_p: 0.05,
};

/** Align with dashboard generation sliders and Ollama practical limits. */
const GEN_NUM_CTX_MIN = 512;
const GEN_NUM_CTX_MAX = 131072;
const GEN_MAX_TOKENS_OUT = 131072;

function clampEffectiveParams(p) {
  const out = { ...p };
  let nctx = Number(out.num_ctx);
  if (!Number.isFinite(nctx)) nctx = PARAM_DEFAULTS.num_ctx;
  nctx = Math.round(nctx);
  nctx = Math.max(GEN_NUM_CTX_MIN, Math.min(GEN_NUM_CTX_MAX, nctx));
  out.num_ctx = nctx;
  let np = Number(out.num_predict);
  if (!Number.isFinite(np)) np = PARAM_DEFAULTS.num_predict;
  if (np < 0) {
    out.num_predict = -1;
  } else {
    np = Math.round(np);
    np = Math.max(1, Math.min(GEN_MAX_TOKENS_OUT, np));
    const maxOut = Math.max(256, nctx - 64);
    if (np > maxOut) np = maxOut;
    out.num_predict = np;
  }
  return out;
}

/** Sparse overrides on top of builtInParamsForModel (preset + generic defaults). */
let modelParams = {};
let perModelParams = {};
function coerceParamFileNumbers(obj) {
  const o = { ...obj };
  for (const k of Object.keys(PARAM_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) o[k] = n;
    }
  }
  return o;
}
function builtInParamsForModel(modelName) {
  return { ...PARAM_DEFAULTS, ...matchPresetPatch(modelName) };
}
function globalLayerMerged(modelName) {
  return { ...builtInParamsForModel(modelName), ...modelParams };
}
function sparseGlobalFromFullState(body, modelName) {
  const baseline = builtInParamsForModel(modelName);
  const sparse = {};
  for (const k of Object.keys(PARAM_DEFAULTS)) {
    const v = body[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const b = baseline[k];
    if (typeof b !== "number" || !Number.isFinite(b) || Math.abs(v - b) > 1e-9)
      sparse[k] = v;
  }
  return sparse;
}
function loadParams() {
  modelParams = {};
  try {
    if (!fs.existsSync(CFG.paramsFile)) return;
    const raw = JSON.parse(fs.readFileSync(CFG.paramsFile, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const allKeys = Object.keys(PARAM_DEFAULTS);
    const keysInFile = allKeys.filter((k) =>
      Object.prototype.hasOwnProperty.call(raw, k),
    );
    const merged = coerceParamFileNumbers({ ...PARAM_DEFAULTS, ...raw });
    if (keysInFile.length >= allKeys.length) {
      const sparse = {};
      for (const k of allKeys) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
        const v = merged[k];
        const d = PARAM_DEFAULTS[k];
        if (
          typeof v === "number" &&
          Number.isFinite(v) &&
          Math.abs(v - d) > 1e-9
        )
          sparse[k] = v;
      }
      modelParams = sparse;
    } else {
      for (const k of allKeys) {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
        modelParams[k] = merged[k];
      }
    }
  } catch {
    modelParams = {};
  }
}
function ensureClaudeConfigDir() {
  try {
    fs.mkdirSync(path.dirname(CFG.paramsFile), { recursive: true });
  } catch (e) {
    console.error("[model-params] mkdir failed:", e && e.message);
  }
}
function saveParams() {
  try {
    ensureClaudeConfigDir();
    fs.writeFileSync(CFG.paramsFile, JSON.stringify(modelParams, null, 2));
  } catch (e) {
    console.error("[model-params] save global failed:", e && e.message);
  }
}
function normModelKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}
function loadPerModelParams() {
  try {
    if (fs.existsSync(CFG.perModelFile)) {
      const raw = JSON.parse(fs.readFileSync(CFG.perModelFile, "utf8")) || {};
      perModelParams = {};
      for (const [modelKey, patch] of Object.entries(raw)) {
        if (patch && typeof patch === "object" && !Array.isArray(patch)) {
          perModelParams[modelKey] = coerceParamFileNumbers(patch);
        }
      }
    }
  } catch {
    perModelParams = {};
  }
}
function savePerModelParams() {
  try {
    ensureClaudeConfigDir();
    fs.writeFileSync(CFG.perModelFile, JSON.stringify(perModelParams, null, 2));
  } catch (e) {
    console.error("[model-params] save per-model failed:", e && e.message);
  }
}
function getPartialOverride(modelName) {
  const k = normModelKey(modelName);
  let o = perModelParams[k];
  if (o && typeof o === "object") return o;
  for (const [key, val] of Object.entries(perModelParams)) {
    if (normModelKey(key) === k && val && typeof val === "object") return val;
  }
  return {};
}
function effectiveParamsFor(modelName) {
  return clampEffectiveParams({
    ...globalLayerMerged(modelName),
    ...getPartialOverride(modelName),
  });
}
function cleanGlobalParamsFromJson(parsed) {
  const merged = {
    ...PARAM_DEFAULTS,
    ...(parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {}),
  };
  const c = coerceParamFileNumbers(merged);
  return sparseGlobalFromFullState(c, CFG.local.model);
}
function cleanPerModelFileFromJson(parsed) {
  const next = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return next;
  for (const [modelKey, patch] of Object.entries(parsed)) {
    const nk = normModelKey(modelKey);
    if (!nk || !patch || typeof patch !== "object" || Array.isArray(patch))
      continue;
    const c = coerceParamFileNumbers(patch);
    const clean = {};
    for (const k of Object.keys(PARAM_DEFAULTS)) {
      const v = c[k];
      if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length) next[nk] = clean;
  }
  return next;
}
function readModelParamsFileRaw(which) {
  const fp = which === "per-model" ? CFG.perModelFile : CFG.paramsFile;
  try {
    if (fs.existsSync(fp)) return fs.readFileSync(fp, "utf8");
  } catch {}
  return which === "per-model" ? "{}\n" : "{}\n";
}
loadParams();
loadPerModelParams();

// ─── System stats ─────────────────────────────────────────────────────────────
/** Serialize CPU deltas: parallel /api/system-stats requests shared one aggregate and corrupted % (boot script + doRefresh). */
let cpuSampleChain = Promise.resolve();
let lastCpuAgg = null;
function sumCpuTimes(t) {
  return Object.values(t).reduce((a, b) => a + b, 0);
}
function sampleCpuPercent() {
  const run = cpuSampleChain.then(() => {
    try {
      const cpus = os.cpus();
      const cur = cpus.reduce((a, c) => {
        for (const [k, v] of Object.entries(c.times)) a[k] = (a[k] || 0) + v;
        return a;
      }, {});
      let pct = 0;
      if (lastCpuAgg) {
        const idle = cur.idle - lastCpuAgg.idle;
        const total = sumCpuTimes(cur) - sumCpuTimes(lastCpuAgg);
        if (total > 0) {
          const ratio = 1 - idle / total;
          pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
        }
      }
      lastCpuAgg = cur;
      if (!Number.isFinite(pct)) return null;
      return pct;
    } catch {
      return null;
    }
  });
  cpuSampleChain = run.catch(() => null);
  return run.catch(() => null);
}

function parseNvidiaSmiCsv(stdout) {
  if (!stdout || typeof stdout !== "string") return null;
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const parts = line
      .split(",")
      .map((s) => parseFloat(String(s).trim().replace(/\s/g, "")));
    if (parts.length < 3) continue;
    const [tot, used, gpu] = parts;
    if (![tot, used, gpu].every((n) => Number.isFinite(n))) continue;
    return { vram_total_mb: tot, vram_used_mb: used, gpu_util: gpu };
  }
  return null;
}

let nvidiaCache = null,
  nvidiaCacheAt = 0;
function getNvidiaSmi() {
  if (nvidiaCache && Date.now() - nvidiaCacheAt < 5000)
    return Promise.resolve(nvidiaCache);
  return new Promise((resolve) => {
    const opts = { timeout: 4500 };
    if (process.platform === "win32") opts.windowsHide = true;
    try {
      execFile(
        "nvidia-smi",
        [
          "--query-gpu=memory.total,memory.used,utilization.gpu",
          "--format=csv,noheader,nounits",
        ],
        opts,
        (err, stdout) => {
          if (err) {
            nvidiaCache = null;
            return resolve(null);
          }
          const parsed = parseNvidiaSmiCsv(stdout);
          if (!parsed) {
            nvidiaCache = null;
            return resolve(null);
          }
          nvidiaCache = parsed;
          nvidiaCacheAt = Date.now();
          resolve(nvidiaCache);
        },
      );
    } catch {
      nvidiaCache = null;
      resolve(null);
    }
  });
}

let ollamaVersionCache = null;
async function getOllamaVersion() {
  if (ollamaVersionCache) return ollamaVersionCache;
  const r = await ollamaGet("/api/version");
  ollamaVersionCache = r?.version || null;
  return ollamaVersionCache;
}

// ─── Live log & SSE ───────────────────────────────────────────────────────────
const LOG_MAX = 200,
  log = [],
  clients = new Set();
let logSeq = 0;
function pushLog(entry) {
  const id = ++logSeq;
  const nextEntry =
    entry && typeof entry === "object"
      ? { ...entry, id }
      : { id, value: entry };
  log.push(nextEntry);
  if (log.length > LOG_MAX) log.shift();
  const data = `data: ${JSON.stringify(nextEntry)}\n\n`;
  for (const c of clients) {
    try {
      c.write(data);
    } catch {
      clients.delete(c);
    }
  }
}

/** Milliseconds without bytes on the outbound proxy socket before abort (resets on traffic). Default 300000 (5 min). Set ROUTER_PROXY_SOCKET_MS=0 to disable. */
function readProxySocketTimeoutMs() {
  const raw = process.env.ROUTER_PROXY_SOCKET_MS;
  if (raw != null && String(raw).trim() === "0") return 0;
  if (raw == null || String(raw).trim() === "") return 300000;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 300000;
  return n;
}
const PROXY_SOCKET_IDLE_MS = readProxySocketTimeoutMs();

function armProxyRequestTimeout(req, res, upstreamLabel) {
  if (!PROXY_SOCKET_IDLE_MS) return;
  req.setTimeout(PROXY_SOCKET_IDLE_MS);
  req.on("timeout", () => {
    try {
      req.destroy();
    } catch {}
    try {
      pushLog({
        value: `${upstreamLabel}: socket idle ${PROXY_SOCKET_IDLE_MS}ms (ROUTER_PROXY_SOCKET_MS)`,
      });
    } catch {}
    if (res.writableEnded) return;
    try {
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              type: "api_timeout",
              message: `Router timed out waiting for ${upstreamLabel} (${PROXY_SOCKET_IDLE_MS}ms). Set ROUTER_PROXY_SOCKET_MS higher or 0 to disable.`,
            },
          }),
        );
      } else {
        res.end();
      }
    } catch {}
  });
}

// ─── Routing ──────────────────────────────────────────────────────────────────
let lastLocalActivityMs = 0;
let cloudQuotaState = {
  exceeded: false,
  message: "",
  at: 0,
};

function markCloudQuotaExceeded(message) {
  const msg = String(message || "Cloud quota exceeded").trim();
  cloudQuotaState = {
    exceeded: true,
    message: msg,
    at: Date.now(),
  };
}

function clearCloudQuotaExceeded() {
  cloudQuotaState = {
    exceeded: false,
    message: "",
    at: 0,
  };
}

function getCloudQuotaState() {
  return {
    exceeded: !!cloudQuotaState.exceeded,
    message: cloudQuotaState.message || "",
    at: cloudQuotaState.at || 0,
    disabled_modes: cloudQuotaState.exceeded ? ["hybrid", "cloud"] : [],
  };
}

function routeTo(dest, reason, fallback = false, extra = {}) {
  const time = ts();
  metrics.recordRoute(dest, reason, fallback, time);
  const entry = { time, dest, reason, fallback, ...extra };
  process.stdout.write(
    `[${entry.time}] ${dest === "cloud" ? "CLOUD" : "LOCAL"} — ${reason}${fallback ? " (fallback)" : ""}\n`,
  );
  pushLog(entry);
  if (dest === "local" || fallback) lastLocalActivityMs = Date.now();
  return dest;
}
function ts() {
  return formatClockTime(new Date(), CFG.display.time_zone);
}
function fmt(n) {
  if (!n) return "—";
  const g = n / 1e9;
  return g >= 1 ? g.toFixed(1) + " GB" : (n / 1e6).toFixed(0) + " MB";
}

// ─── Idle auto-unload ────────────────────────────────────────────────────────
const IDLE_UNLOAD_DEFAULT_MIN = 2;
const IDLE_CHECK_INTERVAL_MS = 60_000;
let idleUnloadTimer = null;

function getIdleUnloadMinutes() {
  const v = CFG.local.idle_unload_minutes;
  if (v === 0 || v === false) return 0; // disabled
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : IDLE_UNLOAD_DEFAULT_MIN;
}

async function checkIdleUnload() {
  const minutes = getIdleUnloadMinutes();
  if (!minutes) return;
  if (!lastLocalActivityMs) return; // never used local
  const idleMs = Date.now() - lastLocalActivityMs;
  if (idleMs < minutes * 60_000) return;
  const ps = await ollamaGetPsWithRetry();
  const rows = listPsModels(ps);
  if (!rows.length) return; // nothing loaded
  for (const row of rows) {
    const name = psModelId(row);
    if (!name) continue;
    process.stdout.write(
      `[${ts()}] IDLE — unloading ${name} after ${minutes} min idle\n`,
    );
    await ollamaTouchModel(name, 0);
  }
  lastLocalActivityMs = 0; // reset so we don't re-trigger
}

function startIdleUnloadTimer() {
  if (idleUnloadTimer) clearInterval(idleUnloadTimer);
  if (!getIdleUnloadMinutes()) return;
  idleUnloadTimer = setInterval(() => {
    checkIdleUnload().catch(() => {});
  }, IDLE_CHECK_INTERVAL_MS);
}

// ─── Ollama helpers ───────────────────────────────────────────────────────────
/** Map Ollama /api/show capabilities[] to booleans (same aliases as ollama-dashboard main.js). */
function capabilityFlagsFromShow(show) {
  const unknown = { has_reasoning: null, has_vision: null, has_tools: null };
  if (!show || typeof show !== "object") return unknown;
  const raw = show.details?.capabilities ?? show.capabilities;
  if (!Array.isArray(raw) || raw.length === 0) return unknown;
  const capsLower = raw.map((c) => String(c).toLowerCase().trim());
  const hasAlias = (aliases) => aliases.some((a) => capsLower.includes(a));
  const visionAliases = ["vision", "image", "multimodal"];
  const toolsAliases = [
    "tools",
    "tool",
    "function",
    "function-calling",
    "tool-use",
  ];
  const reasoningAliases = ["reasoning", "thinking", "think"];
  return {
    has_reasoning: hasAlias(reasoningAliases),
    has_vision: hasAlias(visionAliases),
    has_tools: hasAlias(toolsAliases),
  };
}

function normalizeOllamaTagList(tagsBody) {
  if (!tagsBody || !Array.isArray(tagsBody.models)) return [];
  return tagsBody.models
    .map((m) => ({
      name: String(m.name || m.model || "").trim(),
      size: typeof m.size === "number" ? m.size : null,
      modified_at: m.modified_at || null,
      digest: m.digest || null,
    }))
    .filter((x) => x.name);
}

function ollamaGet(p) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: CFG.local.host,
        port: CFG.local.port,
        path: p,
        method: "GET",
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/** One retry if /api/ps is empty (scheduler race); same idea as ollama-dashboard. */
async function ollamaGetPsWithRetry() {
  let ps = await ollamaGet("/api/ps");
  if (listPsModels(ps).length === 0) {
    await new Promise((r) => setTimeout(r, 280));
    ps = await ollamaGet("/api/ps");
  }
  return ps;
}
function ollamaPost(p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: CFG.local.host,
        port: CFG.local.port,
        path: p,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

function ollamaTouchModel(modelName, keepAlive) {
  return ollamaPost("/api/generate", {
    model: modelName,
    prompt: " ",
    stream: false,
    keep_alive: keepAlive,
  });
}

/** Attach context_max from /api/show per tag (bounded concurrency) for installed-library cards. */
async function enrichModelsWithMaxContext(models) {
  if (!Array.isArray(models) || models.length === 0) return models;
  const concurrency = Math.min(4, models.length);
  const out = models.map((m) => ({ ...m, context_max: null }));
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= out.length) return;
      const show = await ollamaPost("/api/show", { model: out[i].name });
      out[i].context_max = maxContextFromShow(show);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

/** Enrich a bounded subset so large `ollama list` libraries cannot stall the dashboard. */
async function enrichModelListWithContextCap(models) {
  if (!Array.isArray(models) || models.length === 0) return models;
  const head = selectEnrichmentHead(models);
  const enrichedHead = await enrichModelsWithMaxContext(head);
  if (head.length === models.length) return enrichedHead;
  return mergeEnrichedModels(models, enrichedHead);
}

function formatParameterCountFromMi(pc) {
  if (typeof pc !== "number" || !Number.isFinite(pc) || pc <= 0) return null;
  const b = pc / 1e9;
  if (b >= 1) return b >= 10 ? `${Math.round(b)}B` : `${b.toFixed(1)}B`;
  const m = pc / 1e6;
  if (m >= 1) return `${Math.round(m)}M`;
  const k = pc / 1e3;
  if (k >= 1) return `${Math.round(k)}K`;
  return String(Math.round(pc));
}

/** Fill family / parameter_size from `model_info` when `details` is empty (common for some GGUF imports). */
function enrichDetailsFromModelInfo(details, show) {
  const d = details && typeof details === "object" ? { ...details } : {};
  const mi =
    show &&
    typeof show === "object" &&
    show.model_info &&
    typeof show.model_info === "object"
      ? show.model_info
      : {};
  const strOrNull = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  if (!strOrNull(d.family)) {
    if (Array.isArray(d.families) && d.families.length) {
      const joined = d.families
        .map((x) => String(x).trim())
        .filter(Boolean)
        .join(", ");
      if (joined) d.family = joined;
    }
    if (!strOrNull(d.family)) {
      const arch = strOrNull(mi["general.architecture"]);
      if (arch) d.family = arch;
    }
  }
  if (!strOrNull(d.parameter_size != null ? d.parameter_size : "")) {
    const raw = mi["general.parameter_count"];
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : NaN;
    const fmted = formatParameterCountFromMi(n);
    if (fmted) d.parameter_size = fmted;
  }
  return d;
}

function summarizeShow(show) {
  if (!show || typeof show !== "object") return null;
  const d = enrichDetailsFromModelInfo({ ...(show.details || {}) }, show);
  return {
    name: show.model || null,
    family: d.family || null,
    parameter_size: d.parameter_size || null,
    quantization_level: d.quantization_level || null,
    format: d.format || null,
    license: d.license || show.license || null,
    modified_at: show.modified_at || null,
    context_max: maxContextFromShow(show),
  };
}

/** /api/ps rows often omit `details`; /api/show has full metadata — merge for the dashboard card. */
function mergeModelDetailsFromShow(running, show) {
  if (!running || typeof running !== "object") return running;
  const psD =
    running.details && typeof running.details === "object"
      ? { ...running.details }
      : {};
  const shD =
    show && show.details && typeof show.details === "object"
      ? { ...show.details }
      : {};
  return { ...running, details: { ...psD, ...shD } };
}

function toFiniteNumberLoose(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Precomputed strings/numbers for the dashboard model card (avoids sparse `details` on the client). */
function buildCardSpecs(show, running) {
  if (!running || typeof running !== "object") return null;
  const merged = mergeModelDetailsFromShow(running, show);
  const det = enrichDetailsFromModelInfo(merged.details || {}, show);
  const strOrNull = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  return {
    family: strOrNull(det.family),
    parameter_size: strOrNull(
      det.parameter_size != null ? det.parameter_size : "",
    ),
    quantization_level: strOrNull(
      det.quantization_level != null ? det.quantization_level : "",
    ),
    size: toFiniteNumberLoose(running.size),
    size_vram: toFiniteNumberLoose(running.size_vram),
  };
}

function contextAllocatedFromPsRow(row) {
  if (!row || typeof row !== "object") return null;
  const tryOne = (v) => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0)
      return Math.trunc(v);
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return Math.trunc(n);
    }
    return null;
  };
  let a = tryOne(row.context_length) ?? tryOne(row.context_size);
  if (a == null && row.details && typeof row.details === "object") {
    a = tryOne(row.details.context_length) ?? tryOne(row.details.context_size);
  }
  return a;
}

const PROFILE_CACHE_TTL_MS = 6 * 60 * 1000;
let profileCache = { waveAt: 0, map: new Map() };

function buildModelProfile(name, show) {
  if (!show || typeof show !== "object" || show.error) {
    return {
      name,
      context_max: null,
      has_vision: null,
      has_tools: null,
      has_reasoning: null,
      param_billions: null,
      family: null,
    };
  }
  const caps = capabilityFlagsFromShow(show);
  const ctx = maxContextFromShow(show);
  const d = enrichDetailsFromModelInfo({ ...(show.details || {}) }, show);
  return {
    name,
    context_max: ctx,
    has_vision: caps.has_vision,
    has_tools: caps.has_tools,
    has_reasoning: caps.has_reasoning,
    param_billions: parseParameterBillions(d.parameter_size),
    family: d.family || null,
  };
}

async function ensureProfilesForModels(names) {
  const now = Date.now();
  if (now - profileCache.waveAt > PROFILE_CACHE_TTL_MS) {
    profileCache.map.clear();
  }
  profileCache.waveAt = now;
  const missing = names.filter((n) => !profileCache.map.has(n));
  await Promise.all(
    missing.map(async (name) => {
      const show = await ollamaPost("/api/show", { model: name });
      profileCache.map.set(name, buildModelProfile(name, show));
    }),
  );
}

// ─── Translation: Anthropic → OpenAI + inject params ─────────────────────────
function buildOpenAI(body, p, ollamaModelName) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  for (const msg of body.messages || []) {
    if (!Array.isArray(msg.content)) {
      messages.push({ role: msg.role, content: msg.content || "" });
      continue;
    }
    const textBlocks = msg.content.filter((b) => b.type === "text");
    const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
    const toolResBlocks = msg.content.filter((b) => b.type === "tool_result");
    if (toolResBlocks.length) {
      for (const b of toolResBlocks) {
        const content = Array.isArray(b.content)
          ? b.content.map((x) => x.text || "").join("\n")
          : b.content || "";
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content });
      }
      if (textBlocks.length)
        messages.push({
          role: "user",
          content: textBlocks.map((b) => b.text).join("\n"),
        });
    } else if (toolUseBlocks.length) {
      messages.push({
        role: "assistant",
        content: textBlocks.map((b) => b.text).join("\n") || null,
        tool_calls: toolUseBlocks.map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        })),
      });
    } else {
      messages.push({
        role: msg.role,
        content: textBlocks.map((b) => b.text).join("\n"),
      });
    }
  }
  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
  const ollamaName =
    (ollamaModelName && String(ollamaModelName).trim()) || CFG.local.model;
  const ctxNum = Number(p.num_ctx);
  const ctx =
    Number.isFinite(ctxNum) && ctxNum > 0
      ? Math.floor(ctxNum)
      : PARAM_DEFAULTS.num_ctx;
  let maxTok;
  if (p.num_predict > 0) {
    maxTok = Math.floor(Number(p.num_predict));
  } else {
    const fromBody =
      body.max_tokens != null ? Number(body.max_tokens) : Number.NaN;
    maxTok =
      Number.isFinite(fromBody) && fromBody > 0 ? Math.floor(fromBody) : 8192;
  }
  if (!Number.isFinite(maxTok) || maxTok < 1) maxTok = 8192;
  const outBudget = Math.max(256, ctx - 64);
  maxTok = Math.min(maxTok, GEN_MAX_TOKENS_OUT, outBudget);
  const out = {
    model: ollamaName,
    messages,
    stream: !!body.stream,
    max_tokens: maxTok,
    temperature: p.temperature,
    top_p: p.top_p,
    top_k: p.top_k,
    seed: p.seed || undefined,
    repeat_penalty: p.repeat_penalty,
    repeat_last_n: p.repeat_last_n,
    presence_penalty: p.presence_penalty || undefined,
    frequency_penalty: p.frequency_penalty || undefined,
    min_p: p.min_p || undefined,
    num_ctx: p.num_ctx,
  };
  if (tools.length) out.tools = tools;
  return out;
}

// ─── Translation: OpenAI → Anthropic (non-streaming) ─────────────────────────
function toAnthropic(oai, model) {
  const choice = oai.choices?.[0],
    msg = choice?.message || {};
  const content = [];
  const textBody = msg.content || msg.reasoning || "";
  if (textBody) content.push({ type: "text", text: textBody });
  for (const tc of msg.tool_calls || [])
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input: (() => {
        try {
          return JSON.parse(tc.function.arguments);
        } catch {
          return {};
        }
      })(),
    });
  const stopMap = {
    stop: "end_turn",
    tool_calls: "tool_use",
    length: "max_tokens",
  };
  return {
    id: oai.id || `msg_local_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopMap[choice?.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens || 0,
      output_tokens: oai.usage?.completion_tokens || 0,
    },
  };
}

// ─── Streaming: OpenAI SSE → Anthropic SSE ────────────────────────────────────
function pipeLocalStream(src, res, model) {
  const msgId = `msg_local_${Date.now()}`;
  let buf = "",
    started = false,
    blockIdx = 0,
    textOpen = false,
    toolOpen = false,
    toolI = null;
  const tools = {};
  const send = (ev, data) =>
    res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const ensureStarted = () => {
    if (started) return;
    started = true;
    send("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    send("ping", { type: "ping" });
  };
  const openText = () => {
    if (textOpen) return;
    if (toolOpen) {
      send("content_block_stop", {
        type: "content_block_stop",
        index: blockIdx,
      });
      blockIdx++;
      toolOpen = false;
      toolI = null;
    }
    textOpen = true;
    send("content_block_start", {
      type: "content_block_start",
      index: blockIdx,
      content_block: { type: "text", text: "" },
    });
  };
  const openTool = (i, tid, name) => {
    if (toolOpen && toolI === i) return;
    if (textOpen) {
      send("content_block_stop", {
        type: "content_block_stop",
        index: blockIdx,
      });
      blockIdx++;
      textOpen = false;
    }
    if (toolOpen && toolI !== i) {
      send("content_block_stop", {
        type: "content_block_stop",
        index: blockIdx,
      });
      blockIdx++;
    }
    toolOpen = true;
    toolI = i;
    send("content_block_start", {
      type: "content_block_start",
      index: blockIdx,
      content_block: { type: "tool_use", id: tid, name, input: {} },
    });
  };
  src.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;
      let p;
      try {
        p = JSON.parse(raw);
      } catch {
        continue;
      }
      const d = p.choices?.[0]?.delta,
        fin = p.choices?.[0]?.finish_reason;
      if (!d && !fin) continue;
      ensureStarted();
      const textChunk = d?.content || d?.reasoning || "";
      if (textChunk) {
        openText();
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIdx,
          delta: { type: "text_delta", text: textChunk },
        });
      }
      if (d?.tool_calls) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!tools[i])
            tools[i] = {
              id: tc.id || `toolu_${Date.now()}_${i}`,
              name: tc.function?.name || "",
            };
          if (tc.id) tools[i].id = tc.id;
          if (tc.function?.name) tools[i].name = tc.function.name;
          openTool(i, tools[i].id, tools[i].name);
          if (tc.function?.arguments)
            send("content_block_delta", {
              type: "content_block_delta",
              index: blockIdx,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
        }
      }
      if (fin) {
        if (textOpen || toolOpen)
          send("content_block_stop", {
            type: "content_block_stop",
            index: blockIdx,
          });
        ensureStarted();
        const stopMap = {
          stop: "end_turn",
          tool_calls: "tool_use",
          length: "max_tokens",
        };
        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: stopMap[fin] || "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 0 },
        });
        send("message_stop", { type: "message_stop" });
      }
    }
  });
  src.on("end", () => res.end());
  src.on("error", () => res.end());
}

// ─── Proxies ──────────────────────────────────────────────────────────────────
function ollamaUnreachableMayUseCloud() {
  return normalizeRoutingMode(CFG.routing.mode) !== "local";
}

function proxyCloud(incoming, rawBody, body, res, fallback = false) {
  const cloudLimitRoute = {
    dest: "local",
    reason: "cloud limit detected, fallback to local",
  };
  const cloudTransport = CFG.cloud.protocol === "http" ? http : https;
  const privacy = redactCloudRequestBody(body, CFG.privacy.cloud_redaction);
  let cloudBody = privacy.changed ? privacy.body : body;

  // ── Bidirectional project obfuscation ──────────────────────────────────────
  // Scans the (possibly already privacy-redacted) body for project-specific
  // file names, identifiers, and configured project_terms, then replaces them
  // with neutral aliases before forwarding to Anthropic.  The same obfuscator
  // instance is used to reverse the aliases in the cloud response so Claude
  // Code tools (Read, Edit, Bash, Glob…) receive real file paths and names.
  const projObf = createProjectObfuscator(
    CFG.privacy.project_obfuscation,
    cloudBody,
  );
  let bodyModified = privacy.changed;
  if (projObf) {
    const { body: obfBody, changed } = projObf.obfuscateBody(cloudBody);
    if (changed) { cloudBody = obfBody; bodyModified = true; }
  }

  const cloudRawBody = bodyModified
    ? Buffer.from(JSON.stringify(cloudBody))
    : rawBody;
  if (fallback)
    routeTo("cloud", "Ollama unreachable", true, { cloud_model: body.model });
  const streaming = !!cloudBody.stream;
  const opts = {
    hostname: CFG.cloud.host,
    port: CFG.cloud.port,
    path: incoming.url,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(cloudRawBody),
      ...(incoming.headers["x-api-key"] && {
        "x-api-key": incoming.headers["x-api-key"],
      }),
      ...(incoming.headers["authorization"] && {
        authorization: incoming.headers["authorization"],
      }),
      ...(incoming.headers["anthropic-version"] && {
        "anthropic-version": incoming.headers["anthropic-version"],
      }),
      ...(incoming.headers["anthropic-beta"] && {
        "anthropic-beta": incoming.headers["anthropic-beta"],
      }),
    },
  };
  const req = cloudTransport.request(opts, (upstream) => {
    const canFallbackLocal = !fallback;
    if (streaming) {
      if (upstream.statusCode >= 400) {
        const chunks = [];
        upstream.on("data", (c) => chunks.push(c));
        upstream.on("end", () => {
          const bodyBuf = Buffer.concat(chunks);
          const bodyTxt = bodyBuf.toString();
          const feedback = getCloudLimitFeedback(
            upstream.statusCode,
            bodyTxt,
            upstream.headers["content-type"],
          );
          if (
            canFallbackLocal &&
            isCloudLimitResponse(
              upstream.statusCode,
              bodyTxt,
              upstream.headers["content-type"],
            )
          ) {
            markCloudQuotaExceeded(feedback || bodyTxt);
            routeTo("local", "cloud limit detected, fallback to local", true);
            return proxyLocal(incoming, body, res, rawBody, cloudLimitRoute);
          }
          res.writeHead(upstream.statusCode, {
            "Content-Type": "application/json",
          });
          res.end(bodyBuf);
        });
        return;
      }
      let redirected = false;
      let sniffing = true;
      const sniffedChunks = [];
      let sniffedBytes = 0;
      // Stream-level deobfuscator: restores project aliases in SSE chunks.
      // Uses a tail-buffer so aliases split across chunk boundaries are handled.
      const streamDeobf = projObf ? new StreamDeobfuscator(projObf) : null;
      const writeChunk = streamDeobf
        ? (chunk) => {
            const out = streamDeobf.process(chunk);
            if (out.length) res.write(out);
          }
        : (chunk) => res.write(chunk);
      const flushStream = () => {
        if (redirected || !sniffing) return;
        sniffing = false;
        clearCloudQuotaExceeded();
        res.writeHead(upstream.statusCode, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        for (const chunk of sniffedChunks) writeChunk(chunk);
        sniffedChunks.length = 0;
      };
      upstream.on("data", (chunk) => {
        if (redirected) return;
        if (!sniffing) {
          writeChunk(chunk);
          return;
        }
        sniffedChunks.push(chunk);
        sniffedBytes += chunk.length;
        const preview = Buffer.concat(sniffedChunks).toString("utf8");
        const feedback = getCloudLimitFeedback(
          upstream.statusCode,
          preview,
          upstream.headers["content-type"],
        );
        if (
          canFallbackLocal &&
          isCloudLimitResponse(
            upstream.statusCode,
            preview,
            upstream.headers["content-type"],
          )
        ) {
          redirected = true;
          markCloudQuotaExceeded(feedback || preview);
          try {
            upstream.destroy();
          } catch {}
          routeTo("local", "cloud limit detected, fallback to local", true);
          void proxyLocal(incoming, body, res, rawBody, cloudLimitRoute);
          return;
        }
        if (preview.includes("\n\n") || sniffedBytes >= 65536) {
          flushStream();
        }
      });
      upstream.on("end", () => {
        if (redirected) return;
        flushStream();
        if (streamDeobf) {
          const tail = streamDeobf.flush();
          if (tail.length) res.write(tail);
        }
        res.end();
      });
      upstream.on("error", () => {
        if (redirected) return;
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "cloud stream error" }));
          return;
        }
        res.end();
      });
      return;
    }

    const chunks = [];
    upstream.on("data", (c) => chunks.push(c));
    upstream.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      const bodyTxt = bodyBuf.toString();
      const feedback = getCloudLimitFeedback(
        upstream.statusCode,
        bodyTxt,
        upstream.headers["content-type"],
      );
      if (
        canFallbackLocal &&
        isCloudLimitResponse(
          upstream.statusCode,
          bodyTxt,
          upstream.headers["content-type"],
        )
      ) {
        markCloudQuotaExceeded(feedback || bodyTxt);
        routeTo("local", "cloud limit detected, fallback to local", true);
        return proxyLocal(incoming, body, res, rawBody, cloudLimitRoute);
      }
      if (upstream.statusCode < 400) clearCloudQuotaExceeded();
      // Deobfuscate project aliases in the full response body
      let finalBuf = bodyBuf;
      if (projObf) {
        const deobfText = projObf.deobfuscateString(bodyTxt);
        if (deobfText !== bodyTxt) finalBuf = Buffer.from(deobfText, "utf8");
      }
      res.writeHead(upstream.statusCode, {
        "Content-Type": "application/json",
      });
      res.end(finalBuf);
    });
  });
  req.on("error", () => {
    if (!res.headersSent)
      res.writeHead(502).end(JSON.stringify({ error: "cloud error" }));
  });
  armProxyRequestTimeout(req, res, "Anthropic API");
  req.write(cloudRawBody);
  req.end();
}
function proxyLocal(incoming, body, res, rawBody, routeSummary) {
  const streaming = !!body.stream;
  const anthropicModel = body.model || "unknown";
  (async () => {
    let chosen = CFG.local.model;
    let pickReason = "default model";
    try {
      const tagsBody = await ollamaGet("/api/tags");
      const tagList = normalizeOllamaTagList(tagsBody).map((m) => m.name);
      const pool = resolveLocalPool(CFG, tagList);
      if (!pool.length) {
        chosen = CFG.local.model;
        pickReason = "empty pool (fallback)";
      } else if (pool.length === 1) {
        chosen = pool[0];
        pickReason = "only one model in pool";
      } else if (!CFG.local.smart_routing) {
        chosen = pool.includes(CFG.local.model) ? CFG.local.model : pool[0];
        pickReason = "smart routing off";
      } else {
        await ensureProfilesForModels(pool);
        let profiles = pool.map((n) => profileCache.map.get(n)).filter(Boolean);
        if (!profiles.length) {
          profiles = pool.map((name) => buildModelProfile(name, null));
        }
        const task = analyzeLocalTask(body);
        const effCtx = effectiveParamsFor(CFG.local.model).num_ctx;
        const pick = pickBestLocalModel(
          profiles,
          task,
          CFG.local.model,
          effCtx,
          CFG.local.fast_model,
        );
        chosen = pick.model;
        pickReason = pick.reason;
      }
      const p = effectiveParamsFor(chosen);
      const openaiBody = JSON.stringify(buildOpenAI(body, p, chosen));
      routeTo(
        "local",
        `${routeSummary.reason} · ${chosen} — ${pickReason}`,
        false,
        { local_model: chosen },
      );
      const opts = {
        hostname: CFG.local.host,
        port: CFG.local.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(openaiBody),
          authorization: "Bearer ollama",
        },
      };
      const req = http.request(opts, (upstream) => {
        if (upstream.statusCode !== 200) {
          if (ollamaUnreachableMayUseCloud())
            return proxyCloud(incoming, rawBody, body, res, true);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "Ollama error (Ollama-only mode: no cloud fallback)",
              }),
            );
          }
          return;
        }
        if (streaming) {
          const useCascade = CFG.local.cascadeQuality && ollamaUnreachableMayUseCloud();
          if (useCascade) {
            const guard = createStreamGuard(upstream, DEFAULT_ABORT_PHRASES);
            guard.once("abort", ({ phrase }) => {
              // Local model signalled it can't answer — transparent cloud retry.
              // Record as a proper fallback so dashboard metrics reflect reality:
              // cascade aborts are cloud requests, not local successes.
              metrics.recordCascadeAbort(chosen);
              routeTo("cloud", `cascade abort: "${phrase}"`, true, { cloud_model: body.model });
              if (!res.headersSent) {
                proxyCloud(incoming, rawBody, body, res, false);
              }
            });
            guard.once("flushing", () => {
              // Quality gate passed — write headers now and forward stream
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
              });
              pipeLocalStream(guard, res, anthropicModel);
            });
          } else {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            });
            pipeLocalStream(upstream, res, anthropicModel);
          }
        } else {
          const chunks = [];
          upstream.on("data", (c) => chunks.push(c));
          upstream.on("end", () => {
            try {
              const oai = JSON.parse(Buffer.concat(chunks).toString());
              // Cascade quality check for non-streaming responses
              if (CFG.local.cascadeQuality && ollamaUnreachableMayUseCloud()) {
                const responseText =
                  oai.choices?.[0]?.message?.content || "";
                const phrase = checkNonStreamingContent(responseText, DEFAULT_ABORT_PHRASES);
                if (phrase) {
                  metrics.recordCascadeAbort(chosen);
                  routeTo("cloud", `cascade abort: "${phrase}"`, true, { cloud_model: body.model });
                  return proxyCloud(incoming, rawBody, body, res, false);
                }
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(toAnthropic(oai, anthropicModel)));
            } catch {
              if (ollamaUnreachableMayUseCloud())
                proxyCloud(incoming, rawBody, body, res, true);
              else if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: "Bad response from Ollama (Ollama-only mode)",
                  }),
                );
              }
            }
          });
        }
      });
      req.on("error", () => {
        if (ollamaUnreachableMayUseCloud())
          proxyCloud(incoming, rawBody, body, res, true);
        else if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "Ollama unreachable (Ollama-only mode)" }),
          );
        }
      });
      armProxyRequestTimeout(req, res, "Ollama");
      req.write(openaiBody);
      req.end();
    } catch {
      if (ollamaUnreachableMayUseCloud())
        proxyCloud(incoming, rawBody, body, res, true);
      else if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Ollama unreachable (Ollama-only mode)" }),
        );
      }
    }
  })();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function paramSlider(key, label, desc, min, max, step, val, tip = "") {
  const tipAttr = tip ? ` data-tip="${tip.replace(/"/g, "&quot;")}"` : "";
  return `<div class="param-item" data-param="${key}"><div class="param-label"><span class="param-label-text"${tipAttr}>${label}${tip ? '<i class="tip-icon">?</i>' : ""}</span><span class="param-default-pill built-in" id="pill-${key}">Default</span><span class="param-val" id="v-${key}">${val}</span></div><input type="range" id="p-${key}" min="${min}" max="${max}" step="${step}" value="${val}"><div class="param-desc">${desc}</div></div>`;
}
function paramNumber(key, label, desc, min, max, val, tip = "") {
  const tipAttr = tip ? ` data-tip="${tip.replace(/"/g, "&quot;")}"` : "";
  return `<div class="param-item" data-param="${key}"><div class="param-label"><span class="param-label-text"${tipAttr}>${label}${tip ? '<i class="tip-icon">?</i>' : ""}</span><span class="param-default-pill built-in" id="pill-${key}">Default</span></div><input type="number" class="param-num" id="p-${key}" min="${min}" max="${max}" value="${val}"><div class="param-desc">${desc}</div></div>`;
}

/** JSON.stringify output safe for embedding in an inline HTML script (avoids closing the script tag on U+003C in data). */
function jsonForInlineScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function dashboardHTML(cfg) {
  const p = effectiveParamsFor(cfg.local.model);
  const routingModeInitial = normalizeRoutingMode(
    cfg.routing && cfg.routing.mode,
  );
  const routingModeLabel =
    routingModeInitial === "cloud"
      ? "Claude only"
      : routingModeInitial === "local"
        ? "Ollama only"
        : "Hybrid";
  return `<!DOCTYPE html>
<html lang="en" class="dark hybrid-dashboard">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClaudeLlama Router</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
<link rel="stylesheet" href="/assets/dashboard-extra.css">
<link rel="stylesheet" href="/assets/ollama-dashboard-model-card.css">
<style>
:root{
  --dash-max-w:min(1280px,calc(100vw - 28px));
  --hdr-anchor-offset:min(132px,28vh);
  --dash-section-gap:16px;
  --dash-card-pad:14px 16px;
  --dash-card-radius:12px;
  --dash-inline-pad:clamp(14px,2.5vw,20px);
  --bg:#0d0d0d;--surface:#161616;--surface2:#1e1e1e;--border:rgba(255,255,255,.07);--border2:rgba(255,255,255,.12);
  --text:#e2e2e2;--text2:#999;--text3:#555;--accent:#3b82f6;--green:#22c55e;--blue:#60a5fa;--amber:#f59e0b;
  --header-bg:rgba(10,10,10,.85);--header-border:rgba(255,255,255,.06);
  --chip-bg:rgba(255,255,255,.05);--chip-border:rgba(255,255,255,.09);
  --meta-bg:rgba(255,255,255,.03);--meta-border:rgba(255,255,255,.07);
  --res-bg:rgba(255,255,255,.02);--res-border:rgba(255,255,255,.05);
  --btn-bg:rgba(255,255,255,.07);--btn-border:rgba(255,255,255,.1);--btn-text:#ccc;
  --tile-bg:rgba(255,255,255,.03);--tile-border:rgba(255,255,255,.06);
  --toggle-bg:rgba(255,255,255,.06);--toggle-border:rgba(255,255,255,.1);--toggle-fg:#bbb;
}
html.light{
  --bg:#f0f0f0;--surface:#ffffff;--surface2:#f5f5f5;--border:rgba(0,0,0,.1);--border2:rgba(0,0,0,.15);
  --text:#1a1a1a;--text2:#555;--text3:#999;
  --header-bg:rgba(240,240,240,.92);--header-border:rgba(0,0,0,.08);
  --chip-bg:rgba(0,0,0,.05);--chip-border:rgba(0,0,0,.1);
  --meta-bg:rgba(0,0,0,.03);--meta-border:rgba(0,0,0,.08);
  --res-bg:rgba(0,0,0,.02);--res-border:rgba(0,0,0,.07);
  --btn-bg:rgba(0,0,0,.06);--btn-border:rgba(0,0,0,.12);--btn-text:#444;
  --tile-bg:rgba(0,0,0,.03);--tile-border:rgba(0,0,0,.07);
  --toggle-bg:rgba(0,0,0,.06);--toggle-border:rgba(0,0,0,.12);--toggle-fg:#444;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.45;padding-top:0;padding-bottom:200px}
a{color:inherit}

/* ── Header ──────────────────────────────────────────────────────── */
.hdr{position:sticky;top:0;z-index:100;background:var(--header-bg);border-bottom:1px solid var(--header-border);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:0}
.hdr-inner{max-width:var(--dash-max-w);margin:0 auto;padding:.45rem var(--dash-inline-pad) .35rem}
.hdr-bar{display:flex;align-items:center;gap:.65rem;flex-wrap:wrap;position:relative;padding-right:2.6rem}
.hdr-system{padding:0 0 .5rem}
.hdr-left{display:flex;align-items:center;gap:.4rem;flex:1 1 auto}
.hdr-logos{display:inline-flex;align-items:center;gap:6px;flex-shrink:0}
.hdr-logo{
  width:24px;
  height:24px;
  border-radius:50%;
  background:#fff;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex-shrink:0;
  overflow:hidden;
}
.hdr-logo img{
  width:100%;
  height:100%;
  object-fit:contain;
  display:block;
}
.health-badge{display:inline-flex;align-items:center;gap:.3rem;padding:.2rem .55rem;border-radius:20px;font-size:11.5px;font-weight:600;white-space:nowrap;border:1px solid transparent;transition:all .3s}
.health-badge.healthy{background:rgba(34,197,94,.12);color:#4ade80;border-color:rgba(34,197,94,.25)}
.health-badge.degraded{background:rgba(234,179,8,.12);color:#facc15;border-color:rgba(234,179,8,.25)}
.health-badge.unhealthy{background:rgba(239,68,68,.12);color:#f87171;border-color:rgba(239,68,68,.25)}
.health-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 2s infinite}
.svc-btns{display:flex;gap:.25rem;align-items:center}
.svc-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--btn-text);cursor:pointer;font-size:11px;transition:all .15s}
.vram-model-actions .svc-btn{width:auto;min-width:28px;padding:0 10px;white-space:nowrap}
.svc-btn:hover:not(:disabled){filter:brightness(1.3)}
.svc-btn:disabled{opacity:.35;cursor:not-allowed}
.svc-btn.start{color:#4ade80;border-color:rgba(34,197,94,.3)}
.svc-btn.stop{color:#f87171;border-color:rgba(239,68,68,.3)}
.svc-btn.restart{color:#facc15;border-color:rgba(234,179,8,.3)}
.hdr-brand{font-size:12px;font-weight:700;color:var(--text);letter-spacing:-.02em;margin-left:2px;white-space:nowrap}
@media(max-width:480px){.hdr-brand{display:none}}
.routing-mode-btn{
  font-size:11px;font-weight:700;padding:4px 10px;border-radius:8px;border:1px solid transparent;cursor:pointer;white-space:nowrap;flex-shrink:0;
  transition:filter .15s,transform .12s,box-shadow .15s;
  font-family:inherit;
}
.routing-mode-btn:hover{filter:brightness(1.12)}
.routing-mode-btn:active{transform:scale(.97)}
.routing-mode-btn--section{
  display:inline-flex;align-items:center;justify-content:center;gap:.35rem;
  min-height:40px;padding:10px 20px;font-size:12.5px;font-weight:700;border-radius:10px;border-width:2px;
  box-shadow:0 2px 4px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.08);
}
.routing-mode-btn--section:hover{
  filter:brightness(1.06);
  box-shadow:0 4px 14px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.1);
  transform:translateY(-1px);
}
.routing-mode-btn--section:active{
  transform:translateY(0) scale(.98);
  box-shadow:0 1px 3px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.06);
}
.routing-mode-btn--section:focus-visible{
  outline:2px solid var(--accent);outline-offset:3px;
}
.routing-mode-btn-group{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:stretch}
.routing-mode-btn--choice{min-width:120px;flex:0 1 auto;flex-direction:column;align-items:flex-start;padding:10px 14px;text-align:left}
.routing-mode-btn-main{display:block;font-size:12.5px;font-weight:700;line-height:1.2}
.routing-mode-btn-sub{display:block;font-size:10px;font-weight:600;line-height:1.25;opacity:.86;margin-top:2px}
.routing-mode-btn--choice.is-active{
  outline:3px solid rgba(255,255,255,.42);
  outline-offset:0;
  transform:translateY(-1px) scale(1.02);
  filter:saturate(1.14) brightness(1.08);
  box-shadow:0 0 0 1px rgba(255,255,255,.16),0 12px 24px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.18);
}
.routing-mode-btn--choice.is-active .routing-mode-btn-main{color:#fff}
.routing-mode-btn--choice.is-active .routing-mode-btn-sub{color:rgba(255,255,255,.94);opacity:1}
.routing-mode-btn--choice.is-disabled,
.routing-mode-btn--choice:disabled{
  background:rgba(148,163,184,.12) !important;
  border-color:rgba(148,163,184,.24) !important;
  color:#94a3b8 !important;
  box-shadow:none !important;
  cursor:not-allowed;
  filter:none !important;
  transform:none !important;
}
.routing-mode-btn--choice.is-disabled .routing-mode-btn-sub,
.routing-mode-btn--choice:disabled .routing-mode-btn-sub{color:#cbd5e1;opacity:.92}
.routing-mode-status{display:none;margin-top:8px;padding:8px 10px;border-radius:10px;border:1px solid rgba(148,163,184,.22);background:rgba(148,163,184,.08);font-size:11px;line-height:1.45;color:var(--text2)}
.routing-mode-status.is-visible{display:block}
.routing-mode-status strong{color:var(--text)}
html.light .routing-mode-btn--choice.is-disabled,
html.light .routing-mode-btn--choice:disabled{background:rgba(148,163,184,.16) !important;color:#64748b !important;border-color:rgba(100,116,139,.24) !important}
html.light .routing-mode-status{background:rgba(148,163,184,.12);border-color:rgba(100,116,139,.2);color:#475569}
.routing-mode--hybrid{background:rgba(245,158,11,.22);color:#fbbf24;border-color:rgba(245,158,11,.5);box-shadow:0 0 0 1px rgba(245,158,11,.12)}
.routing-mode--cloud{background:rgba(167,139,250,.22);color:#c4b5fd;border-color:rgba(167,139,250,.55);box-shadow:0 0 0 1px rgba(167,139,250,.12)}
.routing-mode--local{background:rgba(34,197,94,.2);color:#4ade80;border-color:rgba(34,197,94,.5);box-shadow:0 0 0 1px rgba(34,197,94,.1)}
.routing-mode-btn--section.routing-mode--hybrid{box-shadow:0 2px 6px rgba(245,158,11,.15),inset 0 1px 0 rgba(255,255,255,.1)}
.routing-mode-btn--section.routing-mode--cloud{box-shadow:0 2px 6px rgba(139,92,246,.18),inset 0 1px 0 rgba(255,255,255,.1)}
.routing-mode-btn--section.routing-mode--local{box-shadow:0 2px 6px rgba(34,197,94,.14),inset 0 1px 0 rgba(255,255,255,.1)}
html.light .routing-mode--hybrid{color:#b45309;border-color:rgba(217,119,6,.45);background:rgba(251,191,36,.25)}
html.light .routing-mode--cloud{color:#5b21b6;border-color:rgba(124,58,237,.4);background:rgba(196,181,253,.35)}
html.light .routing-mode--local{color:#15803d;border-color:rgba(22,163,74,.45);background:rgba(134,239,172,.35)}
html.light .routing-mode-btn--section.routing-mode--hybrid{box-shadow:0 2px 8px rgba(217,119,6,.12),inset 0 1px 0 rgba(255,255,255,.5)}
html.light .routing-mode-btn--section.routing-mode--cloud{box-shadow:0 2px 8px rgba(124,58,237,.12),inset 0 1px 0 rgba(255,255,255,.45)}
html.light .routing-mode-btn--section.routing-mode--local{box-shadow:0 2px 8px rgba(22,163,74,.1),inset 0 1px 0 rgba(255,255,255,.45)}
html.light .routing-mode-btn--choice.is-active{
  outline-color:rgba(15,23,42,.26);
  box-shadow:0 0 0 1px rgba(15,23,42,.08),0 10px 18px rgba(15,23,42,.12),inset 0 1px 0 rgba(255,255,255,.55);
}
html.light .routing-mode-btn--choice.is-active .routing-mode-btn-main,
html.light .routing-mode-btn--choice.is-active .routing-mode-btn-sub{color:#111827}
/* meta panel */
.hdr-meta{display:flex;flex-direction:column;align-items:flex-end;gap:.2rem;background:var(--meta-bg);border:1px solid var(--meta-border);border-radius:.4rem;padding:.22rem .45rem;max-width:min(100%,34rem)}
.chips{display:flex;flex-wrap:wrap;gap:.18rem;justify-content:flex-end}
.chip{display:inline-flex;align-items:center;padding:.08rem .34rem;border-radius:.3rem;font-size:.69rem;font-weight:600;background:var(--chip-bg);border:1px solid var(--chip-border);color:var(--text2);white-space:nowrap}
.chip.mono{font-family:ui-monospace,'Cascadia Code','Segoe UI Mono',monospace;font-size:.7rem;color:#93c5fd}
.meta-status-row{display:flex;align-items:center;justify-content:flex-end;gap:.5rem;min-width:0;width:100%}
.last-route-bar{margin-top:0;font-size:.69rem;color:var(--text2);max-width:26rem;text-align:right;line-height:1.2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.last-route-bar .lr-dest{font-weight:700;color:var(--green)}
.last-route-bar.cloud .lr-dest{color:var(--blue)}
.last-route-bar.fallback .lr-dest{color:var(--amber)}
.refresh-row{display:inline-flex;align-items:center;gap:.26rem;font-size:.68rem;color:var(--text3);white-space:nowrap;flex:0 0 auto}
.rdot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite;flex-shrink:0}
.rdot.err{background:#ef4444;animation:none}
.rbtn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--text2);cursor:pointer;font-size:9px;transition:all .15s}
.rbtn:hover{filter:brightness(1.3)}
/* theme toggle */
.theme-btn{position:absolute;right:0;top:50%;transform:translateY(-50%);width:2rem;height:2rem;border-radius:.5rem;border:1px solid var(--toggle-border);background:var(--toggle-bg);color:var(--toggle-fg);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.9rem;transition:all .2s;flex-shrink:0}
.theme-btn:hover{filter:brightness(1.2)}
html.dark .sun{display:none} html.dark .moon{display:inline}
html.light .sun{display:inline} html.light .moon{display:none}
/* system load (lives in sticky header; does not scroll with .main) */
.res-strip{margin:0;background:transparent;border:none;padding:0}
.res-strip--hdr{margin-top:.4rem;padding-top:.5rem;border-top:1px solid var(--header-border)}
.res-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.res-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text3)}
.res-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media(max-width:560px){.res-grid{grid-template-columns:repeat(2,1fr)}}
.res-metric{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:7px 9px;min-width:0}
.res-row{display:flex;justify-content:space-between;align-items:center}
.res-label{font-size:.65rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}
.res-val{font-size:.78rem;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums}
canvas.spark{width:100%;min-width:0;height:10px;border-radius:2px;display:block;margin-top:.08rem;vertical-align:top;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08)}
html.light canvas.spark{background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.08)}

/* ── Main content ─────────────────────────────────────────────────── */
.main{
  padding:14px var(--dash-inline-pad) 32px;
  max-width:var(--dash-max-w);
  margin:0 auto;
  display:flex;
  flex-direction:column;
  gap:var(--dash-section-gap);
}
h2.dash-section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--text3)}

/* Dashboard layout (compact sections) */
.dash-card{
  background:var(--tile-bg);
  border:1px solid var(--tile-border);
  border-radius:var(--dash-card-radius);
  padding:var(--dash-card-pad);
  margin:0;
}
.dash-section-title{
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text3);
  margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--border);
}
.dash-subsection-title{
  font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text2);
  margin:12px 0 6px;
}
.dash-subsection-title:first-of-type{margin-top:4px}
.dash-card--models-runtime{padding:13px 16px}
.models-routing-bar{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 18px;
  margin:0 0 14px;padding:12px 14px;border-radius:var(--dash-card-radius);
  border:1px solid var(--border);background:var(--surface2);
}
.models-routing-bar-text{display:flex;flex-direction:column;gap:3px;flex:1 1 12rem;min-width:min(100%,10rem)}
.models-routing-bar-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--text3)}
.models-routing-bar-hint{font-size:11px;color:var(--text2);line-height:1.4;max-width:40rem}
@media(max-width:520px){
  /* Column layout: avoid space-between + flex-grow on text (creates a huge gap above buttons). */
  .models-routing-bar{
    flex-direction:column;
    align-items:stretch;
    justify-content:flex-start;
    gap:10px 12px;
  }
  .models-routing-bar-text{
    flex:0 1 auto;
    min-width:0;
  }
  .routing-mode-btn-group{
    width:100%;
    justify-content:flex-start;
    flex-direction:column;
    align-items:stretch;
    gap:8px;
  }
  .routing-mode-btn--section{width:100%}
}
.models-toolbar-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 14px;margin-bottom:6px}
.models-toolbar-default{display:flex;flex-direction:column;gap:3px;flex:1 1 min(100%,16rem);min-width:min(100%,12rem)}
.models-toolbar-default .local-model-lbl{margin:0}
.models-smart-cb{display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px}
.routing-saved-msg{margin-left:auto;flex-shrink:0;align-self:center;margin-bottom:2px}
.models-fast-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 16px;margin-top:10px;padding-top:12px;border-top:1px solid var(--border)}
.models-toolbar-fast{display:flex;flex-direction:column;gap:3px;flex:1 1 min(100%,18rem);min-width:min(100%,12rem)}
.models-toolbar-fast .local-model-lbl{margin:0}
.models-fast-hint{margin:0;font-size:10px;color:var(--text3);line-height:1.45;flex:1 1 14rem;max-width:44rem;align-self:flex-end;padding-bottom:2px}
.dash-card--models-runtime .local-pool-panel{
  position:relative;margin-top:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;max-width:100%;
}
.local-pool-panel--compact{padding:10px 12px !important}
.pool-panel-block{margin-bottom:0}
.pool-explainer{font-size:11px;color:var(--text3);line-height:1.5;margin:6px 0 8px;max-width:52rem}
.pool-hint-line{margin:0 !important;font-size:10px !important;color:var(--text2);font-weight:600}
.pool-chips-grid{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0;padding:4px 0 2px}
.pool-chip{
  display:inline-flex;align-items:center;gap:6px;cursor:pointer;
  padding:6px 11px;border-radius:999px;border:1px solid var(--border);
  background:var(--surface2);transition:background .15s,border-color .15s,box-shadow .15s;
  font-size:11px;user-select:none;
}
.pool-chip:hover{border-color:color-mix(in srgb,var(--border) 70%,var(--accent) 30%)}
.pool-chip.pool-chip--on{
  border-color:rgba(59,130,246,.55);
  background:color-mix(in srgb,var(--accent) 14%,var(--surface2));
  box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 25%,transparent);
}
.pool-chip input[type=checkbox]{width:14px;height:14px;margin:0;accent-color:var(--accent);cursor:pointer;flex-shrink:0}
.pool-chip-name{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:10.5px;font-weight:600;color:var(--text);max-width:min(100%,22rem);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pool-chip-size{font-size:9px;font-weight:600;color:var(--text3);font-variant-numeric:tabular-nums;flex-shrink:0}
.pool-select-hidden{
  position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;
  overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important;
}
.dash-callout{
  font-size:12px;line-height:1.55;color:var(--text2);background:color-mix(in srgb,var(--accent) 8%,var(--tile-bg));
  border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border));border-radius:var(--dash-card-radius);padding:12px 16px;margin:0;max-width:62rem;
}
.dash-callout strong{color:var(--text)}
.dash-callout .inline-code,.params-sub .inline-code{font-family:ui-monospace,Consolas,monospace;font-size:10px;background:var(--surface2);padding:1px 5px;border-radius:4px;border:1px solid var(--border)}
.dash-callout-sub{font-size:11px;opacity:.6;display:block;margin-top:5px}
.dash-supporter-footer{
  margin:0;padding:12px 16px;border:1px solid var(--tile-border);background:color-mix(in srgb,var(--tile-bg) 92%,transparent);border-radius:var(--dash-card-radius);
  display:flex;justify-content:center;text-align:center;
}
.dash-supporter-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;min-width:0;max-width:100%}
.dash-supporter-text{font-size:11px;color:var(--text2);margin:0;line-height:1.2;text-align:center;flex:0 1 auto;max-width:100%}
.dash-bmc-link{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex-shrink:0;font-size:10.5px;font-weight:600;color:#0c4a6e;background:#d6ecfc;padding:4px 10px;border-radius:999px;text-decoration:none;border:1px solid color-mix(in srgb,#93c5fd 45%,#0c4a6e 18%);transition:filter .15s,transform .15s,background .15s;line-height:1.2;white-space:nowrap}
.dash-bmc-link:hover{filter:brightness(1.04);background:#c5e3fa;transform:translateY(-1px)}
.dash-bmc-link:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
html.light .dash-bmc-link{color:#0c4a6e}
.vram-empty-note{font-size:9px;color:var(--text3);margin-top:6px;line-height:1.35;max-width:44rem;opacity:.9}
.settings-hint-details{margin-bottom:12px;border:1px solid var(--border);border-radius:8px;padding:8px 12px;background:var(--surface2)}
.settings-hint-details summary{cursor:pointer;font-size:11px;font-weight:600;color:var(--text2);user-select:none}
.settings-hint-details .settings-hint-body{margin:8px 0 0;font-size:10px;color:var(--text3);line-height:1.45;max-width:48rem}
.info-readonly-note{font-size:11px;color:var(--text3);margin:0 0 12px;line-height:1.45;max-width:42rem}
.dash-card--params .params-panel{
  margin:4px 0 0;padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;
}
.dash-card--params .params-sub{margin-top:0;margin-bottom:8px}
.dash-card--params>.dash-section-title{border-bottom:none;padding-bottom:0;margin-bottom:10px}
.params-card-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 14px;margin-bottom:10px}
.params-card-header>.dash-section-title{margin-bottom:0;border-bottom:none;padding-bottom:0}
.params-card-header>.params-toolbar{margin-bottom:0}

/* Model card layout: ollama-dashboard (see /assets/ollama-dashboard-model-card.css) */
.local-model-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 6px}
.local-model-lbl{font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.06em}
.local-model-select{min-width:min(100%,22rem);max-width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:5px 8px;font-size:12px}
.local-pool-panel .local-model-lbl{display:flex;align-items:center;gap:8px;cursor:pointer}

/* ── Params panel ───────────────────────────────────────────────────── */
.params-panel{background:var(--tile-bg);border:1px solid var(--tile-border);border-radius:var(--dash-card-radius);padding:12px 14px;margin-bottom:0}
.params-sub{font-size:10px;color:var(--text3);margin:0 0 8px;line-height:1.45;max-width:52rem}
.params-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 12px}
.params-files-textarea{width:100%;min-height:min(50vh,420px);font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.4;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);resize:vertical;box-sizing:border-box}
.params-files-path{font-size:10px;color:var(--text3);margin:6px 0}
.params-files-err{font-size:11px;color:#f87171;margin:8px 0}
.params-files-tabs{display:flex;gap:4px;margin:10px 0 6px;flex-wrap:wrap}
.params-files-tabs .params-file-tab{font-size:10px;font-weight:600;padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface2);color:var(--text2);cursor:pointer}
.params-files-tabs .params-file-tab[aria-selected="true"]{border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 12%,var(--surface2))}
.pbtn-secondary{background:var(--btn-bg);color:var(--btn-text);border:1px solid var(--btn-border)}.pbtn-secondary:hover{filter:brightness(1.15)}
.params-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;flex-wrap:wrap}
.params-hdr-label{font-size:11px;font-weight:600;color:var(--text2);letter-spacing:.04em;text-transform:uppercase}
.pact{display:flex;gap:7px;align-items:center}
.pbtn{font-size:11.5px;font-weight:600;padding:5px 13px;border-radius:6px;border:none;cursor:pointer;transition:all .15s}
.pbtn-save{background:#1d4ed8;color:#fff}.pbtn-save:hover{background:#2563eb}
.pbtn-reset{background:var(--btn-bg);color:var(--btn-text);border:1px solid var(--btn-border)}.pbtn-reset:hover{filter:brightness(1.2)}
.params-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:660px){.params-grid{grid-template-columns:repeat(2,1fr)}}
.param-item{display:flex;flex-direction:column;gap:4px;border-radius:8px;padding:6px 8px;margin:-4px -6px;transition:background .2s,border-color .2s}
.param-item.param--override{background:rgba(245,158,11,.07);border-left:3px solid var(--amber);padding-left:11px;margin-left:-11px;border-radius:0 8px 8px 0}
html.light .param-item.param--override{background:rgba(245,158,11,.1)}
.param-label{font-size:10.5px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:100%}
.param-label-text{flex:0 1 auto}
.param-default-pill{font-size:7.5px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;padding:2px 6px;border-radius:4px;line-height:1}
.param-default-pill.built-in{background:var(--chip-bg);color:var(--text3);border:1px solid var(--chip-border)}
.param-default-pill.custom{background:rgba(245,158,11,.18);color:#fbbf24;border:1px solid rgba(245,158,11,.4)}
.param-val{color:var(--accent);font-weight:700;min-width:34px;text-align:right;margin-left:auto}
.param-desc{font-size:9.5px;color:var(--text3);margin-top:1px;line-height:1.4}
input[type=range]{width:100%;accent-color:#3b82f6;min-height:22px;padding:5px 0;box-sizing:border-box;cursor:pointer}
input[type=number].param-num{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 7px;font-size:12px}
input[type=number].param-num:focus{outline:none;border-color:var(--accent)}
.adv-toggle{font-size:10px;color:var(--text3);cursor:pointer;text-decoration:underline;text-underline-offset:2px;margin-top:10px;display:inline-block}
.adv-toggle:hover{color:var(--text2)}
.params-adv{margin-top:8px;display:none}
.params-adv.open{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.saved-msg{font-size:11px;color:var(--green);opacity:0;transition:opacity .4s}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
.modal-overlay[hidden]{display:none !important}
.modal-box{background:var(--surface2);border:1px solid var(--border2);border-radius:12px;max-width:min(920px,96vw);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 24px 56px rgba(0,0,0,.45)}
.modal-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);font-weight:600;font-size:13px;color:var(--text)}
.modal-x{background:none;border:none;color:var(--text2);cursor:pointer;font-size:22px;line-height:1;padding:2px 8px;border-radius:6px}
.modal-x:hover{background:var(--chip-bg);color:var(--text)}
.modal-body{padding:12px 16px 16px;overflow:auto;flex:1;min-height:120px}
.modal-body pre{margin:0;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;color:var(--text2)}

/* ── Routing log ──────────────────────────────────────────────────── */
.stats{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.stat{background:var(--tile-bg);border:1px solid var(--tile-border);border-radius:8px;padding:9px 16px;text-align:center;min-width:82px}
.stat-val{font-size:24px;font-weight:700;line-height:1}
.stat-lbl{font-size:9.5px;color:var(--text3);margin-top:3px;text-transform:uppercase;letter-spacing:.05em}
.lv{color:var(--green)}.cv{color:var(--blue)}.tv{color:#a78bfa}
#log{display:flex;flex-direction:column;gap:5px}
.entry{display:flex;align-items:center;gap:9px;background:var(--tile-bg);border:1px solid var(--tile-border);border-radius:6px;padding:7px 11px;animation:fadeIn .18s ease}
.entry.local{border-left:3px solid var(--green)}.entry.cloud{border-left:3px solid var(--blue)}.entry.fallback{border-left:3px solid var(--amber)}
@keyframes fadeIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.badge{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;min-width:46px;text-align:center}
.badge.local{background:#14532d;color:#4ade80}.badge.cloud{background:#1e3a5f;color:#93c5fd}.badge.fallback{background:#451a03;color:#fbbf24}
.etime{font-size:10.5px;color:var(--text3);min-width:56px;font-variant-numeric:tabular-nums}
.reason{font-size:12px;color:var(--text2);flex:1}
.empty{color:var(--text3);font-size:12px;padding:30px;text-align:center}
.thresholds{font-size:10.5px;color:var(--text3);margin-bottom:13px}
.thresholds span{color:var(--text2);margin-right:12px}
hr.sep{border:none;border-top:1px solid var(--border);margin:22px 0}

/* ── Fixed footer output window ───────────────────────────────────────────── */
.fixed-log-footer{
  position:fixed;
  left:0; right:0; bottom:0;
  z-index:999;
  height:260px;
  min-height:130px;
  max-height:70vh;
  display:flex;
  flex-direction:column;
  pointer-events:auto;
  box-shadow:0 -10px 30px rgba(0,0,0,.28);
}
.fixed-log-resizer{
  height:12px;
  cursor:ns-resize;
  border-top:1px solid var(--border);
  border-left:1px solid var(--border);
  border-right:1px solid var(--border);
  border-radius:12px 12px 0 0;
  background:var(--chip-bg);
  display:flex;
  align-items:center;
  justify-content:center;
  user-select:none;
  touch-action:none;
}
.fixed-log-resizer::before{
  content:"";
  width:42px;
  height:3px;
  border-radius:999px;
  background:var(--text3);
}
.fixed-log-panel{
  display:flex;
  flex-direction:column;
  height:100%;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:12px 12px 0 0;
  overflow:hidden;
}
.fixed-log-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:8px 12px;
  border-bottom:1px solid var(--border);
  background:var(--chip-bg);
  flex-wrap:nowrap;
  min-width:0;
}
.fixed-log-title{
  flex:0 0 auto;
  font-size:11px;
  font-weight:700;
  letter-spacing:.06em;
  text-transform:uppercase;
  color:var(--text2);
  white-space:nowrap;
}
.fixed-log-title .fixed-log-count{
  font-weight:500;
  letter-spacing:normal;
  text-transform:none;
  color:var(--text3);
}
.fixed-log-preview{
  flex:1 1 auto;
  min-width:0;
  font-size:10px;
  line-height:1.35;
  color:var(--text3);
  font-family:ui-monospace,"Cascadia Code","Consolas",monospace;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  min-height:14px;
}
.fixed-log-head-main{
  display:flex;
  align-items:center;
  gap:10px;
  flex:1;
  min-width:0;
  flex-wrap:nowrap;
}
.fixed-log-stats{
  display:flex;
  align-items:center;
  gap:8px;
  flex:0 0 auto;
  flex-wrap:nowrap;
}
@media (max-width:640px){
  .fixed-log-head-main{flex-wrap:wrap;}
  .fixed-log-preview{flex:1 1 100%;min-width:100%;order:3;}
  .fixed-log-stats{order:2;}
  .fixed-log-title{order:1;}
}
.fixed-log-stat{
  display:inline-flex;
  align-items:center;
  gap:5px;
  padding:3px 8px;
  border-radius:999px;
  border:1px solid var(--tile-border);
  background:var(--surface);
  font-size:10.5px;
  color:var(--text2);
}
.fixed-log-stat strong{
  font-size:11px;
  font-weight:700;
  color:var(--text);
}
.fixed-log-stat.local strong{color:var(--green)}
.fixed-log-stat.cloud strong{color:var(--blue)}
.fixed-log-stat.total strong{color:#a78bfa}
.fixed-log-tools{
  flex:0 0 auto;
  display:inline-flex;
  align-items:center;
  gap:8px;
}
.fixed-log-toggle{
  border:1px solid var(--btn-border);
  background:var(--btn-bg);
  color:var(--btn-text);
  border-radius:6px;
  font-size:10.5px;
  line-height:1;
  padding:4px 8px;
  cursor:pointer;
}
.fixed-log-output{
  flex:1 1 auto;
  overflow:auto;
  padding:8px 12px;
  font-family:ui-monospace,"Cascadia Code","Consolas",monospace;
  font-size:11.5px;
  line-height:1.45;
  background:var(--surface2);
}
.fixed-log-empty{color:var(--text3);font-size:12px;padding:18px 4px;text-align:center}
.fixed-log-line{
  padding:2px 0;
  border-bottom:1px dashed rgba(255,255,255,.08);
}
.fixed-log-line:last-child{border-bottom:none}
.fixed-log-line .local{color:#4ade80}
.fixed-log-line .cloud{color:#93c5fd}
.fixed-log-line .fallback{color:#fbbf24}
.fixed-log-footer.is-collapsed{
  height:46px !important;
  min-height:46px !important;
}
.fixed-log-footer.is-collapsed .fixed-log-resizer{display:none}
.fixed-log-footer.is-collapsed .fixed-log-head{border-bottom:none}
.fixed-log-footer.is-collapsed .fixed-log-output{display:none}

/* ── Tooltip system ──────────────────────────────────────────────────────── */
/* Usage: data-tip="text" on any element. Use data-tip-right / data-tip-left  */
/* / data-tip-bottom modifiers for direction. .tip-icon = inline ? badge.     */
[data-tip]{position:relative;cursor:default}
[data-tip]:hover::after{
  content:attr(data-tip);
  position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);
  background:rgba(8,8,8,.96);color:#dde;
  font-size:11.5px;line-height:1.5;padding:7px 11px;
  border-radius:7px;white-space:normal;width:max-content;max-width:280px;min-width:80px;
  z-index:10000;pointer-events:none;
  box-shadow:0 4px 18px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1);
  font-weight:400;font-style:normal;text-align:left;
  animation:tipIn .12s ease;
}
[data-tip]:hover::before{
  content:'';position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);
  border:4px solid transparent;border-top-color:rgba(8,8,8,.96);
  z-index:10000;pointer-events:none;
}
[data-tip][data-tip-right]:hover::after{left:auto;right:0;transform:none}
[data-tip][data-tip-left]:hover::after{left:0;right:auto;transform:none}
[data-tip][data-tip-bottom]:hover::after{bottom:auto;top:calc(100% + 8px)}
[data-tip][data-tip-bottom]:hover::before{bottom:auto;top:calc(100% + 4px);border-top-color:transparent;border-bottom-color:rgba(8,8,8,.96)}
html.light [data-tip]:hover::after{background:rgba(20,20,20,.93);border-color:rgba(0,0,0,.18)}
html.light [data-tip]:hover::before{border-top-color:rgba(20,20,20,.93)}
html.light [data-tip][data-tip-bottom]:hover::before{border-bottom-color:rgba(20,20,20,.93);border-top-color:transparent}
@keyframes tipIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
/* tip-icon: a small circled ? shown inline next to labels */
.tip-icon{
  display:inline-flex;align-items:center;justify-content:center;
  width:14px;height:14px;border-radius:50%;
  background:rgba(255,255,255,.11);color:var(--text3);
  font-size:9px;font-weight:800;font-style:normal;
  cursor:help;flex-shrink:0;margin-left:3px;line-height:1;
  vertical-align:middle;transition:background .15s,color .15s;
  position:relative;
}
html.light .tip-icon{background:rgba(0,0,0,.09);color:#888}
.tip-icon:hover,.tip-icon:focus-visible{background:rgba(255,255,255,.22);color:var(--text)}
html.light .tip-icon:hover{background:rgba(0,0,0,.18);color:#222}
/* Stat badges in footer */
.fixed-log-stat[data-tip]{cursor:default}
</style>
</head>
<body data-poll-interval="10">

<!-- ══ Header ═══════════════════════════════════════════════════════════════ -->
<header class="hdr">
  <div class="hdr-inner">
  <div class="hdr-bar">
    <!-- Left: logo + health -->
    <div class="hdr-left">
      <span class="hdr-logos">
        <span class="hdr-logo"><img src="/assets/ollama-logo.png" alt="Ollama"></span>
        <span class="hdr-logo"><img src="/assets/claude-code-icon.svg" alt="Claude Code"></span>
      </span>
           <span class="hdr-brand">ClaudeLlama</span>
      <span class="health-badge degraded" id="health-badge" data-tip="Router status. Healthy = router + Ollama both running. Degraded = router OK but Ollama unreachable. Unhealthy = router error. Watch this after model changes.">
        <span class="health-dot"></span>
        <span id="health-text">Checking...</span>
      </span>
    </div>
    <!-- Right: meta panel -->
    <div class="hdr-meta">
      <div class="chips">
        <span class="chip" id="chip-ollama" data-tip="Ollama local AI server status. Green = healthy, yellow = unreachable.">Ollama</span>
        <span class="chip mono" data-tip="Ollama host:port — where the router sends local model requests. Change via ROUTER_OLLAMA_HOST / ROUTER_OLLAMA_PORT env vars.">${String(cfg.local.host).replace(/[<>&]/g, "")}:${cfg.local.port}</span>
        <span class="chip mono" data-tip="This router is listening here. Your ANTHROPIC_BASE_URL should point to this address so Claude Code routes through the proxy.">${String(cfg.listenHost).replace(/[<>&]/g, "")}:${cfg.port}</span>
      </div>
      <div class="meta-status-row">
        <div class="last-route-bar local" id="last-route-bar" title="No recent route yet" data-tip="Last routing decision. LOCAL = request handled by your Ollama model (free). CLOUD = sent to Anthropic API (uses quota). Fallback = auto-switched after error."><span id="last-route-text">Awaiting route</span></div>
        <div class="refresh-row" id="refresh-row" title="Last updated: pending" data-tip="Time until next automatic dashboard refresh. Stats, model status, and generation parameters reload on each cycle.">
          <span class="rdot" id="rdot"></span>
          <span>next <span id="next-poll">10</span>s</span>
        </div>
        <button class="rbtn" onclick="void runCoalescedDashboardRefresh(true)" title="Refresh now (reloads metrics and generation sliders from server)" data-tip="Force an immediate refresh of all dashboard data: health status, routing counters, model list, and generation parameters.">&#8635;</button>
      </div>
    </div>
    <!-- Theme toggle -->
    <button class="theme-btn" onclick="toggleTheme()" title="Toggle theme">
      <span class="sun">&#9788;</span><span class="moon">&#9790;</span>
    </button>
  </div>
  <div class="hdr-system" role="region" aria-labelledby="dash-sys-h">
    <div class="res-strip res-strip--hdr">
      <div class="res-head">
        <span class="res-title" id="dash-sys-h">System load</span>
      </div>
      <div class="res-grid">
        <div class="res-metric" data-tip="CPU usage across all cores. High CPU during local inference is normal — Ollama uses available threads."><div class="res-row"><span class="res-label">CPU</span><span class="res-val" id="r-cpu">—%</span></div><canvas class="spark" id="spark-cpu" width="200" height="12"></canvas></div>
        <div class="res-metric" data-tip="System RAM usage. If this approaches 100%, Ollama may crash or slow down. Consider a smaller model or increase swap."><div class="res-row"><span class="res-label">RAM</span><span class="res-val" id="r-ram">—%</span></div><canvas class="spark" id="spark-ram" width="200" height="12"></canvas></div>
        <div class="res-metric" data-tip="GPU VRAM usage. Ollama loads model weights here. If full, the model may offload layers to RAM, which is much slower."><div class="res-row"><span class="res-label">VRAM</span><span class="res-val" id="r-vram">—%</span></div><canvas class="spark" id="spark-vram" width="200" height="12"></canvas></div>
        <div class="res-metric" data-tip="GPU compute utilization. Spikes during token generation are expected. Idle between requests is normal."><div class="res-row"><span class="res-label">GPU</span><span class="res-val" id="r-gpu">—%</span></div><canvas class="spark" id="spark-gpu" width="200" height="12"></canvas></div>
      </div>
    </div>
  </div>
  </div>
</header>
<script>
(function(){
  function applyHealth(d){
    var badge=document.getElementById('health-badge');
    var text=document.getElementById('health-text');
    var rdot=document.getElementById('rdot');
    if(badge) badge.className='health-badge '+(d.status||'unhealthy');
    if(d.status==='healthy'){
      var m=Math.floor((d.uptime_seconds||0)/60), h=Math.floor(m/60);
      if(text) text.textContent='Healthy'+(d.uptime_seconds?(' \u00b7 '+(h>0?h+'h '+m%60+'m':m+'m')):'');
      if(rdot) rdot.className='rdot';
    } else if(d.status==='degraded'){
      if(text) text.textContent='Degraded \u00b7 Ollama not running';
      if(rdot) rdot.className='rdot err';
    } else {
      if(text) text.textContent='Unhealthy'+(d.error?' \u00b7 '+d.error:'');
      if(rdot) rdot.className='rdot err';
    }
  }
  var ac=new AbortController();
  var tid=setTimeout(function(){ try{ ac.abort(); }catch(_){} },8000);
  fetch('/api/health',{signal:ac.signal}).then(function(r){
    clearTimeout(tid);
    if(!r.ok) throw new Error('http');
    return r.json();
  }).then(applyHealth).catch(function(e){
    clearTimeout(tid);
    var badge=document.getElementById('health-badge');
    var text=document.getElementById('health-text');
    var rdot=document.getElementById('rdot');
    if(badge) badge.className='health-badge unhealthy';
    if(text) text.textContent=(e&&e.name==='AbortError')?'Router not responding (timeout)':'Health check failed';
    if(rdot) rdot.className='rdot err';
  });
  var acS=new AbortController();
  var tidS=setTimeout(function(){ try{ acS.abort(); }catch(_){} },12000);
  fetch('/api/system-stats',{signal:acS.signal}).then(function(r){
    clearTimeout(tidS);
    if(!r.ok)throw 0;
    return r.json();
  }).then(function(d){
    if(typeof window.__claudeHybridIngestSystemStats==='function'){
      try{ window.__claudeHybridIngestSystemStats(d); }catch(_){}
    } else {
      function pct(el,v){
        if(!el)return;
        if(v==null||v===''){ el.textContent='—%'; return; }
        var n=Number(v);
        el.textContent=isFinite(n)?(Math.round(n)+'%'):'—%';
      }
      pct(document.getElementById('r-cpu'),d.cpu);
      pct(document.getElementById('r-ram'),d.ram);
      pct(document.getElementById('r-vram'),d.vram);
      pct(document.getElementById('r-gpu'),d.gpu);
    }
  }).catch(function(){ clearTimeout(tidS); });
  function bootModelsFromApi(){
    setTimeout(function(){
    fetch('/api/ollama-models').then(function(r){ if(!r.ok)throw 0; return r.json(); }).then(function(d){
      return fetch('/api/router/local-routing-config').then(function(r2){ return r2.ok?r2.json():{}; }).then(function(cfg){
      var cb=document.getElementById('smart-routing-cb');
      if(cb) cb.checked=cfg.smart_routing!==false;
      var fastCur=typeof cfg.fast_model==='string'?cfg.fast_model.trim():'';
      var sel=document.getElementById('local-model-select');
      if(sel){
        var cur=String(d.configured_model||''), seen={};
        sel.innerHTML='';
        (d.models||[]).forEach(function(m){
          if(!m||!m.name||seen[m.name])return;
          seen[m.name]=1;
          var o=document.createElement('option');
          o.value=m.name;
          o.textContent=m.name;
          if(m.size!=null&&m.size>0){
            var g=m.size/1e9;
            o.textContent=m.name+' ('+(g>=1?g.toFixed(1)+' GB':Math.round(m.size/1e6)+' MB')+')';
          }
          if(m.name===cur) o.selected=true;
          sel.appendChild(o);
        });
        if(cur&&!seen[cur]){
          var ox=document.createElement('option');
          ox.value=cur; ox.textContent=cur+' (configured, not in ollama list)'; ox.selected=true; sel.appendChild(ox);
        }
      }
      var fs=document.getElementById('fast-model-select');
      if(fs){
        fs.innerHTML='';
        var n0=document.createElement('option'); n0.value=''; n0.textContent='(None)'; fs.appendChild(n0);
        var seenF={};
        (d.models||[]).forEach(function(m){
          if(!m||!m.name||seenF[m.name])return;
          seenF[m.name]=1;
          var o=document.createElement('option');
          o.value=m.name; o.textContent=m.name;
          if(m.size!=null&&m.size>0){ var g=m.size/1e9; o.textContent=m.name+' ('+(g>=1?g.toFixed(1)+' GB':Math.round(m.size/1e6)+' MB')+')'; }
          fs.appendChild(o);
        });
        if(fastCur&&!seenF[fastCur]){
          var of=document.createElement('option');
          of.value=fastCur; of.textContent=fastCur+' (in config, not in ollama list)'; fs.appendChild(of);
        }
        try{ fs.value=fastCur; }catch(_){}
      }
      var poolRoot=document.getElementById('pool-chips-root');
      var poolSel=document.getElementById('local-pool-select');
      if(poolRoot&&poolSel){
        var wantPool=new Set();
        if(Array.isArray(cfg.models)){
          cfg.models.forEach(function(x){ var s=String(x||'').trim(); if(s)wantPool.add(s); });
        }
        var restrictPool=wantPool.size>0;
        poolRoot.innerHTML='';
        poolSel.innerHTML='';
        var seenP={}, listP=[];
        (d.models||[]).forEach(function(m){
          if(!m||!m.name||seenP[m.name])return;
          seenP[m.name]=1;
          listP.push(m);
        });
        function fmtPoolSz(n){
          if(n==null||n==='')return '';
          var x=Number(n);
          if(!isFinite(x)||x<=0)return '';
          var g=x/1e9;
          return g>=1?g.toFixed(1)+' GB':Math.round(x/1e6)+' MB';
        }
        function syncPoolHiddenBoot(){
          var byVal={};
          poolRoot.querySelectorAll('.pool-chip input[type=checkbox]').forEach(function(cbx){ byVal[cbx.value]=cbx.checked; });
          for(var i=0;i<poolSel.options.length;i++){ poolSel.options[i].selected=!!byVal[poolSel.options[i].value]; }
        }
        function poolHintBoot(){
          var ph=document.getElementById('pool-hint');
          if(!ph)return;
          var n=poolRoot.querySelectorAll('.pool-chip').length;
          var ch=poolRoot.querySelectorAll('input[type=checkbox]:checked').length;
          if(n===0) ph.textContent='No models installed — run ollama pull';
          else if(ch===0) ph.textContent=n+' model'+(n===1?'':'s')+' installed · full library allowed (check models to restrict the pool)';
          else ph.textContent=n+' installed · pool limited to '+ch+' model'+(ch===1?'':'s');
        }
        listP.forEach(function(m){
          var on=restrictPool&&wantPool.has(m.name);
          var lbl=document.createElement('label');
          lbl.className='pool-chip'+(on?' pool-chip--on':'');
          var cbx=document.createElement('input');
          cbx.type='checkbox';
          cbx.value=m.name;
          cbx.checked=on;
          cbx.setAttribute('aria-label','Include '+m.name+' in local routing pool');
          lbl.appendChild(cbx);
          var spn=document.createElement('span');
          spn.className='pool-chip-name';
          spn.textContent=m.name;
          spn.title=m.name;
          lbl.appendChild(spn);
          if(m.size!=null&&m.size>0){
            var sz=document.createElement('span');
            sz.className='pool-chip-size';
            sz.textContent=fmtPoolSz(m.size);
            lbl.appendChild(sz);
          }
          cbx.addEventListener('change',function(){
            lbl.classList.toggle('pool-chip--on',cbx.checked);
            syncPoolHiddenBoot();
            poolHintBoot();
          });
          poolRoot.appendChild(lbl);
          var popt=document.createElement('option');
          popt.value=m.name;
          popt.textContent=m.name;
          popt.selected=on;
          poolSel.appendChild(popt);
        });
        poolHintBoot();
      }
      });
    }).catch(function(){});
    },150);
  }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',bootModelsFromApi); }
  else{ bootModelsFromApi(); }
})();
</script>

<!-- ══ Main ═════════════════════════════════════════════════════════════════ -->
<div class="main">

  <div class="dash-callout" role="region" aria-label="Local-first routing">
    <strong>Local-first, cloud when needed.</strong>
    Smart routing uses your Ollama pool by default; very large prompts, heavy tool output this turn, or routing keywords go to Claude. <strong>Speed assist model</strong> prefers a smaller tag for brief prompts, and these settings save automatically.
  </div>

  <div class="dash-callout" role="note" aria-label="Supported clients">
    <strong>Claude Code CLI, desktop app, Cursor, and VS Code all route through here.</strong>
    Run <span class="inline-code">npm run merge-env</span> once, then open any of those — no other configuration needed. Watch the footer for <strong>LOCAL</strong> / <strong>CLOUD</strong> to confirm routing is active.
    <span class="dash-callout-sub">The separate claude.ai chat app bypasses <span class="inline-code">ANTHROPIC_BASE_URL</span> and cannot be routed through this proxy.</span>
  </div>

  <section class="dash-card dash-card--models-runtime" aria-labelledby="dash-models-h">
    <div class="models-routing-bar" role="group" aria-labelledby="routing-mode-heading">
      <div class="models-routing-bar-text">
        <span class="models-routing-bar-title" id="routing-mode-heading">API routing mode <i class="tip-icon" data-tip="Controls how every Claude Code request is handled. Hybrid is recommended: it sends routine tasks to your local Ollama model and only escalates to Anthropic cloud when needed — balancing quality and cost." data-tip-bottom="">?</i></span>
        <span class="models-routing-bar-hint">Hybrid auto-routes by token count, tool load, and keywords. Claude only / Ollama only force every request to that provider.</span>
      </div>
      <div class="routing-mode-btn-group" role="group" aria-label="Choose API routing mode">
        <button type="button" class="routing-mode-btn routing-mode-btn--section routing-mode-btn--choice routing-mode--hybrid" id="routing-mode-btn-hybrid" data-mode="hybrid"></button>
        <button type="button" class="routing-mode-btn routing-mode-btn--section routing-mode-btn--choice routing-mode--cloud" id="routing-mode-btn-cloud" data-mode="cloud"></button>
        <button type="button" class="routing-mode-btn routing-mode-btn--section routing-mode-btn--choice routing-mode--local" id="routing-mode-btn-local" data-mode="local"></button>
      </div>
    </div>
    <div class="routing-mode-status" id="routing-mode-status" role="status" aria-live="polite"></div>
    <h3 class="dash-subsection-title" id="dash-ollama-runtime-h">Ollama runtime</h3>
    <p class="params-sub pool-hint-line" id="vram-default-hint" style="display:none;margin-bottom:8px" role="status" aria-live="polite"></p>
    <div id="vram-cards-root" class="model-cards-row row" role="list" aria-labelledby="dash-ollama-runtime-h"></div>
    <h2 class="dash-section-title" id="dash-models-h">Models &amp; routing</h2>
    <div class="models-toolbar-row">
      <div class="models-toolbar-default">
        <label class="local-model-lbl" for="local-model-select">Default model <i class="tip-icon" data-tip="The primary Ollama model used for local requests. Also acts as the tie-breaker when Smart routing cannot clearly prefer another pool model. Saved to hybrid.config.json immediately on change." data-tip-bottom="">?</i></label>
        <select id="local-model-select" class="local-model-select" title="Primary model in hybrid.config.json; tie-breaker for smart routing"></select>
      </div>
      <label class="local-model-lbl models-smart-cb" data-tip="When checked, the router picks the best model from your pool for each request — choosing smaller/faster models for quick tasks and larger models for heavy tool use or complex prompts. Uncheck to always use the Default model."><input type="checkbox" id="smart-routing-cb" checked> Smart routing</label>
      <span class="saved-msg routing-saved-msg" id="pool-save-msg" style="opacity:0" aria-live="polite">\u2713 Saved</span>
    </div>
    <div class="models-fast-row">
      <div class="models-toolbar-fast">
        <label class="local-model-lbl" for="fast-model-select">Speed assist model <i class="tip-icon" data-tip='A smaller, faster Ollama model boosted when the prompt is short and contains speed hints like "brief", "quick", "summary", or "tldr". Reduces latency for simple questions without switching to cloud. Leave (None) to always use the Default model.' data-tip-bottom="">?</i></label>
        <select id="fast-model-select" class="local-model-select" title="Optional smaller model (local.fast_model) boosted when the user asks for brief or quick answers. Saves automatically when changed.">
          <option value="">(None)</option>
        </select>
      </div>
      <p class="models-fast-hint">Smaller Ollama tag preferred for speed-style prompts ("brief", "quick", "tldr"). Leave (None) to disable. Same pool / smart routing rules apply.</p>
    </div>
    <div class="local-pool-panel local-pool-panel--compact" id="local-pool-panel">
      <div class="pool-panel-block">
        <div class="local-model-lbl" id="pool-chips-label">Pool (optional) <i class="tip-icon" data-tip="Restrict which installed Ollama models the router is allowed to use. Useful if you have many models but only want a specific subset for Claude Code. Leave all unchecked to allow any installed model. Smart routing will pick among checked models based on task type." data-tip-bottom="">?</i></div>
        <p class="pool-explainer" id="pool-explainer">Check models to include in local routing. Leave all unchecked to allow the full installed library. Smart routing picks among checked models by task type.</p>
        <p class="params-sub pool-hint-line" id="pool-hint" role="status"></p>
        <div id="pool-chips-root" class="pool-chips-grid" role="group" aria-labelledby="pool-chips-label"></div>
      </div>
      <select id="local-pool-select" class="pool-select-hidden" multiple aria-hidden="true" tabindex="-1" title="Synced from pool chips"></select>
    </div>
  </section>

  <section class="dash-card dash-card--params" id="section-model-params" aria-labelledby="dash-gen-h">
    <div class="params-card-header">
    <h2 class="dash-section-title" id="dash-gen-h">Generation parameters</h2>
    <div class="params-toolbar">
      <button type="button" class="pbtn pbtn-secondary" id="btn-open-gen-json" onclick="openModelParamsFilesModal()" data-tip="Open the raw JSON editor for model-params.json (global defaults) and model-params-per-model.json (per-model overrides). Edit directly when you want fine-grained control." data-tip-left="">Edit config (JSON)…</button>
      <button type="button" class="pbtn pbtn-secondary" id="btn-open-gen-settings" onclick="openSettingsModal()" data-tip="Open the Generation settings table — shows Built-in defaults, Global overrides, per-Model overrides, and the Effective values that will be sent on the next local request. Save changes here." data-tip-left="">Generation settings…</button>
    </div>
    </div>
  <div class="params-panel">
    <div class="params-hdr">
      <span class="params-hdr-label">Sliders</span>
      <div class="pact">
        <span class="saved-msg" id="saved-msg" aria-live="polite">Saved &#10003;</span>
        <button type="button" class="pbtn pbtn-reset" onclick="void resetParams()" data-tip="Reset all sliders and number inputs to the built-in defaults for the active model. Does not save automatically — click Save in Generation settings to persist.">Reset defaults</button>
      </div>
    </div>
    <div class="params-grid">
      ${paramSlider("temperature", "Temperature", "Randomness. Lower = focused.", 0, 2, 0.05, p.temperature, "Controls creativity/randomness. 0.1 = deterministic & precise (great for code). 0.7 = balanced. 1.5+ = creative/unpredictable. For coding tasks keep this under 0.8.")}
      ${paramSlider("top_p", "Top P", "Nucleus sampling cutoff.", 0, 1, 0.05, p.top_p, "Nucleus sampling: only consider tokens whose cumulative probability is ≤ this value. 0.9 = default Ollama. Lower = more focused. Works alongside Temperature — reduce one if you reduce the other.")}
      ${paramSlider("top_k", "Top K", "Vocabulary pool size.", 1, 100, 1, p.top_k, "Limits sampling to the top K most likely next tokens. Lower = safer, more predictable output. 40 is typical. 0 = disabled (use Top P alone).")}
      ${paramNumber("num_ctx", "Context length", "Tokens in context window. Affects VRAM.", 512, 131072, p.num_ctx, "Number of tokens the model holds in memory (prompt + response). Larger = longer conversations but uses more VRAM. The router auto-escalates to cloud when the conversation fills this window.")}
      ${paramNumber("seed", "Seed", "0 = random. Fixed = reproducible.", -1, 999999, p.seed, "Random seed for generation. -1 or 0 = random output every time. A fixed positive value gives identical responses for identical prompts — useful for debugging or reproducible tests.")}
      ${paramSlider("repeat_penalty", "Repeat penalty", "Discourages repetition. 1.0 = off.", 1, 1.5, 0.01, p.repeat_penalty, "Penalises the model for repeating the same phrases or tokens. 1.0 = no penalty (off). 1.1 = mild. 1.3+ = strong. Increase if responses loop or repeat themselves.")}
    </div>
    <span class="adv-toggle" id="adv-toggle" onclick="toggleAdv()">+ Advanced</span>
    <div class="params-adv" id="params-adv">
      ${paramNumber("num_predict", "Max tokens", "Output length. -1 = unlimited.", -1, 4096, p.num_predict, "Maximum number of tokens the model will generate in one response. -1 = unlimited (let the model decide). Set a limit to cap very long responses or reduce latency.")}
      ${paramSlider("min_p", "Min P", "Min probability vs top token.", 0, 0.2, 0.01, p.min_p, "Minimum probability relative to the top token. An alternative to Top P. Tokens below this fraction of the top token's probability are filtered out. 0 = disabled. Helps cut very low-probability tokens.")}
      ${paramNumber("repeat_last_n", "Repeat last N", "Repetition check window.", 0, 512, p.repeat_last_n, "How many previous tokens to scan when applying Repeat penalty. 0 = disabled. 64 = typical. 128 = longer memory for repetition detection. Higher values use slightly more compute.")}
      ${paramSlider("presence_penalty", "Presence penalty", "Penalise seen tokens.", 0, 1, 0.05, p.presence_penalty, "Penalises any token that has appeared at all in the conversation (OpenAI-style). Higher = more topic diversity and less repetition of concepts. 0 = off.")}
      ${paramSlider("frequency_penalty", "Frequency penalty", "Penalise frequent tokens.", 0, 1, 0.05, p.frequency_penalty, "Penalises tokens proportional to how often they appear. Unlike Presence penalty this scales with frequency. Higher = less repetition of common words. 0 = off.")}
    </div>
  </div>
  </section>

  <footer class="dash-supporter-footer" role="contentinfo" aria-label="Support">
    <div class="dash-supporter-row">
      <span class="dash-supporter-text">Thanks for helping this tool advance.</span>
      <a class="dash-bmc-link" href="https://buymeacoffee.com/bazoukajo" target="_blank" rel="noopener noreferrer">Buy Me a Coffee</a>
    </div>
  </footer>

</div>

<footer id="fixedLogFooter" class="fixed-log-footer" aria-label="Output window footer">
  <div id="fixedLogResizer" class="fixed-log-resizer" title="Drag to resize output window"></div>
  <section class="fixed-log-panel">
    <div class="fixed-log-head">
      <div class="fixed-log-head-main">
        <div class="fixed-log-title" data-tip="Real-time log of every routing decision. Each line shows whether the request went to your local Ollama model or to Anthropic cloud, and why.">Router log <span class="fixed-log-count">(<span id="fixedLogCount">0</span>)</span></div>
        <div class="fixed-log-preview" id="fixedLogPreview" aria-live="polite" title="Latest log line (visible when the log panel is collapsed)"></div>
        <div class="fixed-log-stats" aria-label="Routing counters">
          <span class="fixed-log-stat local" data-tip="Requests handled by your local Ollama model this session. Free, private, no API quota used."><strong id="cnt-local">0</strong> Local</span>
          <span class="fixed-log-stat cloud" data-tip="Requests sent to Anthropic cloud (Claude API) this session. These consume your API quota."><strong id="cnt-cloud">0</strong> Cloud</span>
          <span class="fixed-log-stat total" data-tip="Total requests proxied this session (Local + Cloud + any fallbacks)."><strong id="cnt-total">0</strong> Total</span>
        </div>
      </div>
      <div class="fixed-log-tools">
        <button type="button" id="fixedLogToggleBtn" class="fixed-log-toggle" title="Collapse footer">Collapse</button>
      </div>
    </div>
    <div id="fixedLogOutput" class="fixed-log-output"><div class="fixed-log-empty" id="fixedLogEmpty">No routing events yet.</div></div>
  </section>
</footer>

<div id="settings-modal" class="modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
  <div class="modal-box modal-box--wide modal-box--settings">
    <div class="modal-head">
      <span id="settings-modal-title">Generation settings</span>
      <button type="button" class="modal-x" id="settings-modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body settings-body">
      <div class="settings-panel" id="settings-panel-single">
        <div class="settings-model-bar">
          <span class="settings-model-name" id="settings-active-model-label">\u2014</span>
          <span class="settings-pill off" id="settings-loaded-pill">—</span>
        </div>
        <details class="settings-hint-details" id="settings-hint-details">
          <summary>How this table works</summary>
          <div class="settings-hint-body">Edit numbers in place. <strong>Built-in</strong> = generic defaults plus a <strong>model-family preset</strong> matched from your Ollama tag (e.g. llama3, gemma4, qwen2.5). <strong>Global</strong> = that baseline plus your sparse overrides in <span class="inline-code">.claude/model-params.json</span>. <strong>Model</strong> = per-tag overrides only. <strong>Effective</strong> = next local request. <strong>Save global</strong> stores only values that differ from the built-in row for the active model. <strong>Save model overrides</strong> updates <span class="inline-code">.claude/model-params-per-model.json</span>. Raw JSON: <strong>Edit config (JSON)</strong>.</div>
        </details>
        <div class="wrap-table">
          <table class="diff-table diff-table--editable" id="settings-diff-table">
            <thead><tr><th>Parameter</th><th>Built-in</th><th title="All models">Global</th><th title="This model only">Model</th><th>Effective</th></tr></thead>
            <tbody id="settings-diff-tbody"></tbody>
          </table>
        </div>
        <div class="settings-actions settings-actions--footer">
          <span class="saved-per-msg" id="settings-saved-global-msg">Saved \u2713</span>
          <button type="button" class="pbtn pbtn-save" id="save-global-settings-btn" data-tip="Save the Effective column values as global defaults (model-params.json). Only values that differ from the built-in row are stored — keeps the file minimal.">Save global</button>
          <span class="saved-per-msg" id="settings-saved-per-msg">Saved \u2713</span>
          <button type="button" class="pbtn pbtn-save" id="save-per-model-btn" data-tip="Save the Model column values as overrides for this specific Ollama tag (model-params-per-model.json). These apply on top of Global when this exact model is active.">Save model overrides</button>
          <button type="button" class="pbtn pbtn-reset" id="clear-per-model-btn" data-tip="Remove all per-model overrides for this tag. The model will fall back to Global defaults. Cannot be undone without manually editing model-params-per-model.json.">Clear model overrides</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="params-files-modal" class="modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="params-files-modal-title">
  <div class="modal-box modal-box--wide modal-box--settings">
    <div class="modal-head">
      <span id="params-files-modal-title">Model parameter files</span>
      <button type="button" class="modal-x" id="params-files-modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body settings-body">
      <details class="settings-hint-details">
        <summary>About these files</summary>
        <div class="settings-hint-body">
          <p><strong>Local Ollama only.</strong> The router applies these numbers to <strong>local</strong> completions only. Requests sent to Anthropic use the API defaults, which avoids burning cloud tokens when work stays on your GPU.</p>
          <p><strong>Amber</strong> on the main sliders (or vs the Built-in column in the table) means a value differs from the built-in template.</p>
          <p><strong>Files:</strong> <span class="inline-code">.claude/model-params.json</span> stores only <strong>sparse</strong> overrides on top of generic defaults plus a <strong>per-family preset</strong> chosen from your Ollama model tag (see <span class="inline-code">router/lib/ollama-model-presets.js</span>). An empty <code>{}</code> means &quot;use presets only&quot;. <span class="inline-code">.claude/model-params-per-model.json</span> maps each tag to extra overrides. Edit below or use sliders / <strong>Generation settings</strong>.</p>
          <p>Unknown keys are ignored; values are coerced to numbers. POST may require <span class="inline-code">ROUTER_ADMIN_TOKEN</span> if set.</p>
        </div>
      </details>
      <div class="params-files-tabs" role="tablist" aria-label="Config file">
        <button type="button" class="params-file-tab" role="tab" id="tab-params-global" aria-controls="params-files-textarea" aria-selected="true">model-params.json</button>
        <button type="button" class="params-file-tab" role="tab" id="tab-params-per" aria-controls="params-files-textarea" aria-selected="false">model-params-per-model.json</button>
      </div>
      <p class="params-files-path" id="params-files-path-hint">.claude/model-params.json</p>
      <textarea id="params-files-textarea" class="params-files-textarea" spellcheck="false" autocomplete="off" aria-label="JSON contents"></textarea>
      <p class="params-files-err" id="params-files-err" hidden role="alert"></p>
      <div class="settings-actions settings-actions--footer" style="margin-top:10px">
        <button type="button" class="pbtn pbtn-reset" id="params-files-reload">Reload from disk</button>
        <button type="button" class="pbtn pbtn-save" id="params-files-save">Save to disk</button>
      </div>
    </div>
  </div>
</div>

<div id="model-info-modal" class="modal-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="model-info-title">
  <div class="modal-box modal-box--wide">
    <div class="modal-head">
      <span id="model-info-title">Model details</span>
      <button type="button" class="modal-x" id="model-info-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body info-modal-body">
      <p class="info-readonly-note" id="info-readonly-note">Read-only snapshot for the model below. Values match the next <strong>local</strong> request (same as Generation settings effective column). Edit from the main page: <strong>Generation settings</strong> or <strong>Edit config (JSON)</strong>.</p>
      <div class="info-hero">
        <div class="info-hero-logo"><img src="/assets/ollama-logo.png" alt=""></div>
        <div>
          <div class="info-hero-name" id="info-hero-name">\u2014</div>
          <div class="info-hero-meta" id="info-hero-meta"></div>
        </div>
      </div>
      <div class="info-cards" id="info-cards"></div>
      <div class="info-section-title">Router request (effective)</div>
      <div class="info-opt-grid" id="info-opt-grid"></div>
      <div class="info-actions">
        <button type="button" class="mact mact-info" id="info-toggle-raw">Show raw JSON</button>
      </div>
      <pre class="info-raw-pre" id="model-info-pre" hidden></pre>
    </div>
  </div>
</div>

<script>
// ── Theme ──────────────────────────────────────────────────────────────────
function toggleTheme(){
  const root=document.documentElement;
  const next=root.classList.contains('dark')?'light':'dark';
  root.classList.remove('dark','light'); root.classList.add(next);
  try{localStorage.setItem('theme',next);}catch{}
}
(function(){try{const t=localStorage.getItem('theme');if(t){document.documentElement.classList.remove('dark','light');document.documentElement.classList.add(t);}}catch{}})();

function routerAuthHeaders(){
  const h={};
  try{const t=sessionStorage.getItem('routerAdminToken');if(t)h['X-Router-Token']=t;}catch{}
  return h;
}
function routerFetch(url,opts){
  opts=opts||{};
  opts.headers=Object.assign({},opts.headers||{},routerAuthHeaders());
  return fetch(url,opts);
}
/** Abort fetch after ms so the UI never stays on &quot;Checking…&quot; forever. */
function fetchWithTimeout(url,ms,init){
  init=init||{};
  const ac=new AbortController();
  const t=setTimeout(function(){ try{ ac.abort(); }catch(_){} },ms);
  const next=Object.assign({},init,{signal:ac.signal});
  return fetch(url,next).finally(function(){ clearTimeout(t); });
}

var hdrStickyRaf=0, hdrStickyLastPx=-1;
function syncHdrStickyOffset(){
  if(hdrStickyRaf)return;
  hdrStickyRaf=requestAnimationFrame(function(){
    hdrStickyRaf=0;
    try{
      const el=document.querySelector('.hdr');
      if(!el)return;
      const px=Math.ceil(el.getBoundingClientRect().height)+6;
      if(px===hdrStickyLastPx)return;
      hdrStickyLastPx=px;
      document.documentElement.style.setProperty('--hdr-anchor-offset',px+'px');
    }catch(_){}
  });
}
window.addEventListener('resize',syncHdrStickyOffset);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',syncHdrStickyOffset);
else syncHdrStickyOffset();
requestAnimationFrame(function(){ requestAnimationFrame(syncHdrStickyOffset); });

// ── Sparkline ──────────────────────────────────────────────────────────────
var routingMode=${jsonForInlineScript(routingModeInitial)};
var cloudQuotaUiState={exceeded:false,message:'',at:0,disabled_modes:[]};
function routingModeLabelFor(mode){
  return mode==='cloud'?'Claude only':mode==='local'?'Ollama only':'Hybrid';
}
function routingModeSubLabelFor(mode){
  return mode==='cloud'?'Claude API':mode==='local'?'Always local':'Smart local + Claude';
}
function applyRoutingModeButton(m, quota){
  var s=String(m||'').trim().toLowerCase();
  if(s!=='cloud'&&s!=='local'&&s!=='hybrid')s='hybrid';
  routingMode=s;
  cloudQuotaUiState=quota&&quota.exceeded?quota:{exceeded:false,message:'',at:0,disabled_modes:[]};
  ['hybrid','cloud','local'].forEach(function(mode){
    var b=document.getElementById('routing-mode-btn-'+mode);
    if(!b)return;
    var disabled=!!(cloudQuotaUiState.exceeded&&(mode==='hybrid'||mode==='cloud'));
    var active=!disabled&&mode===s;
    b.className='routing-mode-btn routing-mode-btn--section routing-mode-btn--choice routing-mode--'+mode+(active?' is-active':'')+(disabled?' is-disabled':'');
    b.disabled=disabled;
    b.innerHTML='<span class="routing-mode-btn-main">'+routingModeLabelFor(mode)+'</span><span class="routing-mode-btn-sub">'+(disabled?'Quotas exceeded':(active?'Active':routingModeSubLabelFor(mode)))+'</span>';
    b.setAttribute('aria-label','Routing mode: '+routingModeLabelFor(mode)+(disabled?' (quotas exceeded)':''));
    b.setAttribute('aria-pressed',active?'true':'false');
    b.title=disabled?(routingModeLabelFor(mode)+' unavailable: quotas exceeded'):(active?(routingModeLabelFor(mode)+' active'):'Switch to '+routingModeLabelFor(mode));
    var tips={
      hybrid:'Smart routing: automatically sends simple tasks to Ollama (free, private) and escalates complex prompts, large contexts, or routing keywords to Claude. Best default for most users — saves ~40–70% cloud cost.',
      cloud:'All requests go to Anthropic cloud (Claude). Full model quality for every message. Uses API quota for every request — no local inference. Use when local quality is insufficient for your current task.',
      local:'All requests go to your local Ollama model. Fully offline and private — no API quota used. Quality is limited to your local model. Ideal for sensitive codebases or when internet is unavailable.'
    };
    if(disabled) b.removeAttribute('data-tip');
    else b.setAttribute('data-tip', tips[mode]||'');
  });
  var status=document.getElementById('routing-mode-status');
  if(status){
    if(cloudQuotaUiState.exceeded){
      var msg=cloudQuotaUiState.message?statEsc(cloudQuotaUiState.message):'Cloud quota exceeded';
      status.innerHTML='<strong>Cloud quotas exceeded.</strong> Claude and Hybrid are temporarily disabled, and requests are routed to Ollama local by default.<br><span>'+msg+'</span>';
      status.className='routing-mode-status is-visible';
    }else{
      status.textContent='';
      status.className='routing-mode-status';
    }
  }
}
/** Same pattern as ollama-dashboard app/static/js/main.js (timelineData + drawTimeline): fixed canvas width/height attrs, draw on each stats fetch. */
const sparkData={cpu:[],ram:[],vram:[],gpu:[]};
const MAX_SPARK_POINTS=60;
const SPARK_COLOR_CPU='#3b82f6';
const SPARK_COLOR_RAM='#22c55e';
const SPARK_COLOR_VRAM='#06b6d4';
const SPARK_COLOR_GPU='#f59e0b';
function hexToFillRgba(hex,a){
  try{
    const m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex||''));
    if(m) return 'rgba('+parseInt(m[1],16)+','+parseInt(m[2],16)+','+parseInt(m[3],16)+','+a+')';
  }catch(_){}
  return 'rgba(59,130,246,'+a+')';
}
function drawResourceTimeline(canvas,data,colorHex){
  if(!canvas||!data||data.length<2)return;
  const ctx=canvas.getContext('2d');
  if(!ctx)return;
  const width=canvas.width;
  const height=canvas.height;
  ctx.clearRect(0,0,width,height);
  var grid=document.documentElement.classList.contains('light')?'rgba(0,0,0,0.08)':'rgba(255,255,255,0.1)';
  ctx.strokeStyle=grid;
  ctx.lineWidth=1;
  ctx.beginPath();
  ctx.moveTo(0,height*0.25); ctx.lineTo(width,height*0.25);
  ctx.moveTo(0,height*0.5); ctx.lineTo(width,height*0.5);
  ctx.moveTo(0,height*0.75); ctx.lineTo(width,height*0.75);
  ctx.stroke();
  ctx.fillStyle=hexToFillRgba(colorHex,0.3);
  ctx.beginPath();
  ctx.moveTo(0,height);
  const stepX=width/(data.length-1);
  for(let i=0;i<data.length;i++){
    const x=i*stepX;
    const v=Math.max(0,Math.min(100,Number(data[i])||0));
    const y=height-(v/100)*height;
    ctx.lineTo(x,y);
  }
  ctx.lineTo(width,height);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle=colorHex;
  ctx.lineWidth=2;
  ctx.beginPath();
  for(let i=0;i<data.length;i++){
    const x=i*stepX;
    const v=Math.max(0,Math.min(100,Number(data[i])||0));
    const y=height-(v/100)*height;
    if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
  const last=Math.max(0,Math.min(100,Number(data[data.length-1])||0));
  const cx=(data.length-1)*stepX;
  const cy=height-(last/100)*height;
  ctx.fillStyle=colorHex;
  ctx.beginPath();
  ctx.arc(cx,cy,3,0,2*Math.PI);
  ctx.fill();
}
function redrawAllSparks(){
  drawResourceTimeline(document.getElementById('spark-cpu'),sparkData.cpu,SPARK_COLOR_CPU);
  drawResourceTimeline(document.getElementById('spark-ram'),sparkData.ram,SPARK_COLOR_RAM);
  drawResourceTimeline(document.getElementById('spark-vram'),sparkData.vram,SPARK_COLOR_VRAM);
  drawResourceTimeline(document.getElementById('spark-gpu'),sparkData.gpu,SPARK_COLOR_GPU);
}
function pushSpark(key,val){
  const d=sparkData[key];
  const n=Number(val);
  d.push(Number.isFinite(n)?Math.max(0,Math.min(100,n)):0);
  if(d.length>MAX_SPARK_POINTS)d.shift();
}

// ── System stats ───────────────────────────────────────────────────────────
function applySystemStatsToDom(d){
  if(!d||typeof d!=='object')return;
  function pct(el,v){
    if(!el)return;
    if(v==null||v===''){ el.textContent='—%'; return; }
    const n=Number(v);
    el.textContent=Number.isFinite(n)?(Math.round(n)+'%'):'—%';
  }
  pct(document.getElementById('r-cpu'),d.cpu);
  pct(document.getElementById('r-ram'),d.ram);
  pct(document.getElementById('r-vram'),d.vram);
  pct(document.getElementById('r-gpu'),d.gpu);
}
function ingestSystemStatsPayload(d){
  if(!d||typeof d!=='object')return;
  applySystemStatsToDom(d);
  pushSpark('cpu',d.cpu); pushSpark('ram',d.ram); pushSpark('vram',d.vram); pushSpark('gpu',d.gpu);
  redrawAllSparks();
}
window.__claudeHybridIngestSystemStats=ingestSystemStatsPayload;
async function refreshStats(){
  try{
    const r=await fetchWithTimeout('/api/system-stats',15000);
    if(!r.ok)return;
    const d=await r.json();
    ingestSystemStatsPayload(d);
  }catch{}
}

// ── Health & service controls ──────────────────────────────────────────────
let _healthPollGen=0;
async function refreshHealth(){
  const badge=document.getElementById('health-badge');
  const text=document.getElementById('health-text');
  const rdot=document.getElementById('rdot');
  try{
    const r=await fetchWithTimeout('/api/health',10000);
    if(!r.ok){
      if(badge) badge.className='health-badge unhealthy';
      if(text) text.textContent='Router HTTP '+r.status;
      if(rdot) rdot.className='rdot err';
      return;
    }
    const d=await r.json();
    if(badge) badge.className='health-badge '+(d.status||'unhealthy');
    if(d.status==='healthy'){
      const m=Math.floor((d.uptime_seconds||0)/60), h=Math.floor(m/60);
      if(text) text.textContent='Healthy'+(d.uptime_seconds?(' \u00b7 '+( h>0?h+'h '+m%60+'m':m+'m')):'');
      if(rdot) rdot.className='rdot';
    } else if(d.status==='degraded'){
      if(text) text.textContent='Degraded \u00b7 Ollama not running';
      if(rdot) rdot.className='rdot err';
    } else {
      if(text) text.textContent='Unhealthy'+(d.error?' \u00b7 '+d.error:'');
      if(rdot) rdot.className='rdot err';
    }
    _healthPollGen++;
    const chip=document.getElementById('chip-ollama');
    if(chip && d.ollama_version && (_healthPollGen%8===1 || !chip.textContent||chip.textContent==='Ollama')){
      chip.textContent='Ollama v'+d.ollama_version;
    }
    const refreshRow=document.getElementById('refresh-row');
    if(refreshRow) refreshRow.title='Last updated: '+new Date().toLocaleTimeString();
  }catch(e){
    if(badge) badge.className='health-badge unhealthy';
    if(text) text.textContent=(e&&e.name==='AbortError')?'Router not responding (timeout)':'Health check failed';
    if(rdot) rdot.className='rdot err';
  }
}

// ── Model card ─────────────────────────────────────────────────────────────
function fmtBytes(n){
  if(n==null||n==='')return '\u2014';
  const x=typeof n==='number'?n:Number(n);
  if(!Number.isFinite(x)||x<=0)return '\u2014';
  const g=x/1e9;
  return g>=1?g.toFixed(1)+' GB':(x/1e6).toFixed(0)+' MB';
}
function fmtCtxTok(n){ if(n==null||n===''||Number.isNaN(Number(n)))return '\u2014'; return Number(n).toLocaleString()+' tokens'; }

function syncPoolHiddenSelect(){
  const root=document.getElementById('pool-chips-root');
  const ps=document.getElementById('local-pool-select');
  if(!root||!ps)return;
  const byVal=new Map([...root.querySelectorAll('.pool-chip input[type=checkbox]')].map(cb=>[cb.value,cb.checked]));
  for(const opt of ps.options){
    opt.selected=!!byVal.get(opt.value);
  }
}
function updatePoolHint(){
  const ph=document.getElementById('pool-hint');
  const root=document.getElementById('pool-chips-root');
  if(!ph)return;
  const n=root?root.querySelectorAll('.pool-chip').length:0;
  const checked=root?root.querySelectorAll('input[type=checkbox]:checked').length:0;
  if(n===0){
    ph.textContent='No models installed — run ollama pull';
  }else if(checked===0){
    ph.textContent=n+' model'+(n===1?'':'s')+' installed · full library allowed (check models to restrict the pool)';
  }else{
    ph.textContent=n+' installed · pool limited to '+checked+' model'+(checked===1?'':'s');
  }
}
function renderPoolChips(models,want){
  const root=document.getElementById('pool-chips-root');
  const ps=document.getElementById('local-pool-select');
  if(!root||!ps)return;
  root.innerHTML='';
  ps.innerHTML='';
  const list=[];
  const seen=new Set();
  for(const m of (models||[])){
    if(!m||!m.name||seen.has(m.name))continue;
    seen.add(m.name);
    list.push(m);
  }
  const restrict=want.size>0;
  for(const m of list){
    const on=restrict&&want.has(m.name);
    const lbl=document.createElement('label');
    lbl.className='pool-chip'+(on?' pool-chip--on':'');
    const cb=document.createElement('input');
    cb.type='checkbox';
    cb.value=m.name;
    cb.checked=on;
    cb.setAttribute('aria-label','Include '+m.name+' in local routing pool');
    const nameSpan=document.createElement('span');
    nameSpan.className='pool-chip-name';
    nameSpan.textContent=m.name;
    nameSpan.title=m.name;
    lbl.appendChild(cb);
    lbl.appendChild(nameSpan);
    if(m.size!=null){
      const sz=document.createElement('span');
      sz.className='pool-chip-size';
      sz.textContent=fmtBytes(m.size);
      lbl.appendChild(sz);
    }
    const onChipChange=()=>{
      lbl.classList.toggle('pool-chip--on',cb.checked);
      syncPoolHiddenSelect();
      updatePoolHint();
    };
    cb.addEventListener('change',onChipChange);
    root.appendChild(lbl);
    const opt=document.createElement('option');
    opt.value=m.name;
    opt.textContent=m.name;
    opt.selected=on;
    ps.appendChild(opt);
  }
  updatePoolHint();
}

async function refreshOllamaModelList(){
  try{
    const r=await fetchWithTimeout('/api/ollama-models',45000);
    if(!r.ok)return;
    const d=await r.json();
    let want=new Set();
    let fastCur='';
    const rCfg=await fetchWithTimeout('/api/router/local-routing-config',8000);
    if(rCfg.ok){
      try{
        const cfg=await rCfg.json();
        want=new Set(cfg.models||[]);
        fastCur=typeof cfg.fast_model==='string'?cfg.fast_model.trim():'';
        const cb=document.getElementById('smart-routing-cb');
        if(cb)cb.checked=cfg.smart_routing!==false;
      }catch{}
    }
    const cur=d.configured_model||'';
    const sel=document.getElementById('local-model-select');
    if(sel){
      sel.innerHTML='';
      const seen=new Set();
      for(const m of (d.models||[])){
        if(!m||!m.name||seen.has(m.name))continue;
        seen.add(m.name);
        const o=document.createElement('option');
        o.value=m.name;
        let label=m.name;
        if(m.size!=null)label+=' ('+fmtBytes(m.size)+')';
        o.textContent=label;
        if(m.name===cur)o.selected=true;
        sel.appendChild(o);
      }
      if(cur&&!seen.has(cur)){
        const o=document.createElement('option');
        o.value=cur;
        o.textContent=cur+' (configured, not in ollama list)';
        o.selected=true;
        sel.appendChild(o);
      }
    }
    const fastSel=document.getElementById('fast-model-select');
    if(fastSel){
      fastSel.innerHTML='';
      const noneOpt=document.createElement('option');
      noneOpt.value='';
      noneOpt.textContent='(None)';
      fastSel.appendChild(noneOpt);
      const seenFast=new Set();
      for(const m of (d.models||[])){
        if(!m||!m.name||seenFast.has(m.name))continue;
        seenFast.add(m.name);
        const o=document.createElement('option');
        o.value=m.name;
        let label=m.name;
        if(m.size!=null)label+=' ('+fmtBytes(m.size)+')';
        o.textContent=label;
        fastSel.appendChild(o);
      }
      if(fastCur&&!seenFast.has(fastCur)){
        const o=document.createElement('option');
        o.value=fastCur;
        o.textContent=fastCur+' (in config, not in ollama list)';
        fastSel.appendChild(o);
      }
      fastSel.value=fastCur;
    }
    renderPoolChips(d.models,want);
  }catch{}
}

function vramStripTagLoose(s){
  const n=String(s||'').trim().toLowerCase();
  const i=n.lastIndexOf(':');
  if(i<=0)return n;
  const t=n.slice(i+1);
  if(!/^[a-z0-9._+-]+$/i.test(t))return n;
  return n.slice(0,i);
}
function vramNamesMatch(cfg, psName){
  const a=String(cfg||'').trim().toLowerCase();
  const b=String(psName||'').trim().toLowerCase();
  if(!a||!b)return false;
  if(a===b)return true;
  const sa=vramStripTagLoose(a), sb=vramStripTagLoose(b);
  return sa===sb || a===sb || sa===b;
}
function specItem(iconChar, label, value, title){
  const row=document.createElement('div');
  row.className='spec-item';
  const ic=document.createElement('div');
  ic.className='spec-icon';
  const ch=document.createElement('span');
  ch.className='spec-ico-char';
  ch.setAttribute('aria-hidden','true');
  ch.textContent=iconChar;
  ic.appendChild(ch);
  const ct=document.createElement('div');
  ct.className='spec-content';
  const lb=document.createElement('div');
  lb.className='spec-label';
  lb.textContent=label;
  const vl=document.createElement('div');
  vl.className='spec-value';
  vl.textContent=value;
  if(title) vl.title=title;
  ct.appendChild(lb); ct.appendChild(vl);
  row.appendChild(ic); row.appendChild(ct);
  return row;
}
function buildVramLoadedCard(col, row, d){
  const name=row.name||'';
  const isDefault=vramNamesMatch(d.configured_model, name);
  const cs=row.card_specs||(isDefault?d.card_specs:null)||{};
  const caps=row.capabilities||(isDefault?d.capabilities:null)||{};
  const card=document.createElement('div');
  card.className='model-card h-100 loaded';
  card.dataset.modelName=name;

  /* ── Header ── */
  const head=document.createElement('div');
  head.className='model-header model-card-head';
  const iw=document.createElement('div');
  iw.className='model-icon-wrapper';
  iw.setAttribute('aria-hidden','true');
  iw.innerHTML='<span class="model-icon-main"><i class="fas fa-brain" aria-hidden="true"></i></span>';
  const hbody=document.createElement('div');
  hbody.className='model-card-head-body';
  const nr=document.createElement('div');
  nr.className='model-card-head-name-row';
  const titleEl=document.createElement('div');
  titleEl.className='model-title';
  const disp=document.createElement('span');
  disp.className='model-title-display';
  const full=document.createElement('span');
  full.className='model-title-full';
  full.textContent=name||'\u2014';
  disp.appendChild(full); titleEl.appendChild(disp);
  const trail=document.createElement('div');
  trail.className='model-card-head-trail';
  trail.setAttribute('aria-label','Model status');
  const meta=document.createElement('div');
  meta.className='model-meta';
  const pill=document.createElement('span');
  pill.className='status-indicator running';
  pill.innerHTML='<span>Loaded</span>';
  meta.appendChild(pill);
  trail.appendChild(meta);
  const aside=document.createElement('div');
  aside.className='model-card-head-aside';
  aside.setAttribute('aria-label','Capabilities');
  const capsDiv=document.createElement('div');
  capsDiv.className='model-capabilities';
  const capDefs=[['has_reasoning','fa-brain','Reasoning'],['has_vision','fa-image','Vision'],['has_tools','fa-tools','Tools']];
  for(const [key,icon,label] of capDefs){
    const sp=document.createElement('span');
    const v=caps[key];
    sp.className='capability-icon '+(v===true?'enabled':v===false?'disabled':'unknown');
    sp.title=label+': '+(v===true?'Available':v===false?'Not available':'Unknown');
    sp.innerHTML='<i class="fas '+icon+'" aria-hidden="true"></i>';
    capsDiv.appendChild(sp);
  }
  aside.appendChild(capsDiv);
  trail.appendChild(aside);
  nr.appendChild(titleEl); nr.appendChild(trail);
  hbody.appendChild(nr);
  head.appendChild(iw); head.appendChild(hbody);

  /* ── Specs grid (3 rows × 2 cols matching Ollama Dashboard) ── */
  const specs=document.createElement('div');
  specs.className='model-specs';
  const mkRow=(a,b)=>{ const r=document.createElement('div'); r.className='spec-row'; r.appendChild(a); r.appendChild(b); return r; };
  const fam=cs.family||'\u2014';
  const par=cs.parameter_size||'\u2014';
  const sz=cs.size!=null?cs.size:row.size;
  const sv=row.size_vram;
  const szN=typeof sz==='number'?sz:Number(sz);
  const svN=typeof sv==='number'?sv:Number(sv);
  const vp=Number.isFinite(szN)&&szN>0&&Number.isFinite(svN)?(svN/szN*100).toFixed(1):0;
  const gpuTxt=vp+'% ('+fmtBytes(sv)+')';
  const ctxMax=row.context_max!=null?row.context_max:d.context_max;
  const ctxAlloc=row.context_allocated!=null?row.context_allocated:d.context_allocated;
  specs.appendChild(mkRow(specItem('\u2699','Family',fam),specItem('\u2696','Parameters',par)));
  specs.appendChild(mkRow(specItem('\u{1F4BE}','Size',fmtBytes(sz)),specItem('\u{1F4A0}','GPU Allocation',gpuTxt)));
  specs.appendChild(mkRow(specItem('\u{1F4C8}','Max context',fmtCtxTok(ctxMax)),specItem('\u2194','Allocated',fmtCtxTok(ctxAlloc))));

  /* ── Action buttons (monitoring only: Info / Settings) ── */
  const actions=document.createElement('div');
  actions.className='model-actions model-actions--running hybrid-model-actions-2';
  function mcBtn(cls,iconCls,label,title,handler){
    const b=document.createElement('button');
    b.type='button'; b.className='btn '+cls; b.title=title;
    b.innerHTML='<i class="fas '+iconCls+'" aria-hidden="true"></i> <span class="model-action-btn-label">'+label+'</span>';
    b.addEventListener('click',handler);
    return b;
  }
  actions.appendChild(mcBtn('btn-info','fa-info-circle','Info','Model details (JSON)',()=>openCardModelInfo(name)));
  const settingsBtn=document.createElement('button');
  settingsBtn.type='button';
  settingsBtn.className='btn btn-secondary model-action-settings-btn';
  settingsBtn.title='Generation settings';
  settingsBtn.innerHTML='<span class="model-action-settings-inner"><i class="fas fa-cog" aria-hidden="true"></i> <span class="model-action-btn-label">Settings</span>'
    +'<span class="badge rounded-pill model-settings-badge model-settings-badge--'+(isDefault?'default':'set')+'">'
    +(isDefault?'Default':'')+'</span></span>';
  settingsBtn.addEventListener('click',()=>openSettingsModal(name));
  actions.appendChild(settingsBtn);

  card.appendChild(head);
  card.appendChild(specs);
  card.appendChild(actions);
  col.appendChild(card);
}
/** Compact empty state when Ollama has nothing in GPU memory (no fake “model card”). */
function buildVramEmptyState(root, d){
  const wrap=document.createElement('div');
  wrap.className='vram-empty-state';
  wrap.setAttribute('role','status');
  const title=document.createElement('div');
  title.className='vram-empty-title';
  title.textContent='No model running';
  const sub=document.createElement('div');
  sub.className='vram-empty-sub';
  const cfg=String(d.configured_model||'').trim();
  if(cfg) sub.textContent='The dashboard is monitoring Ollama. Start the configured model from Ollama when you want to use local AI.';
  else sub.textContent='Choose a default model above. This dashboard monitors status and settings but does not start or stop Ollama.';
  wrap.appendChild(title);
  wrap.appendChild(sub);
  root.appendChild(wrap);
}
function buildVramConfiguredIdleAside(root, d){
  const cfg=d.configured_model||'';
  if(!cfg)return;
  const col=document.createElement('div');
  col.className='col';
  const card=document.createElement('div');
  card.className='model-card h-100 unloaded';
  card.style.borderStyle='dashed';
  card.dataset.modelName=cfg;
  const head=document.createElement('div');
  head.className='model-header model-card-head';
  const t=document.createElement('div');
  t.className='model-card-head-body';
  t.innerHTML='<div class="model-card-head-name-row"><div class="model-title"><span class="model-title-display"><span class="model-title-full"></span></span></div><div class="model-meta"><span class="status-indicator available"><span>Default</span></span></div></div>';
  t.querySelector('.model-title-full').textContent=cfg;
  head.innerHTML='<div class="model-icon-wrapper" aria-hidden="true"><span class="model-icon-main"><i class="fas fa-sliders-h" aria-hidden="true"></i></span></div>';
  head.appendChild(t);
  const specs=document.createElement('div');
  specs.className='model-specs';
  const r=document.createElement('div');
  r.className='spec-row';
  r.appendChild(specItem('\u{1F4C8}','Max context',fmtCtxTok(d.context_max)));
  const rq=specItem('\u26A1','Router request',fmtCtxTok(d.request_num_ctx));
  rq.querySelector('.spec-value').classList.add('js-vram-router-req');
  r.appendChild(rq);
  specs.appendChild(r);
  card.appendChild(head);
  card.appendChild(specs);
  col.appendChild(card);
  root.appendChild(col);
}
function buildVramPoolCard(root, row){
  if(!root||!row||!row.name)return;
  const col=document.createElement('div');
  col.className='col';
  col.setAttribute('role','listitem');
  const card=document.createElement('div');
  card.className='model-card h-100 unloaded';
  card.dataset.modelName=row.name;
  const isDefault=!!row.is_default;
  const caps=row.capabilities||{};
  const cs=row.card_specs||{};

  const head=document.createElement('div');
  head.className='model-header model-card-head';
  const iw=document.createElement('div');
  iw.className='model-icon-wrapper';
  iw.setAttribute('aria-hidden','true');
  iw.innerHTML='<span class="model-icon-main"><i class="fas fa-cube" aria-hidden="true"></i></span>';
  const hbody=document.createElement('div');
  hbody.className='model-card-head-body';
  const nr=document.createElement('div');
  nr.className='model-card-head-name-row';
  const titleEl=document.createElement('div');
  titleEl.className='model-title';
  titleEl.innerHTML='<span class="model-title-display"><span class="model-title-full"></span></span>';
  titleEl.querySelector('.model-title-full').textContent=row.name;
  const trail=document.createElement('div');
  trail.className='model-card-head-trail';
  const meta=document.createElement('div');
  meta.className='model-meta';
  const pill=document.createElement('span');
  pill.className='status-indicator available';
  pill.innerHTML='<span>'+(isDefault?'Default · ':'')+'In pool</span>';
  meta.appendChild(pill);
  trail.appendChild(meta);
  const aside=document.createElement('div');
  aside.className='model-card-head-aside';
  aside.setAttribute('aria-label','Capabilities');
  const capsDiv=document.createElement('div');
  capsDiv.className='model-capabilities';
  const capDefs=[['has_reasoning','fa-brain','Reasoning'],['has_vision','fa-image','Vision'],['has_tools','fa-tools','Tools']];
  for(const [key,icon,label] of capDefs){
    const sp=document.createElement('span');
    const v=caps[key];
    sp.className='capability-icon '+(v===true?'enabled':v===false?'disabled':'unknown');
    sp.title=label+': '+(v===true?'Available':v===false?'Not available':'Unknown');
    sp.innerHTML='<i class="fas '+icon+'" aria-hidden="true"></i>';
    capsDiv.appendChild(sp);
  }
  aside.appendChild(capsDiv);
  trail.appendChild(aside);
  nr.appendChild(titleEl);
  nr.appendChild(trail);
  hbody.appendChild(nr);
  head.appendChild(iw);
  head.appendChild(hbody);

  const specs=document.createElement('div');
  specs.className='model-specs';
  const mkRow=(a,b)=>{ const r=document.createElement('div'); r.className='spec-row'; r.appendChild(a); r.appendChild(b); return r; };
  specs.appendChild(mkRow(specItem('\u2699','Family',cs.family||'\u2014'),specItem('\u2696','Parameters',cs.parameter_size||'\u2014')));
  specs.appendChild(mkRow(specItem('\u{1F4BE}','Size',fmtBytes(row.size)),specItem('\u{1F4C8}','Max context',fmtCtxTok(row.context_max))));
  specs.appendChild(mkRow(specItem('\u26A1','Router request',fmtCtxTok(row.request_num_ctx)),specItem('\u2194','Allocated','\u2014')));

  const actions=document.createElement('div');
  actions.className='model-actions model-actions--running hybrid-model-actions-2';
  function mcBtn(cls,iconCls,label,title,handler){
    const b=document.createElement('button');
    b.type='button';
    b.className='btn '+cls;
    b.title=title;
    b.innerHTML='<i class="fas '+iconCls+'" aria-hidden="true"></i> <span class="model-action-btn-label">'+label+'</span>';
    b.addEventListener('click',handler);
    return b;
  }
  actions.appendChild(mcBtn('btn-info','fa-info-circle','Info','Model details (JSON)',()=>openCardModelInfo(row.name)));
  const settingsBtn=document.createElement('button');
  settingsBtn.type='button';
  settingsBtn.className='btn btn-secondary model-action-settings-btn';
  settingsBtn.title='Generation settings';
  settingsBtn.innerHTML='<span class="model-action-settings-inner"><i class="fas fa-cog" aria-hidden="true"></i> <span class="model-action-btn-label">Settings</span>'
    +'<span class="badge rounded-pill model-settings-badge model-settings-badge--'+(isDefault?'default':'set')+'">'
    +(isDefault?'Default':'')+'</span></span>';
  settingsBtn.addEventListener('click',()=>openSettingsModal(row.name));
  actions.appendChild(settingsBtn);

  card.appendChild(head);
  card.appendChild(specs);
  card.appendChild(actions);
  col.appendChild(card);
  root.appendChild(col);
}
function renderVramSection(d){
  const root=document.getElementById('vram-cards-root');
  const hint=document.getElementById('vram-default-hint');
  if(!root)return;
  root.replaceChildren();
  if(hint){
    hint.style.display='none';
    hint.textContent='';
  }
  const list=Array.isArray(d.loaded_list)?d.loaded_list:[];
  const poolList=Array.isArray(d.pool_models)?d.pool_models:[];
  const cfg=d.configured_model||'';
  if(list.length===0&&poolList.length===0){
    buildVramEmptyState(root, d);
    if(hint){
      hint.textContent='';
      hint.style.display='none';
    }
    return;
  }
  for(const row of list){
    if(!row||!row.name)continue;
    const col=document.createElement('div');
    col.className='col';
    col.setAttribute('role','listitem');
    buildVramLoadedCard(col, row, d);
    root.appendChild(col);
  }
  for(const row of poolList){
    buildVramPoolCard(root, row);
  }
  if(hint){
    if(list.length===0&&poolList.length>0){
      hint.textContent='No pooled model is currently loaded in VRAM. Settings and model details remain available below.';
      hint.style.display='block';
    }else if(!d.configured_loaded&&cfg){
      hint.textContent='Default model is not loaded in VRAM yet. Ollama loads weights on first use. Pool entries below remain available for settings and details.';
      hint.style.display='block';
    }
  }
}

function applyCapabilityIconState(id, value, titleOk, titleOff, titleUnknown){
  const el=document.getElementById(id);
  if(!el)return;
  el.classList.remove('enabled','disabled','unknown');
  if(value===true){ el.classList.add('enabled'); el.title=titleOk; }
  else if(value===false){ el.classList.add('disabled'); el.title=titleOff; }
  else { el.classList.add('unknown'); el.title=titleUnknown; }
}

function applyCapabilityStates(caps){
  applyCapabilityIconState('cap-reasoning', caps?.has_reasoning, 'Reasoning supported', 'Reasoning not indicated', 'Reasoning unknown (no capabilities from Ollama)');
  applyCapabilityIconState('cap-vision', caps?.has_vision, 'Image / vision supported', 'Vision not supported', 'Vision unknown (no capabilities from Ollama)');
  applyCapabilityIconState('cap-tools', caps?.has_tools, 'Tool usage supported', 'Tools not supported', 'Tools unknown (no capabilities from Ollama)');
}

async function refreshModel(){
  try{
    const r=await fetchWithTimeout('/api/model-status',25000); if(!r.ok)return;
    const d=await r.json();
    renderVramSection(d);
    applyCapabilityStates(d.capabilities);
    const reqEl=document.querySelector('.js-vram-router-req');
    if(reqEl){
      reqEl.textContent=fmtCtxTok(d.request_num_ctx);
      const cm=Number(d.context_max), rq=Number(d.request_num_ctx);
      reqEl.classList.toggle('ctx-warn', Number.isFinite(cm)&&Number.isFinite(rq)&&rq>cm);
      reqEl.title=reqEl.classList.contains('ctx-warn')?'num_ctx exceeds metadata max; Ollama may clamp':'Effective num_ctx for next local completion';
    }
  }catch{
    applyCapabilityStates(null);
  }
}

function openCardModelInfo(modelName){
  const modal=document.getElementById('model-info-modal');
  if(!modal)return;
  infoRawVisible=false;
  const pre=document.getElementById('model-info-pre');
  const btn=document.getElementById('info-toggle-raw');
  if(pre){pre.hidden=true;pre.textContent='';}
  if(btn)btn.textContent='Show raw JSON';
  document.getElementById('info-hero-name').textContent='Loading\u2026';
  document.getElementById('info-hero-meta').textContent='';
  document.getElementById('info-cards').innerHTML='';
  document.getElementById('info-opt-grid').innerHTML='';
  modal.hidden=false;
  fetch('/api/router/model-details?model='+encodeURIComponent(modelName)).then(r=>r.json()).then(j=>{
    window.__lastModelDetails=j;
    document.getElementById('info-hero-name').textContent=j.model||'\u2014';
    const s=j.summary;
    const metaEl=document.getElementById('info-hero-meta');
    if(metaEl)metaEl.textContent=s?[s.family,s.parameter_size,s.quantization_level].filter(Boolean).join(' \u00b7 '):'';
    const cards=document.getElementById('info-cards');
    cards.innerHTML='';
    if(s){
      const items=[['Family',s.family],['Parameters',s.parameter_size],['Quantization',s.quantization_level],['Format',s.format],['Max context',s.context_max!=null?s.context_max.toLocaleString()+' tokens':null],['License',s.license],['Modified',s.modified_at]];
      for(const [lab,val] of items){
        if(val==null||val==='')continue;
        const card=document.createElement('div');card.className='info-card';
        card.innerHTML='<div class="info-card-lbl">'+escHtml(lab)+'</div><div class="info-card-val">'+escHtml(String(val))+'</div>';
        cards.appendChild(card);
      }
    }
    const og=document.getElementById('info-opt-grid');og.innerHTML='';
    const ro=j.router_request_options||{};
    const keys=['temperature','top_p','top_k','num_ctx','num_predict','repeat_penalty','seed'];
    for(const k of keys){
      if(ro[k]===undefined)continue;
      const chip=document.createElement('div');chip.className='info-opt-chip';
      chip.innerHTML='<span>'+escHtml(k.replace(/_/g,' '))+'</span>'+escHtml(String(ro[k]));
      og.appendChild(chip);
    }
  }).catch(()=>{document.getElementById('info-hero-name').textContent='Failed to load';});
}
async function setAsDefaultModel(modelName){
  try{
    await routerFetch('/api/local-model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:modelName})});
    const sel=document.getElementById('local-model-select');
    if(sel)sel.value=modelName;
    await refreshModel();
    await refreshOllamaModelList();
  }catch{}
}

let infoRawVisible=false;
function openModelInfoModal(){
  const modal=document.getElementById('model-info-modal');
  if(!modal)return;
  infoRawVisible=false;
  const pre=document.getElementById('model-info-pre');
  const btn=document.getElementById('info-toggle-raw');
  if(pre){ pre.hidden=true; pre.textContent=''; }
  if(btn) btn.textContent='Show raw JSON';
  document.getElementById('info-hero-name').textContent='Loading\u2026';
  document.getElementById('info-hero-meta').textContent='';
  document.getElementById('info-cards').innerHTML='';
  document.getElementById('info-opt-grid').innerHTML='';
  modal.hidden=false;
  fetch('/api/router/model-details').then(r=>r.json()).then(j=>{
    window.__lastModelDetails=j;
    document.getElementById('info-hero-name').textContent=j.model||'\u2014';
    const s=j.summary;
    const metaEl=document.getElementById('info-hero-meta');
    if(metaEl) metaEl.textContent=s?[s.family,s.parameter_size,s.quantization_level].filter(Boolean).join(' \u00b7 '):'';
    const cards=document.getElementById('info-cards');
    cards.innerHTML='';
    if(s){
      const items=[['Family',s.family],['Parameters',s.parameter_size],['Quantization',s.quantization_level],['Format',s.format],['Max context',s.context_max!=null?s.context_max.toLocaleString()+' tokens':null],['License',s.license],['Modified',s.modified_at]];
      for(const [lab,val]of items){
        if(val==null||val==='')continue;
        const card=document.createElement('div');
        card.className='info-card';
        card.innerHTML='<div class="info-card-lbl">'+escHtml(lab)+'</div><div class="info-card-val">'+escHtml(String(val))+'</div>';
        cards.appendChild(card);
      }
    }
    const og=document.getElementById('info-opt-grid');
    og.innerHTML='';
    const ro=j.router_request_options||{};
    const keys=['temperature','top_p','top_k','num_ctx','num_predict','repeat_penalty','seed'];
    for(const k of keys){
      if(ro[k]===undefined)continue;
      const chip=document.createElement('div');
      chip.className='info-opt-chip';
      chip.innerHTML='<span>'+escHtml(k.replace(/_/g,' '))+'</span>'+escHtml(String(ro[k]));
      og.appendChild(chip);
    }
  }).catch(()=>{
    document.getElementById('info-hero-name').textContent='Failed to load';
  });
}
function closeModelInfoModal(){
  const modal=document.getElementById('model-info-modal');
  if(modal) modal.hidden=true;
}
function formatParamKey(k){ return k.replace(/_/g,' '); }
function closeSettingsModal(){ const m=document.getElementById('settings-modal'); if(m) m.hidden=true; }
let paramsFilesActiveTab='global';
const paramsFilesStash={global:'',perModel:''};
function stashParamsFilesFromTextarea(){
  const ta=document.getElementById('params-files-textarea');
  if(!ta)return;
  if(paramsFilesActiveTab==='global') paramsFilesStash.global=ta.value;
  else paramsFilesStash.perModel=ta.value;
}
function setParamsFilesErr(msg){
  const el=document.getElementById('params-files-err');
  if(!el)return;
  if(msg){ el.textContent=msg; el.hidden=false; }
  else{ el.textContent=''; el.hidden=true; }
}
function updateParamsFileTabUi(){
  document.getElementById('tab-params-global')?.setAttribute('aria-selected',paramsFilesActiveTab==='global'?'true':'false');
  document.getElementById('tab-params-per')?.setAttribute('aria-selected',paramsFilesActiveTab==='per-model'?'true':'false');
  const hint=document.getElementById('params-files-path-hint');
  if(hint) hint.textContent=paramsFilesActiveTab==='global'?'.claude/model-params.json':'.claude/model-params-per-model.json';
}
function applyParamsFilesTextareaFromStash(){
  const ta=document.getElementById('params-files-textarea');
  if(!ta)return;
  ta.value=paramsFilesActiveTab==='global'?paramsFilesStash.global:paramsFilesStash.perModel;
}
function switchParamsFilesTab(which){
  stashParamsFilesFromTextarea();
  paramsFilesActiveTab=which==='per-model'?'per-model':'global';
  updateParamsFileTabUi();
  applyParamsFilesTextareaFromStash();
  setParamsFilesErr('');
}
async function openModelParamsFilesModal(){
  const m=document.getElementById('params-files-modal');
  if(!m)return;
  setParamsFilesErr('');
  paramsFilesActiveTab='global';
  updateParamsFileTabUi();
  m.hidden=false;
  try{
    const loadOne=async (which)=>{
      const r=await fetch('/api/router/model-params-raw?which='+encodeURIComponent(which));
      const j=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(j.error||('HTTP '+r.status));
      return j;
    };
    const [gr,pr]=await Promise.all([loadOne('global'),loadOne('per-model')]);
    paramsFilesStash.global=gr.content||'';
    paramsFilesStash.perModel=pr.content||'';
    applyParamsFilesTextareaFromStash();
  }catch(e){
    setParamsFilesErr('Could not load files: '+String(e.message||e));
  }
}
function closeParamsFilesModal(){
  const m=document.getElementById('params-files-modal');
  if(m) m.hidden=true;
}
async function reloadParamsFilesActive(){
  setParamsFilesErr('');
  const which=paramsFilesActiveTab==='per-model'?'per-model':'global';
  try{
    const r=await fetch('/api/router/model-params-raw?which='+encodeURIComponent(which));
    const j=await r.json().catch(()=>({}));
    if(!r.ok){ setParamsFilesErr(j.error||('HTTP '+r.status)); return; }
    const c=j.content||'';
    if(which==='global') paramsFilesStash.global=c;
    else paramsFilesStash.perModel=c;
    applyParamsFilesTextareaFromStash();
  }catch(e){
    setParamsFilesErr('Reload failed: '+String(e.message||e));
  }
}
async function saveParamsFilesActive(){
  stashParamsFilesFromTextarea();
  setParamsFilesErr('');
  const which=paramsFilesActiveTab==='per-model'?'per-model':'global';
  const content=which==='global'?paramsFilesStash.global:paramsFilesStash.perModel;
  try{
    const r=await routerFetch('/api/router/model-params-raw',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({which,content})});
    if(!r.ok){
      let err='HTTP '+r.status;
      try{ const j=await r.json(); if(j.error) err=j.error; }catch{}
      setParamsFilesErr(err);
      return;
    }
    await reloadParamsFilesActive();
    await syncGenerationSlidersFromServer();
    try{ await refreshParamsFullAndRender(); }catch{}
    await refreshModel();
  }catch(e){
    setParamsFilesErr(String(e.message||e));
  }
}
function fmtDiffNum(v){
  if(typeof v==='string'&&v.trim()!==''){
    const n=Number(v);
    if(Number.isFinite(n)) v=n;
  }
  if(typeof v!=='number'||!Number.isFinite(v)) return '\u2014';
  return Number.isInteger(v)?String(v):v.toFixed(4).replace(/\.?0+$/,'');
}
function updateSettingsEffectiveCell(key){
  const gInp=document.getElementById('sg-'+key);
  const cb=document.querySelector('#settings-diff-tbody .ov-cb[data-key="'+key+'"]');
  const mInp=document.getElementById('om-'+key);
  const effEl=document.querySelector('#settings-diff-tbody .settings-eff[data-key="'+key+'"]');
  if(!effEl)return;
  const ng=gInp?Number(gInp.value):NaN;
  const useM=cb&&cb.checked&&mInp;
  const nm=useM?Number(mInp.value):ng;
  effEl.textContent=Number.isFinite(nm)?fmtDiffNum(nm):'\u2014';
}
function attachSettingsTableListeners(){
  const tb=document.getElementById('settings-diff-tbody');
  if(!tb)return;
  tb.querySelectorAll('.ov-cb').forEach((cb)=>{
    const key=cb.dataset.key;
    const sync=()=>{
      const tr=cb.closest('tr');
      if(tr){
        tr.classList.toggle('settings-row-model-off',!cb.checked);
        tr.classList.toggle('row-has-patch',!!cb.checked);
      }
      updateSettingsEffectiveCell(key);
    };
    cb.addEventListener('change',sync);
    sync();
  });
  tb.querySelectorAll('.om-inp').forEach((inp)=>{
    const key=inp.id.slice(3);
    const enableRow=()=>{
      const tr=inp.closest('tr');
      const cbx=tr&&tr.querySelector('.ov-cb');
      if(cbx&&!cbx.checked){
        cbx.checked=true;
        tr.classList.remove('settings-row-model-off');
        tr.classList.add('row-has-patch');
      }
      updateSettingsEffectiveCell(key);
    };
    inp.addEventListener('focus',enableRow);
    inp.addEventListener('pointerdown',enableRow);
    inp.addEventListener('input',enableRow);
  });
  tb.querySelectorAll('.settings-global-inp').forEach((inp)=>{
    const key=inp.dataset.key;
    inp.addEventListener('input',()=>updateSettingsEffectiveCell(key));
  });
}
async function refreshParamsFullAndRender(modelName){
  const query=modelName?'?model='+encodeURIComponent(modelName):'';
  const r=await fetch('/api/model-params-full'+query);
  const d=await r.json();
  window.__paramsFull=d;
  const tb=document.getElementById('settings-diff-tbody');
  tb.innerHTML='';
  for(const key of d.param_keys){
    const bi=d.built_in[key], g=d.global[key], p=d.per_model_patch[key], e=d.effective[key];
    const has=Object.prototype.hasOwnProperty.call(d.per_model_patch,key);
    const gv=typeof g==='number'&&Number.isFinite(g)?g:bi;
    const mv=has&&typeof p==='number'&&Number.isFinite(p)?p:gv;
    const tr=document.createElement('tr');
    if(has) tr.classList.add('row-has-patch');
    const td0=document.createElement('td');
    td0.textContent=formatParamKey(key);
    const td1=document.createElement('td');
    td1.textContent=fmtDiffNum(bi);
    const td2=document.createElement('td');
    const gin=document.createElement('input');
    gin.type='number';
    gin.step='any';
    gin.className='param-num settings-global-inp';
    gin.dataset.key=key;
    gin.id='sg-'+key;
    gin.setAttribute('aria-label','Global '+formatParamKey(key));
    gin.value=String(gv);
    td2.appendChild(gin);
    const td3=document.createElement('td');
    td3.className='settings-model-cell diff-patch';
    const lab=document.createElement('label');
    lab.className='settings-ov-label';
    const cb=document.createElement('input');
    cb.type='checkbox';
    cb.className='ov-cb';
    cb.dataset.key=key;
    cb.checked=has;
    cb.title='Override global for this model';
    cb.setAttribute('aria-label','Per-model override for '+formatParamKey(key));
    lab.appendChild(cb);
    const oinp=document.createElement('input');
    oinp.type='number';
    oinp.step='any';
    oinp.className='param-num om-inp';
    oinp.id='om-'+key;
    oinp.setAttribute('aria-label','Model override '+formatParamKey(key));
    oinp.value=String(mv);
    td3.appendChild(lab);
    td3.appendChild(oinp);
    const td4=document.createElement('td');
    const eff=document.createElement('strong');
    eff.className='settings-eff';
    eff.dataset.key=key;
    eff.textContent=fmtDiffNum(e);
    td4.appendChild(eff);
    tr.appendChild(td0);
    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    tr.appendChild(td4);
    tb.appendChild(tr);
  }
  document.getElementById('settings-active-model-label').textContent=d.active_model||'\u2014';
  const pill=document.getElementById('settings-loaded-pill');
  pill.textContent=d.loaded?'Loaded':'Not loaded';
  pill.className='settings-pill '+(d.loaded?'on':'off');
  attachSettingsTableListeners();
  applyMainSlidersFromParamsFull(d);
}
async function alertFailedSave(r,ctx){
  let t='HTTP '+r.status;
  try{ const j=await r.json(); if(j.error)t=j.error; if(j.hint)t+=' — '+j.hint;}catch{}
  alert((ctx||'Save')+' failed: '+t+(r.status===401?'\\n\\nIf ROUTER_ADMIN_TOKEN is set, store it once in this tab: sessionStorage.setItem("routerAdminToken","YOUR_TOKEN")':''));
}
async function saveGlobalFromSettingsModal(){
  const d=window.__paramsFull;
  if(!d)return;
  const out={...d.global};
  for(const key of d.param_keys){
    const inp=document.getElementById('sg-'+key);
    if(!inp)continue;
    const n=Number(inp.value);
    if(Number.isFinite(n)) out[key]=n;
  }
  out._for_model=d.active_model;
  const r=await routerFetch('/api/model-params',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(out)});
  if(!r.ok){ await alertFailedSave(r,'Save global'); return; }
  const msg=document.getElementById('settings-saved-global-msg');
  if(msg){ msg.style.opacity=1; setTimeout(()=>{ msg.style.opacity=0; },2200); }
  await refreshParamsFullAndRender(d.active_model);
  await refreshModel();
}
function collectPerModelOverrides(){
  const out={};
  const root=document.getElementById('settings-diff-tbody');
  if(!root)return out;
  root.querySelectorAll('.ov-cb').forEach(cb=>{
    if(!cb.checked)return;
    const key=cb.dataset.key;
    const inp=document.getElementById('om-'+key);
    if(!inp)return;
    const n=Number(inp.value);
    if(Number.isFinite(n)) out[key]=n;
  });
  return out;
}
async function savePerModelOverrides(){
  const d=window.__paramsFull;
  if(!d)return;
  const overrides=collectPerModelOverrides();
  const r=await routerFetch('/api/model-params-per-model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:d.active_model,overrides})});
  if(!r.ok){ await alertFailedSave(r,'Save model overrides'); return; }
  const msg=document.getElementById('settings-saved-per-msg');
  if(msg){ msg.style.opacity=1; setTimeout(()=>msg.style.opacity=0,2200); }
  await refreshParamsFullAndRender(d.active_model);
  await refreshModel();
}
async function clearPerModelOverrides(){
  const d=window.__paramsFull;
  if(!d)return;
  const r=await routerFetch('/api/model-params-per-model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:d.active_model,overrides:{}})});
  if(!r.ok){ await alertFailedSave(r,'Clear overrides'); return; }
  await refreshParamsFullAndRender(d.active_model);
  await refreshModel();
}
async function openSettingsModal(modelName){
  try{ await refreshParamsFullAndRender(modelName); }catch{}
  document.getElementById('settings-modal').hidden=false;
}

// ── Parameters ──────────────────────────────────────────────────────────────
const DEFAULTS=${jsonForInlineScript(PARAM_DEFAULTS)};
let current=${jsonForInlineScript(p)};
function baselineForPills(){
  try{
    const d=window.__paramsFull;
    if(d&&d.built_in&&typeof d.built_in==='object') return d.built_in;
  }catch{}
  return DEFAULTS;
}
function isParamNonDefault(key,val){
  const b=baselineForPills()[key];
  if(val===undefined||b===undefined)return false;
  if(typeof val==='number'&&typeof b==='number'){
    if(Number.isInteger(b)&&Number.isInteger(val))return val!==b;
    return Math.abs(val-b)>1e-5;
  }
  return val!==b;
}
function refreshParamOverrides(){
  for(const key of Object.keys(DEFAULTS)){
    const el=document.getElementById('p-'+key);
    const item=el&&el.closest('.param-item');
    const pill=document.getElementById('pill-'+key);
    if(!item)continue;
    const val=typeof current[key]==='number'?current[key]:Number(el&&el.value);
    const non=isParamNonDefault(key,val);
    item.classList.toggle('param--override',non);
    if(pill){
      pill.classList.toggle('custom',non);
      pill.classList.toggle('built-in',!non);
      pill.textContent=non?'Custom':'Default';
    }
  }
}

let genParamsSaveTimer=null;
function scheduleSaveParams(){
  if(genParamsSaveTimer)clearTimeout(genParamsSaveTimer);
  genParamsSaveTimer=setTimeout(()=>{genParamsSaveTimer=null;void saveParams();},550);
}
document.querySelectorAll('[id^="p-"]').forEach(el=>{
  const key=el.id.slice(2);
  const vEl=document.getElementById('v-'+key);
  el.addEventListener('input',()=>{
    const n=Number(el.value);
    if(vEl)vEl.textContent=n;
    current[key]=n;
    refreshParamOverrides();
    scheduleSaveParams();
  });
});

function applyValues(vals){
  for(const[key,val]of Object.entries(vals)){
    const inp=document.getElementById('p-'+key);
    const v=document.getElementById('v-'+key);
    if(inp){inp.value=val;} if(v){v.textContent=val;} current[key]=val;
  }
  refreshParamOverrides();
}
function applyMainSlidersFromParamsFull(d){
  if(!d||!d.effective||!d.param_keys)return;
  const o={};
  for(const k of d.param_keys){
    const v=d.effective[k];
    if(typeof v==='number'&&Number.isFinite(v)) o[k]=v;
  }
  applyValues(o);
}
async function syncGenerationSlidersFromServer(){
  try{
    const r=await fetchWithTimeout('/api/model-params-full',20000);
    if(!r.ok)return;
    const d=await r.json();
    window.__paramsFull=d;
    applyMainSlidersFromParamsFull(d);
    refreshParamOverrides();
  }catch{}
}
function saveParams(){
  return routerFetch('/api/model-params',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(current)})
    .then(async (r)=>{
      if(!r.ok){ await alertFailedSave(r,'Save generation'); return; }
      const m=document.getElementById('saved-msg'); if(m){m.style.opacity=1; setTimeout(()=>m.style.opacity=0,2200);}
      await syncGenerationSlidersFromServer();
      await refreshModel();
    });
}
/** Reset global generation sliders to built-in (generic defaults + model-family preset), clearing sparse global overrides. */
async function resetParams(){
  try{
    let bi=null;
    if(window.__paramsFull&&window.__paramsFull.built_in&&typeof window.__paramsFull.built_in==='object')
      bi=window.__paramsFull.built_in;
    else{
      const r=await fetchWithTimeout('/api/model-params-full',20000);
      if(r.ok){
        const d=await r.json();
        window.__paramsFull=d;
        bi=d.built_in;
      }
    }
    if(bi&&typeof bi==='object'){
      const o={};
      for(const k of Object.keys(DEFAULTS)){
        const v=bi[k];
        o[k]=typeof v==='number'&&Number.isFinite(v)?v:DEFAULTS[k];
      }
      applyValues(o);
      await saveParams();
      return;
    }
  }catch(e){ console.error(e); }
  applyValues(DEFAULTS);
  await saveParams();
}
try{ refreshParamOverrides(); }catch(e){ console.error(e); }
function toggleAdv(){
  const d=document.getElementById('params-adv'), t=document.getElementById('adv-toggle');
  const open=d.classList.toggle('open');
  t.textContent=open?'- Advanced':'+ Advanced';
}

// ── Routing log SSE ─────────────────────────────────────────────────────────
let lc=0,cc=0;
const MAX_FOOTER_LOG_LINES=400;
const FOOTER_MIN_H=130;
const FOOTER_MAX_RATIO=.7;
const FOOTER_COLLAPSED_H=46;
let footerCollapsed=false;
let footerExpandedHeight=260;
const seenFooterLogIds=new Set();
const seenFooterLogOrder=[];

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function footerAtBottom(el){
  if(!el)return true;
  const gap=el.scrollHeight-el.scrollTop-el.clientHeight;
  return gap<18;
}
function appendFooterLog(e){
  const out=document.getElementById('fixedLogOutput');
  if(!out||!e)return;
  document.getElementById('fixedLogEmpty')?.remove();
  const stick=footerAtBottom(out);
  const dest=(e.fallback?'fallback':(e.dest||'local')).toLowerCase();
  const label=dest==='cloud'?'CLOUD':(dest==='fallback'?'FALLBACK':'LOCAL');
  const line=document.createElement('div');
  line.className='fixed-log-line';
  const lm=(e.local_model||e.cloud_model)?(' \u2192 '+escHtml(e.local_model||e.cloud_model)):'';
  const msgRaw=e.reason!=null&&String(e.reason).trim()!==''?String(e.reason):(e.value!=null?String(e.value):'');
  line.innerHTML='['+escHtml(e.time||'--:--:--')+'] <span class="'+dest+'">'+label+'</span> - '+escHtml(msgRaw)+lm;
  out.appendChild(line);
  const prev=document.getElementById('fixedLogPreview');
  if(prev){
    const modelNote=e.local_model||e.cloud_model?(' \u2192 '+(e.local_model||e.cloud_model)):'';
    const snippet=('['+(e.time||'')+'] '+msgRaw+modelNote).trim();
    prev.textContent=snippet.length>140?snippet.slice(0,137)+'\u2026':snippet;
  }
  while(out.children.length>MAX_FOOTER_LOG_LINES){out.removeChild(out.firstChild);}
  const cnt=document.getElementById('fixedLogCount');
  if(cnt)cnt.textContent=String(out.children.length);
  if(stick)out.scrollTop=out.scrollHeight;
}

function clampFooterHeight(h){
  const max=Math.max(FOOTER_MIN_H+20,Math.floor(window.innerHeight*FOOTER_MAX_RATIO));
  return Math.max(FOOTER_MIN_H,Math.min(max,Math.floor(h)));
}

function updateFooterToggleBtn(){
  const b=document.getElementById('fixedLogToggleBtn'); if(!b)return;
  b.textContent=footerCollapsed?'Expand':'Collapse';
  b.title=footerCollapsed?'Expand footer':'Collapse footer';
}

function applyFooterLayout(persist=true){
  const f=document.getElementById('fixedLogFooter'); if(!f)return;
  if(footerCollapsed){
    f.classList.add('is-collapsed');
    f.style.height=String(FOOTER_COLLAPSED_H)+'px';
    document.body.style.paddingBottom=String(FOOTER_COLLAPSED_H+8)+'px';
  } else {
    f.classList.remove('is-collapsed');
    const h=clampFooterHeight(footerExpandedHeight);
    footerExpandedHeight=h;
    f.style.height=String(h)+'px';
    document.body.style.paddingBottom=String(h+16)+'px';
  }
  updateFooterToggleBtn();
  if(persist){
    try{
      localStorage.setItem('dashboardFooterCollapsed',footerCollapsed?'1':'0');
      localStorage.setItem('dashboardFooterHeightPx',String(footerExpandedHeight));
    }catch{}
  }
}

function toggleFooterCollapse(){
  footerCollapsed=!footerCollapsed;
  applyFooterLayout(true);
}

function setFooterHeight(h,persist=true){
  footerExpandedHeight=clampFooterHeight(h);
  if(!footerCollapsed)applyFooterLayout(persist);
  else if(persist){try{localStorage.setItem('dashboardFooterHeightPx',String(footerExpandedHeight));}catch{}}
}
/** Same resize + collapse pattern as router/public/header-ui.html (log-footer). */
function initFooterResizer(){
  const f=document.getElementById('fixedLogFooter');
  const h=document.getElementById('fixedLogResizer');
  const t=document.getElementById('fixedLogToggleBtn');
  if(!f||!h)return;
  try{
    const saved=parseInt(localStorage.getItem('dashboardFooterHeightPx')||'',10);
    if(Number.isFinite(saved))footerExpandedHeight=clampFooterHeight(saved);
    footerCollapsed=localStorage.getItem('dashboardFooterCollapsed')==='1';
  }catch{}
  applyFooterLayout(false);
  var lastViewportW=window.innerWidth, lastViewportH=window.innerHeight;
  if(t)t.addEventListener('click',toggleFooterCollapse);
  let dragging=false,startY=0,startH=0;
  const move=(y)=>{const d=startY-y; setFooterHeight(startH+d);};
  const stop=()=>{dragging=false;document.body.style.userSelect='';};
  h.addEventListener('mousedown',ev=>{dragging=true;startY=ev.clientY;startH=f.getBoundingClientRect().height;document.body.style.userSelect='none';});
  window.addEventListener('mousemove',ev=>{if(dragging)move(ev.clientY);});
  window.addEventListener('mouseup',stop);
  h.addEventListener('touchstart',ev=>{if(!ev.touches||!ev.touches.length)return;dragging=true;startY=ev.touches[0].clientY;startH=f.getBoundingClientRect().height;},{passive:true});
  window.addEventListener('touchmove',ev=>{if(dragging&&ev.touches&&ev.touches.length)move(ev.touches[0].clientY);},{passive:true});
  window.addEventListener('touchend',stop);
  var footerResizeRaf=0;
  window.addEventListener('resize',function(){
    if(footerResizeRaf)return;
    footerResizeRaf=requestAnimationFrame(function(){
      footerResizeRaf=0;
      try{
        var vw=window.innerWidth, vh=window.innerHeight;
        if(vw===lastViewportW&&vh===lastViewportH)return;
        lastViewportW=vw; lastViewportH=vh;
        if(footerCollapsed)applyFooterLayout(false);
        else setFooterHeight(f.getBoundingClientRect().height,false);
      }catch(_){}
    });
  });
}

function statEsc(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function addEntry(e){
  try{
    if(!e||typeof e!=='object')return;
    const entryId=e.id;
    if(entryId!=null){
      const key=String(entryId);
      if(seenFooterLogIds.has(key))return;
      seenFooterLogIds.add(key);
      seenFooterLogOrder.push(key);
      while(seenFooterLogOrder.length>MAX_FOOTER_LOG_LINES*3){
        const oldest=seenFooterLogOrder.shift();
        if(oldest!=null)seenFooterLogIds.delete(oldest);
      }
    }
    const rawDest=e.dest!=null&&String(e.dest).trim()!==''?String(e.dest).trim():'local';
    const destNorm=rawDest.toLowerCase()==='cloud'?'cloud':'local';
    if(!e.fallback){ if(destNorm==='local')lc++; else cc++; }
    const cntLocal=document.getElementById('cnt-local');
    const cntCloud=document.getElementById('cnt-cloud');
    const cntTotal=document.getElementById('cnt-total');
    if(cntLocal)cntLocal.textContent=lc;
    if(cntCloud)cntCloud.textContent=cc;
    if(cntTotal)cntTotal.textContent=lc+cc;
    appendFooterLog(e);
  }catch(_){}
}
var dashRefreshRunning=false;
var dashRefreshNeedFull=false;
function getPollIntervalSec(){
  try{
    const raw=document.body&&document.body.getAttribute('data-poll-interval');
    const n=parseInt(String(raw||'10'),10);
    return Number.isFinite(n)&&n>=3&&n<=120?n:10;
  }catch(_){ return 10; }
}
function initDashboardPollTicker(){
  let countdown=getPollIntervalSec();
  setInterval(function(){
    try{
      if(dashRefreshRunning){
        const np=document.getElementById('next-poll');
        if(np) np.textContent='\u2026';
        return;
      }
      countdown--;
      if(countdown<=0){
        countdown=getPollIntervalSec();
        Promise.resolve(runCoalescedDashboardRefresh(false)).catch(function(){});
      }
      const np=document.getElementById('next-poll');
      if(np) np.textContent=String(Math.max(0,countdown));
    }catch(_){}
  },1000);
}
/** Dedicated cadence for CPU/RAM/VRAM/GPU (1s UI tick; model poll stays on data-poll-interval). Server serializes CPU deltas; nvidia-smi cached ~5s so GPU/VRAM may repeat until cache expires. */
var SYSTEM_STATS_POLL_MS=1000;
function initSystemStatsPoller(){
  try{
    async function pollLoop(){
      try{ await refreshStats(); }catch(_){}
      setTimeout(function(){ void pollLoop(); }, SYSTEM_STATS_POLL_MS);
    }
    void pollLoop();
  }catch(_){}
}
function hydrateLogEntriesBatched(raw){
  try{
    var list=Array.isArray(raw)?raw:[];
    var i=0, CHUNK=25;
    function step(){
      var end=Math.min(i+CHUNK,list.length);
      for(;i<end;i++){ try{ addEntry(list[i]); }catch(_){} }
      if(i<list.length) requestAnimationFrame(step);
    }
    if(list.length) requestAnimationFrame(step);
  }catch(_){}
}
async function hydrateFooterLogsFromApi(){
  try{
    var logsUrl=(function(){try{return new URL('/api/logs',window.location.href).href;}catch(_){return '/api/logs';}})();
    const r=await fetchWithTimeout(logsUrl,12000);
    if(!r.ok)throw new Error('logs HTTP '+r.status);
    const j=await r.json();
    hydrateLogEntriesBatched(j&&Array.isArray(j.logs)?j.logs:[]);
  }catch(_){
    var out=document.getElementById('fixedLogOutput');
    var empty=document.getElementById('fixedLogEmpty');
    if(out&&empty&&out.querySelectorAll('.fixed-log-line').length===0){
      empty.textContent='Cannot reach /api/logs from this page. Open the dashboard at the same URL as ANTHROPIC_BASE_URL (e.g. http://127.0.0.1:8082/). If the log panel is collapsed, click Expand — or check the router terminal for [HH:MM:SS] lines.';
    }
  }
}
initDashboardPollTicker();
initSystemStatsPoller();
try{ hydrateLogEntriesBatched((${jsonForInlineScript(log)}||[])); }catch(_){}
void hydrateFooterLogsFromApi();
var sseUrl=(function(){try{return new URL('/events',window.location.href).href;}catch(_){return '/events';}})();
const es=new EventSource(sseUrl);
es.onmessage=function(ev){
  try{
    addEntry(JSON.parse(ev.data));
  }catch(_){}
};
es.onerror=function(){ const el=document.getElementById('rdot'); if(el) el.className='rdot err'; };
es.onopen=function(){ const el=document.getElementById('rdot'); if(el&&el.classList.contains('err')) el.className='rdot'; };
async function refreshRouteStats(){
  try{
    const r=await fetchWithTimeout('/api/stats',12000);
    if(!r.ok)return;
    const j=await r.json();
    if(j.config&&j.config.routing_mode!=null)applyRoutingModeButton(j.config.routing_mode,j.cloud_quota);
    const lr=j.last_route;
    const bar=document.getElementById('last-route-bar');
    const tx=document.getElementById('last-route-text');
    if(tx){
      if(lr&&lr.dest){
        const fb=lr.fallback;
        if(bar){bar.className='last-route-bar '+(fb?'fallback':(lr.dest==='cloud'?'cloud':'local'));}
        const dest=fb?('FALLBACK\u2192'+String(lr.dest).toUpperCase()):String(lr.dest).toUpperCase();
        const modeLabel=routingModeLabelFor(routingMode);
        if(bar){
          bar.title=[dest,modeLabel,lr.reason||'',lr.model||'',lr.time||''].filter(Boolean).join(' \u00b7 ');
        }
        tx.innerHTML='<span class="lr-dest">'+dest+'</span> \u00b7 '+statEsc(modeLabel)+(lr.time?(' \u00b7 <span style="opacity:.78">'+statEsc(lr.time)+'</span>'):'');
      } else {
        if(bar){
          bar.className='last-route-bar local';
          bar.title='No recent route yet';
        }
        tx.textContent='Awaiting route';
      }
    }
  }catch{}
}

var DASH_REFRESH_BUDGET_MS=52000;
async function doRefresh(syncGenerationSliders){
  const run=async function(){
    if(syncGenerationSliders) void refreshStats();
    await Promise.allSettled([refreshHealth(), refreshRouteStats()]);
    await Promise.allSettled([refreshModel(), refreshOllamaModelList()]);
    if(syncGenerationSliders) await syncGenerationSlidersFromServer();
  };
  try{
    await Promise.race([
      run(),
      new Promise(function(_,rej){
        setTimeout(function(){ rej(Object.assign(new Error('dashboard_refresh_timeout'),{name:'DashboardRefreshTimeout'})); },DASH_REFRESH_BUDGET_MS);
      }),
    ]);
  }catch(e){
    if(e&&e.name==='DashboardRefreshTimeout') console.warn('ClaudeLlama: dashboard refresh timed out; UI stays usable.');
    else console.error(e);
  }
}
var dashRefreshTailPasses=0;
async function runCoalescedDashboardRefresh(forceFull){
  if(forceFull) dashRefreshNeedFull=true;
  if(dashRefreshRunning) return;
  dashRefreshRunning=true;
  try{
    while(true){
      const full=dashRefreshNeedFull;
      dashRefreshNeedFull=false;
      await doRefresh(full);
      if(!dashRefreshNeedFull) break;
    }
    dashRefreshTailPasses=0;
  }catch(e){
    console.error(e);
  }finally{
    dashRefreshRunning=false;
    if(dashRefreshNeedFull){
      if(dashRefreshTailPasses<8){
        dashRefreshTailPasses++;
        Promise.resolve().then(function(){ void runCoalescedDashboardRefresh(false); });
      }else{
        dashRefreshNeedFull=false;
        dashRefreshTailPasses=0;
        console.warn('ClaudeLlama: stopped chained dashboard refresh (safety cap).');
      }
    }
  }
}
void refreshHealth();
function scheduleDashboardBootstrap(){
  var go=function(){
    void (async function(){
      try{ await runCoalescedDashboardRefresh(true); }
      catch(e){ console.error(e); void refreshHealth(); }
    })();
  };
  if(typeof requestAnimationFrame==='function'){
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ setTimeout(go,0); }); });
  }else{
    setTimeout(go,0);
  }
}
scheduleDashboardBootstrap();
initFooterResizer();

document.querySelectorAll('[id^="routing-mode-btn-"][data-mode]')?.forEach(function(btn){
  btn.addEventListener('click',async function(){
    var next=String(btn.getAttribute('data-mode')||'').trim().toLowerCase();
    if(!next||next===routingMode||btn.disabled)return;
    try{
      var r=await routerFetch('/api/router/routing-mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:next})});
      if(!r.ok){
        try{var j=await r.json();alert(j.error||j.hint||('HTTP '+r.status));}catch{alert('HTTP '+r.status);}
        return;
      }
      var d=await r.json();
      if(d&&d.mode)applyRoutingModeButton(d.mode,cloudQuotaUiState);
    }catch{alert('Could not change routing mode');}
  });
});

document.getElementById('local-model-select')?.addEventListener('change',async (e)=>{
  const v=e.target.value;
  if(!v)return;
  try{
    const r=await routerFetch('/api/local-model',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:v})});
    if(!r.ok){
      try{const j=await r.json();alert(j.error||j.hint||('HTTP '+r.status));}catch{alert('HTTP '+r.status);}
      await refreshOllamaModelList();
      return;
    }
    await refreshModel();
    await refreshOllamaModelList();
    await syncGenerationSlidersFromServer();
  }catch{
    await refreshOllamaModelList();
  }
});

let persistRoutingTimer=null;
function schedulePersistRoutingSettings(){
  if(persistRoutingTimer)clearTimeout(persistRoutingTimer);
  persistRoutingTimer=setTimeout(()=>{persistRoutingTimer=null;void persistRoutingSettingsNow();},400);
}
async function persistRoutingSettingsNow(){
  const cb=document.getElementById('smart-routing-cb');
  const ps=document.getElementById('local-pool-select');
  const fs=document.getElementById('fast-model-select');
  const smart=cb?!!cb.checked:true;
  const models=ps?Array.from(ps.selectedOptions).map(o=>o.value):[];
  const fast_model=fs?String(fs.value||'').trim():'';
  try{
    const r=await routerFetch('/api/router/local-routing-config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({smart_routing:smart,models,fast_model})});
    const msg=document.getElementById('pool-save-msg');
    if(!r.ok){
      try{const j=await r.json();alert(j.error||('HTTP '+r.status+' (admin token may be required)'));}catch{alert('HTTP '+r.status);}
      return;
    }
    if(msg){msg.style.opacity=1;setTimeout(()=>{msg.style.opacity=0;},1800);}
    await refreshOllamaModelList();
    await refreshRouteStats();
  }catch{
    alert('Routing save failed');
  }
}
document.getElementById('pool-chips-root')?.addEventListener('change',(e)=>{
  const t=e.target;
  if(t&&t.matches&&t.matches('input[type=checkbox]')) schedulePersistRoutingSettings();
});
document.getElementById('smart-routing-cb')?.addEventListener('change',()=>schedulePersistRoutingSettings());
document.getElementById('fast-model-select')?.addEventListener('change',()=>schedulePersistRoutingSettings());

document.getElementById('settings-modal-close')?.addEventListener('click',closeSettingsModal);
document.getElementById('settings-modal')?.addEventListener('click',e=>{ if(e.target&&e.target.id==='settings-modal')closeSettingsModal(); });
document.getElementById('params-files-modal-close')?.addEventListener('click',closeParamsFilesModal);
document.getElementById('params-files-modal')?.addEventListener('click',e=>{ if(e.target&&e.target.id==='params-files-modal')closeParamsFilesModal(); });
document.getElementById('tab-params-global')?.addEventListener('click',()=>switchParamsFilesTab('global'));
document.getElementById('tab-params-per')?.addEventListener('click',()=>switchParamsFilesTab('per-model'));
document.getElementById('params-files-reload')?.addEventListener('click',()=>{ void reloadParamsFilesActive(); });
document.getElementById('params-files-save')?.addEventListener('click',()=>{ void saveParamsFilesActive(); });
document.getElementById('save-global-settings-btn')?.addEventListener('click',()=>{ void saveGlobalFromSettingsModal(); });
document.getElementById('save-per-model-btn')?.addEventListener('click',()=>savePerModelOverrides());
document.getElementById('clear-per-model-btn')?.addEventListener('click',()=>clearPerModelOverrides());
document.getElementById('model-info-close')?.addEventListener('click',closeModelInfoModal);
document.getElementById('model-info-modal')?.addEventListener('click',e=>{ if(e.target&&e.target.id==='model-info-modal')closeModelInfoModal(); });
document.getElementById('info-toggle-raw')?.addEventListener('click',()=>{
  const pre=document.getElementById('model-info-pre');
  const btn=document.getElementById('info-toggle-raw');
  if(!pre||!btn)return;
  infoRawVisible=!infoRawVisible;
  pre.hidden=!infoRawVisible;
  pre.textContent=JSON.stringify(window.__lastModelDetails||{},null,2);
  btn.textContent=infoRawVisible?'Hide raw JSON':'Show raw JSON';
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeModelInfoModal(); closeSettingsModal(); closeParamsFilesModal(); } });
</script>
</body>
</html>`;
}

// ─── Main server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const reqPath = pathOnly(req.url);

  if (req.method === "GET" && reqPath === "/assets/dashboard-extra.css") {
    const cssPath = path.join(CFG.resourcesDir, "dashboard-extra.css");
    if (!fs.existsSync(cssPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(fs.readFileSync(cssPath, "utf8"));
    } catch {
      res.writeHead(500).end();
    }
    return;
  }

  if (
    req.method === "GET" &&
    reqPath === "/assets/ollama-dashboard-model-card.css"
  ) {
    const cssPath = path.join(
      CFG.resourcesDir,
      "ollama-dashboard-model-card.css",
    );
    if (!fs.existsSync(cssPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(fs.readFileSync(cssPath, "utf8"));
    } catch {
      res.writeHead(500).end();
    }
    return;
  }

  if (req.method === "GET" && reqPath === "/assets/ollama-logo.png") {
    const logoPath = CFG.ollamaLogoCandidates.find((p) => fs.existsSync(p));
    if (!logoPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "logo not found" }));
      return;
    }
    try {
      const data = fs.readFileSync(logoPath);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      });
      res.end(data);
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "logo read failed" }));
    }
    return;
  }

  if (
    req.method === "GET" &&
    (reqPath === "/assets/claude-code-icon.svg" ||
      reqPath === "/assets/claude-icon.svg")
  ) {
    const iconPath = path.join(__dirname, "public", "claude-code-icon.svg");
    if (!fs.existsSync(iconPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      const data = fs.readFileSync(iconPath);
      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(data);
    } catch {
      res.writeHead(500).end();
    }
    return;
  }

  if (req.method === "GET" && reqPath === "/header-ui") {
    try {
      const uiPath = path.join(__dirname, "public", "header-ui.html");
      const html = fs.readFileSync(uiPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "header ui unavailable" }));
    }
    return;
  }

  if (req.method === "GET" && (reqPath === "/" || reqPath === "")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHTML(CFG));
    return;
  }

  if (req.method === "GET" && reqPath === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write("\n");
    for (const entry of log) {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {}
    }
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && reqPath === "/api/logs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs: log }));
    return;
  }

  if (req.method === "GET" && reqPath === "/api/stats") {
    const counters = metrics.snapshot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        counters,
        last_route: metrics.getLastRoute(),
        cloud_quota: getCloudQuotaState(),
        config: {
          listenHost: CFG.listenHost,
          port: CFG.port,
          time_zone: CFG.display.time_zone,
          local_model: CFG.local.model,
          fast_model: CFG.local.fast_model || undefined,
          local_models_pool: CFG.local.models,
          smart_routing: CFG.local.smart_routing,
          tokenThreshold: CFG.routing.tokenThreshold,
          fileReadThreshold: CFG.routing.fileReadThreshold,
          keywordCount: CFG.routing.keywords.length,
          routing_keywords: CFG.routing.keywords,
          routing_mode: normalizeRoutingMode(CFG.routing.mode),
          privacy_cloud_redaction: {
            enabled: !!CFG.privacy.cloud_redaction.enabled,
            redact_tool_results:
              !!CFG.privacy.cloud_redaction.redact_tool_results,
            redact_identifiers:
              !!CFG.privacy.cloud_redaction.redact_identifiers,
            custom_terms_count: Array.isArray(
              CFG.privacy.cloud_redaction.custom_terms,
            )
              ? CFG.privacy.cloud_redaction.custom_terms.length
              : 0,
          },
          privacy_project_obfuscation: {
            enabled: !!(CFG.privacy.project_obfuscation || {}).enabled,
            auto_detect_filenames: !!(CFG.privacy.project_obfuscation || {})
              .auto_detect_filenames,
            auto_detect_identifiers: !!(CFG.privacy.project_obfuscation || {})
              .auto_detect_identifiers,
            alias_prefix: (CFG.privacy.project_obfuscation || {}).alias_prefix || "proj",
            project_terms_count: Array.isArray(
              (CFG.privacy.project_obfuscation || {}).project_terms,
            )
              ? CFG.privacy.project_obfuscation.project_terms.length
              : 0,
          },
          cascade_quality: !!CFG.local.cascadeQuality,
          always_local_terms_count: (CFG.routing.alwaysLocalTerms || []).length,
          force_local_if_privacy_terms: !!CFG.routing.forceLocalIfPrivacyTerms,
          privacy_custom_terms_count: (CFG.routing.privacyCustomTerms || []).length,
        },
      }),
    );
    return;
  }

  if (req.method === "GET" && reqPath === "/api/router/routing-mode") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mode: normalizeRoutingMode(CFG.routing.mode) }));
    return;
  }

  if (req.method === "POST" && reqPath === "/api/router/routing-mode") {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const requested = normalizeRoutingMode(body.mode);
      if (getCloudQuotaState().exceeded && requested !== "local") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: "cloud quotas exceeded",
            hint: "Claude and Hybrid are temporarily disabled while the cloud quota is exceeded.",
          }),
        );
        return;
      }
      const next = saveRoutingMode(routerDir, requested);
      CFG.routing.mode = next;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: next }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid body" }));
    }
    return;
  }

  if (req.method === "GET" && reqPath === "/api/ollama-models") {
    try {
      const tags = await ollamaGet("/api/tags");
      const ps = await ollamaGetPsWithRetry();
      let models = normalizeOllamaTagList(tags);
      if (tags !== null && models.length > 0) {
        models = await enrichModelListWithContextCap(models);
      }
      const loaded_models = listPsModels(ps)
        .map((row) => psModelId(row))
        .filter(Boolean);
      const installedNames = models.map((m) => m.name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models,
          loaded_models,
          configured_model: CFG.local.model,
          ollama_reachable: tags !== null,
          pool: resolveLocalPool(CFG, installedNames),
          smart_routing: CFG.local.smart_routing,
        }),
      );
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: [],
          loaded_models: [],
          configured_model: CFG.local.model,
          ollama_reachable: false,
          pool: [],
          smart_routing: CFG.local.smart_routing,
          error: e && e.message ? String(e.message) : "ollama_models_failed",
        }),
      );
    }
    return;
  }

  if (req.method === "GET" && reqPath === "/api/router/local-routing-config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: CFG.local.model,
        models: CFG.local.models,
        smart_routing: CFG.local.smart_routing,
        fast_model: CFG.local.fast_model || "",
      }),
    );
    return;
  }

  if (req.method === "POST" && reqPath === "/api/router/local-routing-config") {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      saveLocalRoutingSettings(routerDir, {
        models: Array.isArray(body.models) ? body.models : undefined,
        smart_routing:
          typeof body.smart_routing === "boolean"
            ? body.smart_routing
            : undefined,
        fast_model:
          typeof body.fast_model === "string" ? body.fast_model : undefined,
      });
      loadAndApply(CFG, routerDir);
      normalizeLocalCfg();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          model: CFG.local.model,
          models: CFG.local.models,
          smart_routing: CFG.local.smart_routing,
          fast_model: CFG.local.fast_model || "",
        }),
      );
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  if (req.method === "GET" && reqPath === "/api/health") {
    const HEALTH_BUDGET_MS = 3500;
    let body;
    try {
      body = await Promise.race([
        (async () => {
          const [ps, ver] = await Promise.all([
            ollamaGetPsWithRetry(),
            getOllamaVersion(),
          ]);
          const healthy = ps !== null;
          return {
            status: healthy ? "healthy" : "degraded",
            ollama_version: ver,
            uptime_seconds: healthy ? Math.floor(process.uptime()) : 0,
            ollama_host: CFG.local.host,
            ollama_port: CFG.local.port,
            router_listen: `${CFG.listenHost}:${CFG.port}`,
          };
        })(),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error("health_timeout")),
            HEALTH_BUDGET_MS,
          );
        }),
      ]);
    } catch {
      body = {
        status: "degraded",
        ollama_version: ollamaVersionCache,
        uptime_seconds: Math.floor(process.uptime()),
        ollama_host: CFG.local.host,
        ollama_port: CFG.local.port,
        router_listen: `${CFG.listenHost}:${CFG.port}`,
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === "GET" && reqPath === "/api/system-stats") {
    try {
      const cpu = await sampleCpuPercent();
      const rawRam = 1 - os.freemem() / os.totalmem();
      const ram = Number.isFinite(rawRam) ? Math.round(rawRam * 100) : null;
      const nv = await Promise.race([
        getNvidiaSmi().catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 5000)),
      ]);
      const vramPct =
        nv && nv.vram_total_mb > 0
          ? Math.round((nv.vram_used_mb / nv.vram_total_mb) * 100)
          : null;
      const gpuPct =
        nv && Number.isFinite(nv.gpu_util) ? Math.round(nv.gpu_util) : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          cpu: Number.isFinite(cpu) ? cpu : null,
          ram,
          vram: vramPct,
          gpu: gpuPct,
          vram_used_gb: nv ? (nv.vram_used_mb / 1024).toFixed(1) : null,
          vram_total_gb: nv ? (nv.vram_total_mb / 1024).toFixed(1) : null,
        }),
      );
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          cpu: null,
          ram: null,
          vram: null,
          gpu: null,
          vram_used_gb: null,
          vram_total_gb: null,
          error: e && e.message ? String(e.message) : "system_stats_failed",
        }),
      );
    }
    return;
  }

  if (req.method === "GET" && reqPath === "/api/model-status") {
    const ps = await ollamaGetPsWithRetry();
    const psRows = listPsModels(ps);
    const running = pickRunningModel(ps, CFG.local.model);
    const showName = running ? psModelId(running) : CFG.local.model;
    const show = await ollamaPost("/api/show", { model: showName });
    const context_max = maxContextFromShow(show);
    const context_allocated = contextAllocatedFromPsRow(running);
    const modelPayload = running
      ? (() => {
          const m = mergeModelDetailsFromShow(running, show);
          return {
            ...m,
            details: enrichDetailsFromModelInfo(m.details || {}, show),
          };
        })()
      : null;
    const card_specs = buildCardSpecs(show, running);
    const loaded_list = [];
    for (const row of psRows) {
      const nm = psModelId(row);
      if (!nm) continue;
      const rowShow =
        nm === showName ? show : await ollamaPost("/api/show", { model: nm });
      const rowSpecs = buildCardSpecs(rowShow, row);
      const rowCaps = capabilityFlagsFromShow(rowShow);
      loaded_list.push({
        name: nm,
        model: String(row.model || row.name || "").trim(),
        size: toFiniteNumberLoose(row.size),
        size_vram: toFiniteNumberLoose(row.size_vram),
        digest: row.digest != null ? String(row.digest) : null,
        card_specs: rowSpecs,
        capabilities: rowCaps,
        context_max: maxContextFromShow(rowShow),
        context_allocated: contextAllocatedFromPsRow(row),
        request_num_ctx: effectiveParamsFor(nm).num_ctx,
      });
    }
    const tags = await ollamaGet("/api/tags");
    const installedModels = normalizeOllamaTagList(tags);
    const installedByName = new Map(installedModels.map((m) => [m.name, m]));
    const installedNames = installedModels.map((m) => m.name);
    const pool = resolveLocalPool(CFG, installedNames);
    const loadedNames = new Set(loaded_list.map((r) => r.name));
    const pool_models = [];
    for (const name of pool) {
      if (loadedNames.has(name)) continue;
      const tagMeta = installedByName.get(name) || { name, size: null };
      const poolShow =
        name === showName
          ? show
          : await ollamaPost("/api/show", { model: name });
      const poolSpecs = buildCardSpecs(poolShow, {
        model: name,
        name,
        size: tagMeta.size,
        size_vram: null,
        details: poolShow && poolShow.details ? poolShow.details : {},
      });
      pool_models.push({
        name,
        size: toFiniteNumberLoose(tagMeta.size),
        card_specs: poolSpecs,
        capabilities: capabilityFlagsFromShow(poolShow),
        context_max: maxContextFromShow(poolShow),
        request_num_ctx: effectiveParamsFor(name).num_ctx,
        is_default: name === CFG.local.model,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    const effModel = running ? psModelId(running) : CFG.local.model;
    const eff = effectiveParamsFor(effModel);
    const configured_loaded = !!running;
    res.end(
      JSON.stringify({
        loaded: configured_loaded,
        configured_loaded,
        configured_model: CFG.local.model,
        active_model: effModel,
        loaded_list,
        pool_models,
        model: modelPayload,
        card_specs,
        context_max,
        context_allocated,
        request_num_ctx: eff.num_ctx,
        capabilities: capabilityFlagsFromShow(show),
      }),
    );
    return;
  }

  if (req.method === "GET" && reqPath === "/api/model-params-full") {
    let requestedModel = "";
    const q = req.url.indexOf("?");
    if (q !== -1) {
      const sp = new URLSearchParams(req.url.slice(q + 1));
      requestedModel = String(sp.get("model") || "").trim();
    }
    const ps = await ollamaGetPsWithRetry();
    const running = pickRunningModel(ps, CFG.local.model);
    const activeModel =
      requestedModel || (running ? psModelId(running) : CFG.local.model);
    const patch = getPartialOverride(activeModel);
    const effective = effectiveParamsFor(activeModel);
    const builtIn = builtInParamsForModel(activeModel);
    const loaded = !!listPsModels(ps).find(
      (row) => psModelId(row) === activeModel,
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        built_in: builtIn,
        preset_patch: matchPresetPatch(activeModel),
        global: globalLayerMerged(activeModel),
        global_sparse: modelParams,
        active_model: activeModel,
        loaded,
        per_model_patch: patch,
        effective,
        param_keys: Object.keys(PARAM_DEFAULTS),
      }),
    );
    return;
  }

  if (req.method === "GET" && reqPath === "/api/router/model-details") {
    let modelName = CFG.local.model;
    const q = req.url.indexOf("?");
    if (q !== -1) {
      const sp = new URLSearchParams(req.url.slice(q + 1));
      const m = sp.get("model");
      if (m) modelName = m;
    }
    const show = await ollamaPost("/api/show", { model: modelName });
    const eff = effectiveParamsFor(modelName);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: modelName,
        summary: summarizeShow(show),
        show,
        global_options: globalLayerMerged(modelName),
        per_model_patch: getPartialOverride(modelName),
        router_request_options: eff,
      }),
    );
    return;
  }

  if (req.method === "POST" && reqPath === "/api/local-model") {
    if (!requireAdmin(req, res)) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid json" }));
      return;
    }
    const name = body.model;
    if (!name || typeof name !== "string" || !String(name).trim()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "model name required" }));
      return;
    }
    saveLocalModel(routerDir, name.trim());
    loadAndApply(CFG, routerDir);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: CFG.local.model }));
    return;
  }

  if (req.method === "POST" && reqPath === "/api/router/model/stop") {
    if (!requireAdmin(req, res)) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      body = {};
    }
    const ps = await ollamaGetPsWithRetry();
    const explicit = body.model && String(body.model).trim();
    const matched = pickRunningModel(ps, CFG.local.model);
    const fallback = matched || firstLoadedPsRow(ps);
    const name =
      explicit || (fallback && psModelId(fallback)) || CFG.local.model;
    await ollamaTouchModel(name, 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: name }));
    return;
  }

  if (req.method === "POST" && reqPath === "/api/router/model/start") {
    if (!requireAdmin(req, res)) return;
    const name = CFG.local.model;
    await ollamaTouchModel(name, -1);
    lastLocalActivityMs = Date.now();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: name }));
    return;
  }

  if (req.method === "POST" && reqPath === "/api/router/model/restart") {
    if (!requireAdmin(req, res)) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      body = {};
    }
    const explicit = body.model && String(body.model).trim();
    const target = explicit || CFG.local.model;
    const ps = await ollamaGetPsWithRetry();
    const matched = pickRunningModel(ps, target);
    const row = matched || firstLoadedPsRow(ps);
    if (row) {
      await ollamaTouchModel(psModelId(row), 0);
      await new Promise((r) => setTimeout(r, 800));
    }
    await ollamaTouchModel(target, -1);
    lastLocalActivityMs = Date.now();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: target }));
    return;
  }

  if (req.method === "GET" && reqPath === "/api/model-params") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(globalLayerMerged(CFG.local.model)));
    return;
  }

  if (req.method === "POST" && reqPath === "/api/model-params") {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const forModel =
        typeof body._for_model === "string" && body._for_model.trim()
          ? body._for_model.trim()
          : CFG.local.model;
      const { _for_model, ...rest } = body;
      modelParams = sparseGlobalFromFullState(rest, forModel);
      saveParams();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400).end("{}");
    }
    return;
  }

  if (req.method === "POST" && reqPath === "/api/model-params-per-model") {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse((await readBody(req)).toString());
      const model = body.model;
      if (!model || typeof model !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "model required" }));
        return;
      }
      const overrides = body.overrides;
      if (
        overrides !== undefined &&
        overrides !== null &&
        (typeof overrides !== "object" || Array.isArray(overrides))
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "overrides must be an object" }),
        );
        return;
      }
      const k = normModelKey(model);
      if (
        !overrides ||
        typeof overrides !== "object" ||
        Object.keys(overrides).length === 0
      ) {
        delete perModelParams[k];
      } else {
        const clean = {};
        for (const key of Object.keys(PARAM_DEFAULTS)) {
          if (Object.prototype.hasOwnProperty.call(overrides, key)) {
            const v = overrides[key];
            if (typeof v === "number" && Number.isFinite(v)) clean[key] = v;
          }
        }
        perModelParams[k] = clean;
      }
      savePerModelParams();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  if (req.method === "GET" && reqPath === "/api/router/model-params-raw") {
    let which = "global";
    const q = req.url.indexOf("?");
    if (q !== -1) {
      const sp = new URLSearchParams(req.url.slice(q + 1));
      if (sp.get("which") === "per-model") which = "per-model";
    }
    const pathRel =
      which === "per-model"
        ? ".claude/model-params-per-model.json"
        : ".claude/model-params.json";
    const content = readModelParamsFileRaw(which);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ which, path: pathRel, content }));
    return;
  }

  if (req.method === "POST" && reqPath === "/api/router/model-params-raw") {
    if (!requireAdmin(req, res)) return;
    try {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      const which = body.which === "per-model" ? "per-model" : "global";
      if (typeof body.content !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "content must be a string" }),
        );
        return;
      }
      const parsed = JSON.parse(body.content);
      if (which === "global") {
        modelParams = cleanGlobalParamsFromJson(parsed);
        saveParams();
      } else {
        perModelParams = cleanPerModelFileFromJson(parsed);
        savePerModelParams();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error:
            e && e.message ? String(e.message) : "invalid json or save failed",
        }),
      );
    }
    return;
  }

  // Ollama service control (Windows host only; no-op in Docker/Linux)
  if (req.method === "POST" && reqPath.startsWith("/api/service/")) {
    if (!requireAdmin(req, res)) return;
    if (process.platform !== "win32") {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: "unsupported_platform",
          message:
            "Ollama start/stop/restart via the dashboard is only supported on Windows. In Docker or Linux, manage Ollama with your container runtime or supervisor.",
        }),
      );
      return;
    }
    const action = reqPath.split("/").pop();
    const cmds = {
      start:
        'powershell -Command "Start-Process ollama -ArgumentList serve -WindowStyle Hidden"',
      stop: "taskkill /F /IM ollama.exe /T",
      restart:
        'taskkill /F /IM ollama.exe /T & timeout /t 2 /nobreak >nul & powershell -Command "Start-Process ollama -ArgumentList serve -WindowStyle Hidden"',
    };
    if (!cmds[action]) {
      res.writeHead(400).end("{}");
      return;
    }
    ollamaVersionCache = null; // reset so version re-fetches after restart
    exec(cmds[action], { timeout: 10000 }, (err) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !err, error: err?.message }));
    });
    return;
  }

  if (reqPath.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
    return;
  }

  if (!reqPath.includes("/messages")) {
    res.writeHead(404).end("{}");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let rawBody, body;
  try {
    rawBody = await readBody(req);
    body = JSON.parse(rawBody.toString());
  } catch {
    res.writeHead(400).end(JSON.stringify({ error: "invalid json" }));
    return;
  }

  metrics.bumpRequest();
  const mode = normalizeRoutingMode(CFG.routing.mode);
  const cloudQuota = getCloudQuotaState();
  let routeResult;
  if (cloudQuota.exceeded && mode !== "local") {
    routeResult = {
      dest: "local",
      reason: `cloud quota exceeded${cloudQuota.message ? " · " + cloudQuota.message : ""}`,
    };
  } else if (mode === "cloud") {
    routeResult = { dest: "cloud", reason: "routing mode: Claude only" };
  } else if (mode === "local") {
    routeResult = { dest: "local", reason: "routing mode: Ollama only" };
  } else {
    routeResult = analyzeMessages(body, {
      ...CFG.routing,
      effectiveNumCtx: effectiveParamsFor(CFG.local.model).num_ctx,
      alwaysLocalTerms: CFG.routing.alwaysLocalTerms || [],
      forceLocalIfPrivacyTerms: !!CFG.routing.forceLocalIfPrivacyTerms,
      privacyCustomTerms: CFG.routing.privacyCustomTerms || [],
    });
  }
  if (routeResult.dest === "cloud") {
    routeTo("cloud", routeResult.reason, false, { cloud_model: body.model });
    proxyCloud(req, rawBody, body, res);
  } else {
    proxyLocal(req, body, res, rawBody, routeResult);
  }
});

async function ensureAutoDefaultModelsFromOllama() {
  try {
    if (
      process.env.ROUTER_SKIP_AUTO_DEFAULT_MODELS === "1" ||
      /^true$/i.test(String(process.env.ROUTER_SKIP_AUTO_DEFAULT_MODELS || ""))
    ) {
      return;
    }
    const needModel = localModelUnsetInConfigFile(routerDir);
    const needFast = localFastUnsetInConfigFile(routerDir);
    if (!needModel && !needFast) return;

    const tagsBody = await ollamaGet("/api/tags");
    const models = normalizeOllamaTagList(tagsBody);
    if (!models.length) {
      if (needModel) {
        console.warn(
          "[hybrid-config] auto-default skipped: no Ollama tags (start Ollama or run ollama pull)",
        );
      }
      return;
    }

    const fixedPrimary = needModel
      ? null
      : String(CFG.local.model || "").trim();
    const { primary, fast } = pickAutoDefaultModels(models, {
      fixedPrimary: fixedPrimary || null,
    });

    if (needModel && primary) {
      saveLocalModel(routerDir, primary);
      CFG.local.model = primary;
      console.log(`[hybrid-config] auto-set local.model → ${primary}`);
    }

    if (needFast && fast) {
      const p = String(CFG.local.model || "").trim();
      if (p && fast.toLowerCase() !== p.toLowerCase()) {
        saveLocalRoutingSettings(routerDir, { fast_model: fast });
        CFG.local.fast_model = fast;
        console.log(`[hybrid-config] auto-set local.fast_model → ${fast}`);
      }
    }
    normalizeLocalCfg();
  } catch (e) {
    console.warn(
      "[hybrid-config] auto-default models:",
      e && e.message ? e.message : e,
    );
  }
}

/**
 * Startup sanity check: warn (console + dashboard log) when CFG.local.model does not match
 * anything in Ollama /api/tags. Hybrid mode falls back to cloud automatically; local-only
 * mode would fail every request. Either way the user should know before the first turn.
 */
async function validateLocalModelAgainstOllama() {
  const configured = String(CFG.local.model || "").trim();
  if (!configured) return;
  try {
    const tagsBody = await ollamaGet("/api/tags");
    const installed = normalizeOllamaTagList(tagsBody);
    if (!installed.length) return; // Ollama has no models yet; skip
    const found = installed.some((m) => modelNamesMatch(configured, m.name));
    if (!found) {
      const names = installed.map((m) => m.name).join(", ");
      const hint =
        normalizeRoutingMode(CFG.routing && CFG.routing.mode) === "local"
          ? "Local-only mode is set — every request will fail until this is fixed."
          : "Hybrid mode will fall back to cloud for local turns.";
      const msg =
        `local.model "${configured}" is not installed in Ollama` +
        ` (installed: ${names || "none"}). ${hint}` +
        ` Fix: ollama pull ${configured}  OR set a different model in hybrid.config.json.`;
      console.warn(`[hybrid-config] WARNING: ${msg}`);
      pushLog({
        time: ts(),
        dest: "local",
        reason: `⚠ Model mismatch — ${msg}`,
        fallback: true,
      });
    }
  } catch {
    // Ollama unreachable at startup — handled elsewhere; skip silently
  }
}

async function startListening() {
  const cfgExistedBefore = fs.existsSync(configPath(routerDir));
  await ensureAutoDefaultModelsFromOllama();
  // If auto-default just created hybrid.config.json, register the file watcher now
  // (watchConfig at startup silently skipped because the file didn't exist yet).
  if (!cfgExistedBefore && fs.existsSync(configPath(routerDir))) {
    watchConfig(routerDir, onConfigReload);
  }
  await validateLocalModelAgainstOllama();
  server.listen(CFG.port, CFG.listenHost, () => {
    console.log("");
    console.log("  ClaudeLlama Router");
    console.log("  -----------------------------------------");
    console.log(`  Dashboard  -> http://${CFG.listenHost}:${CFG.port}`);
    console.log(
      `  Bind       -> ${CFG.listenHost}:${CFG.port}  (ROUTER_HOST=0.0.0.0 for LAN)`,
    );
    console.log(
      `  Local      -> http://${CFG.local.host}:${CFG.local.port}  (${CFG.local.model || "no model set"})`,
    );
    console.log(
      `  Cloud      -> ${CFG.cloud.protocol}://${CFG.cloud.host}:${CFG.cloud.port}  (model from request)`,
    );
    if (getAdminToken())
      console.log(
        "  Admin      -> ROUTER_ADMIN_TOKEN set (mutating /api/* require header)",
      );
    console.log(
      PROXY_SOCKET_IDLE_MS
        ? `  Proxy idle -> ${PROXY_SOCKET_IDLE_MS}ms (ROUTER_PROXY_SOCKET_MS; 0=off)`
        : "  Proxy idle -> off (ROUTER_PROXY_SOCKET_MS=0)",
    );
    pushLog({
      time: ts(),
      dest: "local",
      reason: `Router ready — http://${CFG.listenHost}:${CFG.port} (dashboard log + SSE)`,
      fallback: false,
    });
    const idleMin = getIdleUnloadMinutes();
    if (idleMin)
      console.log(`  Idle       -> auto-unload after ${idleMin} min`);
    console.log("");
    startIdleUnloadTimer();
  });
}

void startListening();

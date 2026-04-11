"use strict";
const fs = require("fs");
const path = require("path");
const { normalizeRoutingMode } = require("./routing-logic");
const { normalizeTimeZone } = require("./time-format");

const CONFIG_BASENAME = "hybrid.config.json";

/** Prevents double-registration when watchConfig is called more than once (e.g. after auto-default creates the file). */
const _watchedPaths = new Set();

/** Absolute path to JSON file; used by integration tests so mutating routes do not touch the repo config. */
function configPath(dir) {
  const override = process.env.ROUTER_HYBRID_CONFIG;
  if (override != null && String(override).trim() !== "") {
    return path.resolve(String(override).trim());
  }
  return path.join(dir, CONFIG_BASENAME);
}

function loadJsonFile(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function applyUserConfig(CFG, user) {
  if (!user || typeof user !== "object") return;
  if (user.local && typeof user.local === "object") {
    const L = user.local;
    if (typeof L.model === "string" && L.model.trim()) {
      CFG.local.model = L.model.trim();
    }
    if (Array.isArray(L.models)) {
      CFG.local.models = L.models.map((x) => String(x).trim()).filter(Boolean);
    }
    if (typeof L.smart_routing === "boolean") {
      CFG.local.smart_routing = L.smart_routing;
    }
    if (Object.prototype.hasOwnProperty.call(L, "fast_model")) {
      CFG.local.fast_model =
        typeof L.fast_model === "string" ? L.fast_model.trim() : "";
    }
  }
  if (user.routing && typeof user.routing === "object") {
    const r = user.routing;
    if (Number.isFinite(Number(r.tokenThreshold))) {
      CFG.routing.tokenThreshold = Number(r.tokenThreshold);
    }
    if (Number.isFinite(Number(r.fileReadThreshold))) {
      CFG.routing.fileReadThreshold = Number(r.fileReadThreshold);
    }
    if (Array.isArray(r.keywords) && r.keywords.length) {
      CFG.routing.keywords = r.keywords.map((k) => String(k).toLowerCase());
    }
    if (Object.prototype.hasOwnProperty.call(r, "mode")) {
      CFG.routing.mode = normalizeRoutingMode(r.mode);
    }
  }
  if (user.display && typeof user.display === "object") {
    const d = user.display;
    if (Object.prototype.hasOwnProperty.call(d, "time_zone")) {
      CFG.display.time_zone = normalizeTimeZone(d.time_zone);
    }
  }
  if (user.privacy && typeof user.privacy === "object") {
    const p = user.privacy;
    if (p.cloud_redaction && typeof p.cloud_redaction === "object") {
      const cr = p.cloud_redaction;
      if (!CFG.privacy || typeof CFG.privacy !== "object") CFG.privacy = {};
      if (
        !CFG.privacy.cloud_redaction ||
        typeof CFG.privacy.cloud_redaction !== "object"
      ) {
        CFG.privacy.cloud_redaction = {};
      }
      for (const key of [
        "enabled",
        "redact_tool_results",
        "redact_paths",
        "redact_urls",
        "redact_emails",
        "redact_secrets",
        "redact_ids",
        "redact_identifiers",
      ]) {
        if (typeof cr[key] === "boolean")
          CFG.privacy.cloud_redaction[key] = cr[key];
      }
      if (Array.isArray(cr.custom_terms)) {
        CFG.privacy.cloud_redaction.custom_terms = cr.custom_terms
          .map((term) => String(term || "").trim())
          .filter(Boolean);
      }
    }
  }
}

function resolveListenHost(fileHost) {
  const env = process.env.ROUTER_HOST;
  if (env !== undefined && env !== null && String(env).trim() !== "") {
    return String(env).trim();
  }
  if (fileHost) return String(fileHost).trim();
  return "127.0.0.1";
}

/** True when `hybrid.config.json` has no explicit non-empty `local.model` (missing key, empty, or whitespace). */
function localModelUnsetInConfigFile(routerDir) {
  const user = loadJsonFile(configPath(routerDir));
  const L =
    user && user.local && typeof user.local === "object" ? user.local : null;
  if (!L) return true;
  if (!Object.prototype.hasOwnProperty.call(L, "model")) return true;
  return String(L.model || "").trim() === "";
}

/** True when `local.fast_model` is absent or empty (speed assist not chosen). */
function localFastUnsetInConfigFile(routerDir) {
  const user = loadJsonFile(configPath(routerDir));
  const L =
    user && user.local && typeof user.local === "object" ? user.local : null;
  if (!L) return true;
  if (!Object.prototype.hasOwnProperty.call(L, "fast_model")) return true;
  return String(L.fast_model || "").trim() === "";
}

function loadAndApply(CFG, routerDir) {
  const user = loadJsonFile(configPath(routerDir));
  applyUserConfig(CFG, user);
  let fileHost = null;
  if (
    user &&
    user.listen &&
    typeof user.listen.host === "string" &&
    user.listen.host.trim()
  ) {
    fileHost = user.listen.host.trim();
  }
  CFG.listenHost = resolveListenHost(fileHost);
}

/** Persist `local.model` into hybrid.config.json (merge with existing file). */
function saveLocalModel(routerDir, modelName) {
  const p = configPath(routerDir);
  let obj = {};
  if (fs.existsSync(p)) {
    try {
      obj = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      obj = {};
    }
  }
  if (!obj.local || typeof obj.local !== "object") obj.local = {};
  obj.local.model = String(modelName || "").trim();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

/** Merge `local.models` / `local.smart_routing` / `local.fast_model` into hybrid.config.json (keeps other keys). */
function saveLocalRoutingSettings(
  routerDir,
  { models, smart_routing, fast_model } = {},
) {
  const p = configPath(routerDir);
  let obj = {};
  if (fs.existsSync(p)) {
    try {
      obj = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      obj = {};
    }
  }
  if (!obj.local || typeof obj.local !== "object") obj.local = {};
  if (Array.isArray(models)) {
    obj.local.models = models.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof smart_routing === "boolean") {
    obj.local.smart_routing = smart_routing;
  }
  if (typeof fast_model === "string") {
    obj.local.fast_model = fast_model.trim();
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

/** Persist `routing.mode` into hybrid.config.json (hybrid | cloud | local). */
function saveRoutingMode(routerDir, mode) {
  const normalized = normalizeRoutingMode(mode);
  const p = configPath(routerDir);
  let obj = {};
  if (fs.existsSync(p)) {
    try {
      obj = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      obj = {};
    }
  }
  if (!obj.routing || typeof obj.routing !== "object") obj.routing = {};
  obj.routing.mode = normalized;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  return normalized;
}

function watchConfig(routerDir, onReload) {
  const p = configPath(routerDir);
  if (!fs.existsSync(p)) return;
  if (_watchedPaths.has(p)) return; // already watching; skip double-registration
  _watchedPaths.add(p);
  let t;
  try {
    fs.watch(p, () => {
      clearTimeout(t);
      t = setTimeout(() => {
        try {
          onReload();
        } catch (e) {
          console.error("[hybrid-config] reload failed:", e.message);
        }
      }, 400);
    });
  } catch (_) {
    _watchedPaths.delete(p); // watch setup failed; allow retry next call
  }
}

module.exports = {
  CONFIG_BASENAME,
  configPath,
  loadAndApply,
  watchConfig,
  resolveListenHost,
  saveLocalModel,
  saveLocalRoutingSettings,
  saveRoutingMode,
  localModelUnsetInConfigFile,
  localFastUnsetInConfigFile,
};

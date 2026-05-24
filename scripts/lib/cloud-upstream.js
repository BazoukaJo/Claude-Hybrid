"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PREV_BASE_URL_KEY = "CLAUDE_HYBRID_PREV_ANTHROPIC_BASE_URL";
const DEFAULT_CLOUD = {
  protocol: "https",
  host: "api.anthropic.com",
  port: 443,
};

function routerPort(env = process.env) {
  const p = String(env.ROUTER_PORT || env.PORT || "8082").trim();
  const n = parseInt(p, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? String(n) : "8082";
}

function kitRouterUrls(portOrBaseUrl) {
  const p =
    typeof portOrBaseUrl === "string" && portOrBaseUrl.includes("://")
      ? routerPort(process.env)
      : String(portOrBaseUrl || routerPort(process.env));
  return new Set([
    `http://127.0.0.1:${p}`,
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}/`,
    `http://localhost:${p}/`,
    "http://127.0.0.1:8082",
    "http://localhost:8082",
    "http://127.0.0.1:8082/",
    "http://localhost:8082/",
  ]);
}

function isKitRouterUrl(v, port) {
  const s = String(v || "").trim().replace(/\/+$/, "");
  if (!s) return false;
  const kits = kitRouterUrls(port);
  return kits.has(s) || kits.has(`${s}/`);
}

function isCustomAnthropicUrl(v, port) {
  const s = String(v || "").trim();
  if (!s || isKitRouterUrl(s, port)) return false;
  return /^https?:\/\//i.test(s);
}

function parseCloudTarget(input) {
  if (!input) return null;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const host = String(input.host || "").trim();
    if (host) {
      const protocol =
        String(input.protocol || "https").trim().toLowerCase() === "http"
          ? "http"
          : "https";
      const fallbackPort = protocol === "http" ? 80 : 443;
      const portRaw = input.port;
      const port =
        portRaw == null || portRaw === ""
          ? fallbackPort
          : Number.parseInt(String(portRaw), 10);
      if (!Number.isFinite(port) || port <= 0) return null;
      return {
        protocol,
        host,
        port,
        base_url: `${protocol}://${host}${port === fallbackPort ? "" : `:${port}`}`,
      };
    }
    if (typeof input.base_url === "string" && input.base_url.trim()) {
      return parseCloudTarget(input.base_url.trim());
    }
    return null;
  }
  let raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    const protocol = u.protocol === "http:" ? "http" : "https";
    const fallbackPort = protocol === "http" ? 80 : 443;
    const port = u.port ? Number.parseInt(u.port, 10) : fallbackPort;
    if (!Number.isFinite(port) || port <= 0) return null;
    const host = u.hostname;
    if (!host) return null;
    const basePath =
      u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
    return {
      protocol,
      host,
      port,
      base_url: `${protocol}://${host}${port === fallbackPort ? "" : `:${port}`}${basePath}`,
    };
  } catch {
    return null;
  }
}

function isDefaultCloudTarget(target) {
  if (!target) return true;
  return (
    target.host === DEFAULT_CLOUD.host &&
    target.port === DEFAULT_CLOUD.port &&
    target.protocol === DEFAULT_CLOUD.protocol
  );
}

function loadJsonFile(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readClaudeSettingsEnv() {
  const file = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".claude",
    "settings.json",
  );
  const obj = loadJsonFile(file);
  if (!obj || typeof obj !== "object" || !obj.env || typeof obj.env !== "object") {
    return {};
  }
  return obj.env;
}

function getWindowsUserEnv(name) {
  if (process.platform !== "win32") return "";
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[System.Environment]::GetEnvironmentVariable('${name.replace(/'/g, "''")}', 'User')`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (ps.status !== 0) return "";
  return String(ps.stdout || "").trim();
}

function cloudFromConfigObject(cloud) {
  if (!cloud || typeof cloud !== "object") return null;
  if (typeof cloud.base_url === "string" && cloud.base_url.trim()) {
    return parseCloudTarget(cloud.base_url.trim());
  }
  return parseCloudTarget(cloud);
}

/**
 * Resolve where cloud-bound hybrid traffic should be forwarded.
 * Priority: ROUTER_CLOUD_* env > hybrid.config.json cloud > saved prev URL > current custom client URL > Anthropic default.
 */
function resolveCloudUpstream(options = {}) {
  const env = options.env || process.env;
  const port = routerPort(env);
  const repoRoot = options.repoRoot || path.join(__dirname, "..", "..");
  const routerDir = options.routerDir || path.join(repoRoot, "router");
  const readUserEnv =
    typeof options.getUserEnv === "function"
      ? options.getUserEnv
      : getWindowsUserEnv;
  const settingsEnv =
    options.settingsEnv && typeof options.settingsEnv === "object"
      ? options.settingsEnv
      : readClaudeSettingsEnv();

  const envHost = String(env.ROUTER_CLOUD_HOST || "").trim();
  if (envHost) {
    const parsed = parseCloudTarget({
      host: envHost,
      protocol: env.ROUTER_CLOUD_PROTOCOL,
      port: env.ROUTER_CLOUD_PORT,
    });
    if (parsed) return { ...parsed, source: "env" };
  }

  const user = loadJsonFile(path.join(routerDir, "hybrid.config.json"));
  const fromFile = user ? cloudFromConfigObject(user.cloud) : null;
  if (fromFile && !isDefaultCloudTarget(fromFile)) {
    return { ...fromFile, source: "hybrid.config.json" };
  }

  const prevCandidates = [
    settingsEnv[PREV_BASE_URL_KEY],
    readUserEnv(PREV_BASE_URL_KEY),
  ];
  for (const candidate of prevCandidates) {
    if (isCustomAnthropicUrl(candidate, port)) {
      const parsed = parseCloudTarget(candidate);
      if (parsed) return { ...parsed, source: "saved-previous-client-url" };
    }
  }

  const clientCandidates = [
    settingsEnv.ANTHROPIC_BASE_URL,
    readUserEnv("ANTHROPIC_BASE_URL"),
    env.ANTHROPIC_BASE_URL,
  ];
  for (const candidate of clientCandidates) {
    if (isCustomAnthropicUrl(candidate, port)) {
      const parsed = parseCloudTarget(candidate);
      if (parsed) return { ...parsed, source: "current-custom-client-url" };
    }
  }

  return { ...DEFAULT_CLOUD, source: "default" };
}

function syncCloudUpstreamToConfig(routerDir, upstream) {
  if (!upstream || isDefaultCloudTarget(upstream)) return false;
  const p = path.join(routerDir, "hybrid.config.json");
  let obj = loadJsonFile(p) || {};
  if (!obj.cloud || typeof obj.cloud !== "object") obj.cloud = {};
  const next = {
    base_url: upstream.base_url,
    protocol: upstream.protocol,
    host: upstream.host,
    port: upstream.port,
  };
  const same =
    obj.cloud.base_url === next.base_url &&
    obj.cloud.host === next.host &&
    obj.cloud.port === next.port &&
    obj.cloud.protocol === next.protocol;
  if (same) return false;
  obj.cloud = next;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  return true;
}

function prepareCloudUpstream(repoRoot, options = {}) {
  const routerDir = path.join(repoRoot, "router");
  const upstream = resolveCloudUpstream({
    repoRoot,
    routerDir,
    env: options.env,
    settingsEnv: options.settingsEnv,
    getUserEnv: options.getUserEnv,
  });
  if (!isDefaultCloudTarget(upstream)) {
    syncCloudUpstreamToConfig(routerDir, upstream);
  }
  return upstream;
}

function applyCloudConfig(CFG, user) {
  if (!CFG || typeof CFG !== "object") return;
  if (!CFG.cloud || typeof CFG.cloud !== "object") {
    CFG.cloud = { ...DEFAULT_CLOUD };
  }
  if (String(process.env.ROUTER_CLOUD_HOST || "").trim()) return;
  const parsed = user && user.cloud ? cloudFromConfigObject(user.cloud) : null;
  if (!parsed || !parsed.host) return;
  CFG.cloud.protocol = parsed.protocol;
  CFG.cloud.host = parsed.host;
  CFG.cloud.port = parsed.port;
}

function describeRoutingMode(clientUrl, port, routerListening) {
  const kit = isKitRouterUrl(clientUrl, port);
  if (kit && routerListening) return "hybrid-active";
  if (kit && !routerListening) return "hybrid-misconfigured-router-down";
  if (isCustomAnthropicUrl(clientUrl, port) && !routerListening) {
    return "direct-proxy";
  }
  if (isCustomAnthropicUrl(clientUrl, port) && routerListening) {
    return "direct-proxy-bypasses-router";
  }
  if (!clientUrl && routerListening) return "hybrid-partial-settings-missing";
  return "direct-anthropic-default";
}

module.exports = {
  PREV_BASE_URL_KEY,
  DEFAULT_CLOUD,
  routerPort,
  kitRouterUrls,
  isKitRouterUrl,
  isCustomAnthropicUrl,
  parseCloudTarget,
  isDefaultCloudTarget,
  resolveCloudUpstream,
  syncCloudUpstreamToConfig,
  prepareCloudUpstream,
  applyCloudConfig,
  cloudFromConfigObject,
  describeRoutingMode,
};

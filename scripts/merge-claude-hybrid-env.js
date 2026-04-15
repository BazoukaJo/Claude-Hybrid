"use strict";
/**
 * Merges hybrid routing into:
 * - ~/.claude/settings.json (env.ANTHROPIC_BASE_URL) — Claude Code reads this even when GUI apps ignore User env
 * - VS Code User settings (terminal.integrated.env.*) — integrated terminal + extensions inherit this
 *
 * Windows: start_app.bat runs this before starting the router; stop_app.bat runs revert-hybrid-core.bat after stop
 * so ANTHROPIC_BASE_URL is cleared while the router is down (Claude uses cloud). setup.ps1 -Autostart runs this
 * before spawning the background router.
 *
 * Optional Claude Code API billing (instead of subscription for eligible traffic):
 * - Set ANTHROPIC_API_KEY in the environment, then run this script — it copies the key into settings.json env
 *   (never committed; get the key from https://console.anthropic.com ).
 * - To remove the key from settings.json: ROUTER_REMOVE_CLAUDE_API_KEY=1 npm run merge-env
 *
 * Base URL uses 127.0.0.1 (avoids IPv6 localhost quirks) and ROUTER_PORT / PORT / 8082.
 * See https://code.claude.com/docs/en/env-vars
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PREV_BASE_URL_KEY = "CLAUDE_HYBRID_PREV_ANTHROPIC_BASE_URL";
const MANAGED_BASE_URL_KEY = "CLAUDE_HYBRID_MANAGED_ANTHROPIC_BASE_URL";

function routerPort() {
  const p = String(
    process.env.ROUTER_PORT || process.env.PORT || "8082",
  ).trim();
  const n = parseInt(p, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? String(n) : "8082";
}

function hybridBaseUrl() {
  return `http://127.0.0.1:${routerPort()}`;
}

function kitRouterUrls(baseUrl) {
  const p = routerPort();
  return new Set([
    String(baseUrl || "").trim(),
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
    "http://localhost:8082",
    "http://127.0.0.1:8082",
  ]);
}

function isKitRouterUrl(v, kits) {
  const s = String(v || "").trim();
  return s.length > 0 && kits.has(s);
}

const ENABLE_TOOL_SEARCH = "true";

function mergeClaudeSettings(baseUrl) {
  const dir = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".claude",
  );
  const file = path.join(dir, "settings.json");
  let obj = {};
  if (fs.existsSync(file)) {
    try {
      obj = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(
        "Could not parse",
        file,
        "- fix JSON or merge env manually.",
      );
      process.exit(1);
    }
  }
  if (!obj || typeof obj !== "object") obj = {};
  if (!obj.env || typeof obj.env !== "object") obj.env = {};
  let changed = false;
  const kits = kitRouterUrls(baseUrl);

  const existing = String(obj.env.ANTHROPIC_BASE_URL || "").trim();
  const prevStored = String(obj.env[PREV_BASE_URL_KEY] || "").trim();
  const managed = String(obj.env[MANAGED_BASE_URL_KEY] || "").trim() === "1";
  if (existing && !isKitRouterUrl(existing, kits) && !prevStored && !managed) {
    obj.env[PREV_BASE_URL_KEY] = existing;
    changed = true;
    console.log(
      "Claude settings.json: saved previous ANTHROPIC_BASE_URL for restore.",
    );
  }

  if (/^true$/i.test(String(process.env.ROUTER_REMOVE_CLAUDE_API_KEY || ""))) {
    if (Object.prototype.hasOwnProperty.call(obj.env, "ANTHROPIC_API_KEY")) {
      delete obj.env.ANTHROPIC_API_KEY;
      changed = true;
      console.log("Removed env.ANTHROPIC_API_KEY from Claude settings.json");
    }
  }

  const desired = {
    ANTHROPIC_BASE_URL: baseUrl,
    ENABLE_TOOL_SEARCH,
    [MANAGED_BASE_URL_KEY]: "1",
  };
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (apiKey) {
    desired.ANTHROPIC_API_KEY = apiKey;
  }
  const prevApiKey = obj.env.ANTHROPIC_API_KEY;
  for (const [k, v] of Object.entries(desired)) {
    if (obj.env[k] !== v) {
      obj.env[k] = v;
      changed = true;
    }
  }
  if (apiKey && obj.env.ANTHROPIC_API_KEY !== prevApiKey) {
    console.log(
      "Claude settings.json: wrote ANTHROPIC_API_KEY from environment (value not printed).",
    );
  }
  if (changed) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    console.log("Updated", file);
  } else {
    console.log("Claude settings.json env already has hybrid routing URL.");
  }
  return changed;
}

function terminalEnvKey() {
  if (process.platform === "win32") return "terminal.integrated.env.windows";
  if (process.platform === "darwin") return "terminal.integrated.env.osx";
  return "terminal.integrated.env.linux";
}

function ideUserSettingsPaths() {
  const h = process.env.HOME || process.env.USERPROFILE || "";
  if (process.platform === "win32" && process.env.APPDATA) {
    const ad = process.env.APPDATA;
    return [path.join(ad, "Code", "User", "settings.json")];
  }
  if (process.platform === "darwin") {
    return [
      path.join(
        h,
        "Library",
        "Application Support",
        "Code",
        "User",
        "settings.json",
      ),
    ];
  }
  return [path.join(h, ".config", "Code", "User", "settings.json")];
}

function tryParseSettingsJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mergeIdeTerminalEnv(baseUrl) {
  const key = terminalEnvKey();
  const kits = kitRouterUrls(baseUrl);
  let anyChanged = false;
  for (const file of ideUserSettingsPaths()) {
    let obj = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      obj = tryParseSettingsJson(raw);
      if (obj === null) {
        console.warn("Skip IDE settings (invalid JSON):", file);
        continue;
      }
    }
    if (!obj || typeof obj !== "object") obj = {};
    const block = {
      ...(obj[key] && typeof obj[key] === "object" ? obj[key] : {}),
    };
    const existing = String(block.ANTHROPIC_BASE_URL || "").trim();
    const prevStored = String(block[PREV_BASE_URL_KEY] || "").trim();
    const managed = String(block[MANAGED_BASE_URL_KEY] || "").trim() === "1";
    if (
      existing &&
      !isKitRouterUrl(existing, kits) &&
      !prevStored &&
      !managed
    ) {
      block[PREV_BASE_URL_KEY] = existing;
    }
    const needsUrl = block.ANTHROPIC_BASE_URL !== baseUrl;
    const needsToolSearch = block.ENABLE_TOOL_SEARCH !== ENABLE_TOOL_SEARCH;
    const needsBackupWrite =
      !!existing &&
      !isKitRouterUrl(existing, kits) &&
      !prevStored &&
      !managed &&
      block[PREV_BASE_URL_KEY] === existing;
    const needsManagedWrite = block[MANAGED_BASE_URL_KEY] !== "1";
    if (
      !needsUrl &&
      !needsToolSearch &&
      !needsBackupWrite &&
      !needsManagedWrite
    )
      continue;
    block.ANTHROPIC_BASE_URL = baseUrl;
    block.ENABLE_TOOL_SEARCH = ENABLE_TOOL_SEARCH;
    block[MANAGED_BASE_URL_KEY] = "1";
    obj[key] = block;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    console.log(
      "Updated",
      file,
      `(${key}: ANTHROPIC_BASE_URL + ENABLE_TOOL_SEARCH)`,
    );
    anyChanged = true;
  }
  if (!anyChanged && ideUserSettingsPaths().every((f) => fs.existsSync(f))) {
    console.log(
      "VS Code terminal env already has hybrid URL + ENABLE_TOOL_SEARCH (or file skipped).",
    );
  }
  return anyChanged;
}

function getUserEnv(name) {
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

function setUserEnv(name, value) {
  if (process.platform !== "win32") return false;
  const encodedValue =
    value == null ? "$null" : `'${String(value).replace(/'/g, "''")}'`;
  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[System.Environment]::SetEnvironmentVariable('${name.replace(/'/g, "''")}', ${encodedValue}, 'User')`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return ps.status === 0;
}

function mergeUserEnv(baseUrl) {
  if (process.platform !== "win32") return false;
  const kits = kitRouterUrls(baseUrl);
  let changed = false;
  const current = getUserEnv("ANTHROPIC_BASE_URL");
  const prev = getUserEnv(PREV_BASE_URL_KEY);
  const managed = getUserEnv(MANAGED_BASE_URL_KEY) === "1";
  if (current && !isKitRouterUrl(current, kits) && !prev && !managed) {
    if (setUserEnv(PREV_BASE_URL_KEY, current)) {
      console.log("Saved previous User ANTHROPIC_BASE_URL for restore.");
      changed = true;
    }
  }
  if (current !== baseUrl) {
    if (setUserEnv("ANTHROPIC_BASE_URL", baseUrl)) {
      console.log("Updated User ANTHROPIC_BASE_URL ->", baseUrl);
      changed = true;
    }
  }
  if (!managed && setUserEnv(MANAGED_BASE_URL_KEY, "1")) {
    changed = true;
  }
  return changed;
}

function notifyWindowsEnvironment() {
  if (process.platform !== "win32") return;
  const ps1 = path.join(__dirname, "notify-environment-windows.ps1");
  if (!fs.existsSync(ps1)) return;
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
    { stdio: "ignore", windowsHide: true },
  );
}

function main() {
  const baseUrl = hybridBaseUrl();
  console.log("Hybrid base URL:", baseUrl);
  const a = mergeClaudeSettings(baseUrl);
  const b = mergeIdeTerminalEnv(baseUrl);
  const c = mergeUserEnv(baseUrl);
  notifyWindowsEnvironment();
  if (a || b || c) {
    console.log("");
    console.log(
      "Restart VS Code (full quit) so editor UI picks up settings.json changes.",
    );
    console.log(
      "New integrated terminals should already see ANTHROPIC_BASE_URL.",
    );
  }
  if (String(process.env.ANTHROPIC_API_KEY || "").trim()) {
    console.log("");
    console.log(
      "Claude Code: first interactive run may prompt to use the API key instead of subscription.",
    );
    console.log(
      "Keep pay-as-you-go billing enabled for that key in the Anthropic Console if you use cloud.",
    );
  }
}

main();

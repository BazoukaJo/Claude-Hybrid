"use strict";
/**
 * Clears kit proxy URL from:
 * - ~/.claude/settings.json (env.ANTHROPIC_BASE_URL)
 * - Cursor / VS Code User settings (terminal.integrated.env.* ANTHROPIC_BASE_URL)
 *
 * Only removes values that match merge-claude-hybrid-env.js defaults (localhost/127.0.0.1 + ROUTER_PORT).
 * Pair with revert-hybrid-user-env.ps1 (User registry) via revert-hybrid-core.bat.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PREV_BASE_URL_KEY = "CLAUDE_HYBRID_PREV_ANTHROPIC_BASE_URL";
const MANAGED_BASE_URL_KEY = "CLAUDE_HYBRID_MANAGED_ANTHROPIC_BASE_URL";

function kitRouterUrls() {
  const p = String(
    process.env.ROUTER_PORT || process.env.PORT || "8082",
  ).trim();
  return new Set([
    "http://localhost:8082",
    "http://127.0.0.1:8082",
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
  ]);
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
    return [
      path.join(ad, "Cursor", "User", "settings.json"),
      path.join(ad, "Code", "User", "settings.json"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      path.join(
        h,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "settings.json",
      ),
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
  return [
    path.join(h, ".config", "Cursor", "User", "settings.json"),
    path.join(h, ".config", "Code", "User", "settings.json"),
  ];
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

function revertClaudeSettingsEnv(kits) {
  const dir = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".claude",
  );
  const file = path.join(dir, "settings.json");
  if (!fs.existsSync(file)) return false;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("Could not parse", file, "- fix JSON manually.");
    process.exit(1);
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    !obj.env ||
    typeof obj.env !== "object"
  )
    return false;
  const v = obj.env.ANTHROPIC_BASE_URL;
  const url = String(v || "").trim();
  const managed = String(obj.env[MANAGED_BASE_URL_KEY] || "").trim() === "1";
  if (!url) {
    let changed = false;
    if (obj.env[PREV_BASE_URL_KEY] != null) {
      delete obj.env[PREV_BASE_URL_KEY];
      changed = true;
    }
    if (obj.env[MANAGED_BASE_URL_KEY] != null) {
      delete obj.env[MANAGED_BASE_URL_KEY];
      changed = true;
    }
    if (changed) {
      if (Object.keys(obj.env).length === 0) delete obj.env;
      fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    }
    return changed;
  }
  if (!kits.has(url) && !managed) {
    console.log("settings.json: ANTHROPIC_BASE_URL is custom — left as-is:", v);
    return false;
  }
  const prev = String(obj.env[PREV_BASE_URL_KEY] || "").trim();
  if (prev && !kits.has(prev)) {
    obj.env.ANTHROPIC_BASE_URL = prev;
    delete obj.env[PREV_BASE_URL_KEY];
    if (obj.env[MANAGED_BASE_URL_KEY] != null)
      delete obj.env[MANAGED_BASE_URL_KEY];
    console.log("Restored env.ANTHROPIC_BASE_URL from backup in", file);
  } else {
    delete obj.env.ANTHROPIC_BASE_URL;
    if (obj.env[PREV_BASE_URL_KEY] != null) delete obj.env[PREV_BASE_URL_KEY];
    if (obj.env[MANAGED_BASE_URL_KEY] != null)
      delete obj.env[MANAGED_BASE_URL_KEY];
    console.log("Removed env.ANTHROPIC_BASE_URL from", file);
  }
  if (Object.keys(obj.env).length === 0) delete obj.env;
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  return true;
}

function revertIdeTerminalEnv(kits) {
  const key = terminalEnvKey();
  let any = false;
  for (const file of ideUserSettingsPaths()) {
    if (!fs.existsSync(file)) continue;
    let obj;
    try {
      obj = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      console.warn("Skip IDE settings (invalid JSON):", file);
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const block = obj[key];
    if (!block || typeof block !== "object") continue;
    const url = block.ANTHROPIC_BASE_URL;
    if (url == null || url === "") continue;
    const managed = String(block[MANAGED_BASE_URL_KEY] || "").trim() === "1";
    if (!kits.has(String(url).trim()) && !managed) continue;
    const prev = String(block[PREV_BASE_URL_KEY] || "").trim();
    if (prev && !kits.has(prev)) {
      block.ANTHROPIC_BASE_URL = prev;
      delete block[PREV_BASE_URL_KEY];
      if (block[MANAGED_BASE_URL_KEY] != null)
        delete block[MANAGED_BASE_URL_KEY];
      console.log(`Restored ${key}.ANTHROPIC_BASE_URL from backup in`, file);
    } else {
      delete block.ANTHROPIC_BASE_URL;
      if (block[PREV_BASE_URL_KEY] != null) delete block[PREV_BASE_URL_KEY];
      if (block[MANAGED_BASE_URL_KEY] != null)
        delete block[MANAGED_BASE_URL_KEY];
      console.log(`Removed ${key}.ANTHROPIC_BASE_URL from`, file);
    }
    if (Object.keys(block).length === 0) delete obj[key];
    else obj[key] = block;
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    any = true;
  }
  return any;
}

function main() {
  const kits = kitRouterUrls();
  const a = revertClaudeSettingsEnv(kits);
  const b = revertIdeTerminalEnv(kits);
  if (a || b) {
    console.log(
      "Restart Claude Code / Cursor (full quit) after User env is cleared.",
    );
    notifyWindowsEnvironment();
  } else {
    console.log(
      "Claude settings + IDE: no kit ANTHROPIC_BASE_URL to remove (absent, custom URL, or clean).",
    );
  }
}

main();

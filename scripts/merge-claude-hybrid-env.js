'use strict';
/**
 * Merges hybrid routing into:
 * - ~/.claude/settings.json (env.ANTHROPIC_BASE_URL) — Claude Code reads this even when GUI apps ignore User env
 * - Cursor / VS Code User settings (terminal.integrated.env.*) — integrated terminal + many extensions inherit this
 *
 * Optional Claude Code API billing (instead of subscription for eligible traffic):
 * - Set ANTHROPIC_API_KEY in the environment, then run this script — it copies the key into settings.json env
 *   (never committed; get the key from https://console.anthropic.com ).
 * - To remove the key from settings.json: ROUTER_REMOVE_CLAUDE_API_KEY=1 npm run merge-env
 *
 * Base URL uses 127.0.0.1 (avoids IPv6 localhost quirks) and ROUTER_PORT / PORT / 8082.
 * See https://code.claude.com/docs/en/env-vars
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function routerPort() {
  const p = String(process.env.ROUTER_PORT || process.env.PORT || '8082').trim();
  const n = parseInt(p, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? String(n) : '8082';
}

function hybridBaseUrl() {
  return `http://127.0.0.1:${routerPort()}`;
}

const ENABLE_TOOL_SEARCH = 'true';

function mergeClaudeSettings(baseUrl) {
  const dir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
  const file = path.join(dir, 'settings.json');
  let obj = {};
  if (fs.existsSync(file)) {
    try {
      obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error('Could not parse', file, '- fix JSON or merge env manually.');
      process.exit(1);
    }
  }
  if (!obj || typeof obj !== 'object') obj = {};
  if (!obj.env || typeof obj.env !== 'object') obj.env = {};
  let changed = false;

  if (/^true$/i.test(String(process.env.ROUTER_REMOVE_CLAUDE_API_KEY || ''))) {
    if (Object.prototype.hasOwnProperty.call(obj.env, 'ANTHROPIC_API_KEY')) {
      delete obj.env.ANTHROPIC_API_KEY;
      changed = true;
      console.log('Removed env.ANTHROPIC_API_KEY from Claude settings.json');
    }
  }

  const desired = {
    ANTHROPIC_BASE_URL: baseUrl,
    ENABLE_TOOL_SEARCH,
  };
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
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
    console.log('Claude settings.json: wrote ANTHROPIC_API_KEY from environment (value not printed).');
  }
  if (changed) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    console.log('Updated', file);
  } else {
    console.log('Claude settings.json env already has hybrid routing URL.');
  }
  return changed;
}

function terminalEnvKey() {
  if (process.platform === 'win32') return 'terminal.integrated.env.windows';
  if (process.platform === 'darwin') return 'terminal.integrated.env.osx';
  return 'terminal.integrated.env.linux';
}

function ideUserSettingsPaths() {
  const h = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'win32' && process.env.APPDATA) {
    const ad = process.env.APPDATA;
    return [
      path.join(ad, 'Cursor', 'User', 'settings.json'),
      path.join(ad, 'Code', 'User', 'settings.json'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      path.join(h, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
      path.join(h, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    ];
  }
  return [
    path.join(h, '.config', 'Cursor', 'User', 'settings.json'),
    path.join(h, '.config', 'Code', 'User', 'settings.json'),
  ];
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
  let anyChanged = false;
  for (const file of ideUserSettingsPaths()) {
    let obj = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      obj = tryParseSettingsJson(raw);
      if (obj === null) {
        console.warn('Skip IDE settings (invalid JSON):', file);
        continue;
      }
    }
    if (!obj || typeof obj !== 'object') obj = {};
    const block = { ...(obj[key] && typeof obj[key] === 'object' ? obj[key] : {}) };
    const needsUrl = block.ANTHROPIC_BASE_URL !== baseUrl;
    const needsToolSearch = block.ENABLE_TOOL_SEARCH !== ENABLE_TOOL_SEARCH;
    if (!needsUrl && !needsToolSearch) continue;
    block.ANTHROPIC_BASE_URL = baseUrl;
    block.ENABLE_TOOL_SEARCH = ENABLE_TOOL_SEARCH;
    obj[key] = block;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    console.log('Updated', file, `(${key}: ANTHROPIC_BASE_URL + ENABLE_TOOL_SEARCH)`);
    anyChanged = true;
  }
  if (!anyChanged && ideUserSettingsPaths().every((f) => fs.existsSync(f))) {
    console.log('Cursor/VS Code terminal env already has hybrid URL + ENABLE_TOOL_SEARCH (or files skipped).');
  }
  return anyChanged;
}

function notifyWindowsEnvironment() {
  if (process.platform !== 'win32') return;
  const ps1 = path.join(__dirname, 'notify-environment-windows.ps1');
  if (!fs.existsSync(ps1)) return;
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    { stdio: 'ignore', windowsHide: true },
  );
}

function main() {
  const baseUrl = hybridBaseUrl();
  console.log('Hybrid base URL:', baseUrl);
  const a = mergeClaudeSettings(baseUrl);
  const b = mergeIdeTerminalEnv(baseUrl);
  notifyWindowsEnvironment();
  if (a || b) {
    console.log('');
    console.log('Restart Cursor / VS Code (full quit) so editor UI picks up settings.json changes.');
    console.log('New integrated terminals should already see ANTHROPIC_BASE_URL.');
  }
  if (String(process.env.ANTHROPIC_API_KEY || '').trim()) {
    console.log('');
    console.log('Claude Code: first interactive run may prompt to use the API key instead of subscription.');
    console.log('Keep pay-as-you-go billing enabled for that key in the Anthropic Console if you use cloud.');
  }
}

main();

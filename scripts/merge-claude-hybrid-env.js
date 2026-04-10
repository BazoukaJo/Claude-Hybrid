'use strict';
/**
 * Merges hybrid routing into:
 * - ~/.claude/settings.json (env.ANTHROPIC_BASE_URL) — Claude Code reads this even when GUI apps ignore User env
 * - Cursor / VS Code User settings (terminal.integrated.env.*) — integrated terminal + many extensions inherit this
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
  const desired = {
    ANTHROPIC_BASE_URL: baseUrl,
    ENABLE_TOOL_SEARCH,
  };
  let changed = false;
  for (const [k, v] of Object.entries(desired)) {
    if (obj.env[k] !== v) {
      obj.env[k] = v;
      changed = true;
    }
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
    if (block.ANTHROPIC_BASE_URL === baseUrl) continue;
    block.ANTHROPIC_BASE_URL = baseUrl;
    obj[key] = block;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    console.log('Updated', file, `(${key}.ANTHROPIC_BASE_URL)`);
    anyChanged = true;
  }
  if (!anyChanged && ideUserSettingsPaths().every((f) => fs.existsSync(f))) {
    console.log('Cursor/VS Code terminal env already has hybrid URL (or files skipped).');
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
}

main();

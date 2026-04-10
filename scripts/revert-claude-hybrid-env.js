'use strict';
/**
 * Removes ANTHROPIC_BASE_URL from ~/.claude/settings.json when it still points at
 * the default hybrid router (same values merge-claude-hybrid-env.js would set).
 */
const fs = require('fs');
const path = require('path');

function kitRouterUrls() {
  const p = String(process.env.ROUTER_PORT || process.env.PORT || '8082').trim();
  const set = new Set([
    'http://localhost:8082',
    'http://127.0.0.1:8082',
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
  ]);
  return set;
}

function main() {
  const dir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
  const file = path.join(dir, 'settings.json');
  if (!fs.existsSync(file)) {
    console.log('No ~/.claude/settings.json — nothing to revert.');
    return;
  }
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('Could not parse', file, '- fix JSON manually.');
    process.exit(1);
  }
  if (!obj || typeof obj !== 'object' || !obj.env || typeof obj.env !== 'object') {
    console.log('No env block in settings — nothing to revert.');
    return;
  }
  const v = obj.env.ANTHROPIC_BASE_URL;
  if (v == null || v === '') {
    console.log('settings.json: ANTHROPIC_BASE_URL not set — unchanged.');
    return;
  }
  if (!kitRouterUrls().has(String(v).trim())) {
    console.log('settings.json: ANTHROPIC_BASE_URL is custom — left as-is:', v);
    return;
  }
  delete obj.env.ANTHROPIC_BASE_URL;
  if (Object.keys(obj.env).length === 0) delete obj.env;
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  console.log('Removed env.ANTHROPIC_BASE_URL from', file);
  console.log('Restart Claude Code / Cursor if they are open.');
}

main();

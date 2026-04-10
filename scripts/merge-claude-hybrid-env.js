'use strict';
/**
 * Merges Claude Code global settings so API traffic can reach the hybrid router.
 * See https://code.claude.com/docs/en/env-vars — env in ~/.claude/settings.json
 */
const fs = require('fs');
const path = require('path');

const desired = {
  ANTHROPIC_BASE_URL: 'http://localhost:8082',
  ENABLE_TOOL_SEARCH: 'true',
};

function main() {
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
  for (const [k, v] of Object.entries(desired)) {
    if (obj.env[k] !== v) {
      obj.env[k] = v;
      changed = true;
    }
  }
  if (!changed) {
    console.log('Claude settings.json env already has hybrid routing.');
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  console.log('Updated', file, '- restart Claude Code, Cursor, and IDEs using it.');
}

main();

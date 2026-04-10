'use strict';

/**
 * Regression: dashboard main HTML is built from a server-side template literal.
 * A single-quoted JS string that used `\\n` unescaped in that outer template emitted
 * real newlines into the served <script>, causing a syntax error — so nothing ran
 * (no scroll padding, footer collapse, system stats poller, bootstrap).
 *
 * This test fetches `/` and verifies every inline script parses with vm.Script.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const TEST_PORT = Number.parseInt(process.env.TEST_ROUTER_PORT_SCRIPT_SYNTAX || '20991', 10);

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    http.get(urlStr, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

async function waitForHealth(port, timeout = 20000) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    try {
      const r = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
      });
      if (r === 200) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error('health timeout');
}

function extractInlineScripts(html) {
  const out = [];
  let rest = html;
  for (;;) {
    const a = rest.indexOf('<script>');
    if (a < 0) break;
    const b = rest.indexOf('</script>', a);
    if (b < 0) break;
    out.push(rest.slice(a + 8, b));
    rest = rest.slice(b + 9);
  }
  return out;
}

test('dashboard inline <script> blocks are valid JavaScript (vm.Script)', async (t) => {
  const routerDir = path.join(__dirname, '..', 'router');
  const env = { ...process.env, ROUTER_PORT: String(TEST_PORT) };
  delete env.ROUTER_ADMIN_TOKEN;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: routerDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
    const kill = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, 2500);
    kill.unref();
  });

  await waitForHealth(TEST_PORT);
  const html = await httpGet(`http://127.0.0.1:${TEST_PORT}/`);
  assert.ok(html.includes('<!DOCTYPE html>'), 'GET / returns HTML');

  const scripts = extractInlineScripts(html);
  assert.ok(scripts.length >= 2, `expected at least 2 inline scripts, got ${scripts.length}`);

  for (let i = 0; i < scripts.length; i++) {
    try {
      new vm.Script(scripts[i], { filename: `dashboard-inline-${i}.js` });
    } catch (e) {
      assert.fail(`inline script ${i} syntax error: ${e.message}\n---\n${scripts[i].slice(0, 800)}`);
    }
  }

  // Smell test: 401 hint must use \\n in the served file (two chars), not a real newline inside the string
  assert.ok(
    scripts[1].includes("(r.status===401?'\\n\\nIf ROUTER_ADMIN_TOKEN"),
    'alertFailedSave should emit \\n escapes, not literal newlines, inside the single-quoted string',
  );
});

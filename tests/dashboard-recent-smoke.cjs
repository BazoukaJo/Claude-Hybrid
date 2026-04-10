'use strict';

/**
 * Smoke checks for recent dashboard layout/API changes (header metrics, max width, pool save).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const TEST_PORT = Number.parseInt(process.env.TEST_ROUTER_PORT_SMOKE || '20938', 10);

function httpRequest(method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {},
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, { timeout = 15000, interval = 120 } = {}) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(lastErr ? String(lastErr.message || lastErr) : 'waitFor timeout');
}

test('dashboard HTML + system-stats + pool routing POST (no admin token)', async (t) => {
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
    }, 2000);
    kill.unref();
  });

  await waitFor(async () => {
    const r = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/health`);
    return r.status === 200;
  });

  const root = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/`);
  assert.strictEqual(root.status, 200);
  const html = root.body;
  for (const needle of [
    'class="hdr-inner"',
    '--dash-max-w:min(1280px,calc(100vw - 28px))',
    'assets/claude-code-icon.svg',
    'id="pool-save-msg"',
    'schedulePersistRoutingSettings',
    'id="fast-model-select"',
    'class="pbtn pbtn-save"',
    'hdr-system',
    'res-strip--hdr',
    'syncHdrStickyOffset',
    'id="local-pool-panel"',
    'data-poll-interval="10"',
    'getPollIntervalSec',
    'scheduleDashboardBootstrap',
    'params-toolbar',
    'btn-open-gen-json',
    'params-files-modal',
    'scheduleSaveParams',
    'dash-callout',
    'settings-hint-details',
    'info-readonly-note',
    'buymeacoffee.com/bazoukajo',
    'dash-supporter-footer',
    "fetch('/api/health'",
  ]) {
    assert.ok(html.includes(needle), `dashboard HTML should include: ${needle}`);
  }
  assert.ok(!html.includes('dash-intro'), 'removed intro block should not appear');

  const headerUi = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/header-ui`);
  assert.strictEqual(headerUi.status, 200);
  assert.ok(headerUi.body.includes('header-ui-preview-note'), 'header-ui preview banner present');

  const stats = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/system-stats`);
  assert.strictEqual(stats.status, 200);
  const sj = JSON.parse(stats.body);
  assert.ok('cpu' in sj && 'ram' in sj);

  const rawGlobal = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/router/model-params-raw?which=global`);
  assert.strictEqual(rawGlobal.status, 200);
  const rawGj = JSON.parse(rawGlobal.body);
  assert.strictEqual(rawGj.which, 'global');
  assert.ok(typeof rawGj.content === 'string');

  const save = await httpRequest(
    'POST',
    `http://127.0.0.1:${TEST_PORT}/api/router/local-routing-config`,
    JSON.stringify({ smart_routing: true, models: [] }),
  );
  assert.strictEqual(save.status, 200, save.body);
  const saved = JSON.parse(save.body);
  assert.strictEqual(saved.ok, true);
});

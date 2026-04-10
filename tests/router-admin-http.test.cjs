'use strict';

/**
 * Admin auth against a spawned router (no process.env mutation in the test runner).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TEST_PORT = Number.parseInt(process.env.TEST_ROUTER_PORT_ADMIN || '20939', 10);
const ADMIN = 'integration-test-admin-token';

function httpRequest(method, urlStr, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = { ...extraHeaders };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
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

test('mutating /api/* requires token when ROUTER_ADMIN_TOKEN is set', async (t) => {
  const routerDir = path.join(__dirname, '..', 'router');
  const tmpCfg = path.join(os.tmpdir(), `hybrid-admin-test-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(
    tmpCfg,
    `${JSON.stringify({
      local: {
        model: 'integration-test-initial-model',
        models: [],
        smart_routing: true,
        fast_model: '',
      },
    })}\n`,
    'utf8',
  );

  const child = spawn(process.execPath, ['server.js'], {
    cwd: routerDir,
    env: {
      ...process.env,
      ROUTER_PORT: String(TEST_PORT),
      ROUTER_ADMIN_TOKEN: ADMIN,
      ROUTER_HYBRID_CONFIG: tmpCfg,
    },
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
    try {
      fs.unlinkSync(tmpCfg);
    } catch (_) {}
  });

  await waitFor(async () => {
    const r = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/health`);
    return r.status === 200;
  });

  const denied = await httpRequest(
    'POST',
    `http://127.0.0.1:${TEST_PORT}/api/local-model`,
    JSON.stringify({ model: 'any-model:name' }),
  );
  assert.strictEqual(denied.status, 401);
  const j = JSON.parse(denied.body);
  assert.strictEqual(j.error, 'unauthorized');

  const ok = await httpRequest(
    'POST',
    `http://127.0.0.1:${TEST_PORT}/api/local-model`,
    JSON.stringify({ model: 'any-model:name' }),
    { 'X-Router-Token': ADMIN },
  );
  assert.ok(ok.status === 200 || ok.status === 400, `expected 200 or 400, got ${ok.status} ${ok.body}`);
});

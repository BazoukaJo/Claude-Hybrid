'use strict';

/**
 * /api/health must always return JSON quickly (bounded Ollama work) so dashboards never hang on "Checking…".
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

/** Must not collide with router-admin-http (20939), router-http (20937), or smoke (20938). */
const TEST_PORT = Number.parseInt(process.env.TEST_ROUTER_PORT_HEALTH || '20941', 10);
const HEALTH_MAX_MS = 6000;

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/health returns JSON within budget (no admin token)', async (t) => {
  const routerDir = path.join(__dirname, '..', 'router');
  const env = { ...process.env, ROUTER_PORT: String(TEST_PORT) };
  delete env.ROUTER_ADMIN_TOKEN;
  const child = spawn(process.execPath, ['server.js'], { cwd: routerDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  let lastErr;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const probe = await httpGet(`http://127.0.0.1:${TEST_PORT}/api/health`);
      if (probe.status === 200) {
        ready = true;
        break;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  assert.ok(ready, lastErr ? String(lastErr.message || lastErr) : 'router did not become ready');

  const t0 = Date.now();
  const r = await httpGet(`http://127.0.0.1:${TEST_PORT}/api/health`);
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(typeof j.status, 'string');
  assert.ok(['healthy', 'degraded'].includes(j.status));
  assert.strictEqual(j.ollama_host, 'localhost');
  assert.strictEqual(j.ollama_port, 11434);
  assert.ok(typeof j.router_listen === 'string' && j.router_listen.includes(':'));
  assert.ok(elapsed < HEALTH_MAX_MS, `single /api/health round-trip took ${elapsed}ms (max ${HEALTH_MAX_MS}ms)`);
});

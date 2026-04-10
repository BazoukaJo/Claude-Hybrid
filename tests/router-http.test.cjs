'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const TEST_PORT = Number.parseInt(process.env.TEST_ROUTER_PORT || '20937', 10);

function httpRequest(method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
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

test('router HTTP: model-status JSON shape and query path', async (t) => {
  const routerDir = path.join(__dirname, '..', 'router');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: routerDir,
    env: { ...process.env, ROUTER_PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += String(c); });
  child.stdout.on('data', (c) => { stderr += String(c); });

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
    const r = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/logs`);
    return r.status === 200;
  });

  const stats = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/stats`);
  assert.strictEqual(stats.status, 200);
  const stj = JSON.parse(stats.body);
  assert.ok(stj.counters);
  assert.strictEqual(typeof stj.counters.requests_total, 'number');
  assert.ok(stj.config);
  assert.strictEqual(typeof stj.config.listenHost, 'string');
  assert.ok(['hybrid', 'cloud', 'local'].includes(stj.config.routing_mode));

  const ollamaModels = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/ollama-models`);
  assert.strictEqual(ollamaModels.status, 200);
  const om = JSON.parse(ollamaModels.body);
  assert.ok(Array.isArray(om.models));
  assert.strictEqual(typeof om.configured_model, 'string');
  assert.strictEqual(typeof om.ollama_reachable, 'boolean');
  assert.ok(Array.isArray(om.pool));
  assert.strictEqual(typeof om.smart_routing, 'boolean');
  assert.ok(Array.isArray(om.loaded_models));

  const status = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/model-status?probe=1`);
  assert.strictEqual(status.status, 200);
  const st = JSON.parse(status.body);
  assert.strictEqual(typeof st.loaded, 'boolean');
  assert.strictEqual(typeof st.configured_loaded, 'boolean');
  assert.strictEqual(st.loaded, st.configured_loaded);
  assert.ok(Array.isArray(st.loaded_list));
  for (const row of st.loaded_list) {
    assert.strictEqual(typeof row.name, 'string');
    assert.ok(row.name.length > 0);
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'size_vram'));
  }
  assert.strictEqual(typeof st.configured_model, 'string');
  assert.ok(st.configured_model.length > 0);
  assert.ok('context_max' in st);
  assert.ok('context_allocated' in st);
  assert.ok('request_num_ctx' in st);
  assert.ok('model' in st);
  assert.ok(Object.prototype.hasOwnProperty.call(st, 'card_specs'));
  assert.strictEqual(st.loaded ? typeof st.card_specs === 'object' && st.card_specs !== null : st.card_specs === null, true);
  assert.ok(st.capabilities && typeof st.capabilities === 'object');
  assert.ok('has_reasoning' in st.capabilities);
  assert.ok('has_vision' in st.capabilities);
  assert.ok('has_tools' in st.capabilities);

  const details = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/router/model-details`);
  assert.strictEqual(details.status, 200);
  const det = JSON.parse(details.body);
  assert.strictEqual(typeof det.model, 'string');
  assert.ok(det.router_request_options);
  assert.strictEqual(typeof det.router_request_options.num_ctx, 'number');

  const params = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/model-params`);
  assert.strictEqual(params.status, 200);
  const pr = JSON.parse(params.body);
  assert.strictEqual(typeof pr.temperature, 'number');
  assert.strictEqual(typeof pr.num_ctx, 'number');

  const full = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/api/model-params-full`);
  assert.strictEqual(full.status, 200);
  const pf = JSON.parse(full.body);
  assert.ok(Array.isArray(pf.param_keys));
  assert.strictEqual(typeof pf.global, 'object');
  assert.strictEqual(typeof pf.built_in, 'object');
  assert.strictEqual(typeof pf.preset_patch, 'object');
  assert.strictEqual(typeof pf.effective, 'object');
  assert.strictEqual(typeof pf.active_model, 'string');
  assert.ok('per_model_patch' in pf);

  const bad = await httpRequest('POST', `http://127.0.0.1:${TEST_PORT}/v1/messages`, 'not-json{');
  assert.strictEqual(bad.status, 400);

  const root = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/`);
  assert.strictEqual(root.status, 200);
  assert.ok(root.body.includes('Claude Hybrid') || root.body.includes('model-card'));

  const odCss = await httpRequest('GET', `http://127.0.0.1:${TEST_PORT}/assets/ollama-dashboard-model-card.css`);
  assert.strictEqual(odCss.status, 200);
  assert.ok(odCss.body.includes('model-cards-row'));
});

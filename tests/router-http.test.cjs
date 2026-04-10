"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const TEST_PORT = Number.parseInt(process.env.TEST_ROUTER_PORT || "20937", 10);

function httpRequest(method, urlStr, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: body
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          }
        : {},
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
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
  throw new Error(
    lastErr ? String(lastErr.message || lastErr) : "waitFor timeout",
  );
}

function spawnRouter(routerDir, env = {}) {
  return spawn(process.execPath, ["server.js"], {
    cwd: routerDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createMockOllamaServer() {
  const state = {
    phase: "alpha-loaded",
    switchStartedAt: 0,
    loadingTarget: "",
  };
  const tags = [
    { name: "alpha:latest", size: 7_000_000_000, digest: "sha256:alpha" },
    { name: "beta:latest", size: 26_000_000_000, digest: "sha256:beta" },
  ];
  const showFor = (model) => ({
    model,
    details: {
      family: model.startsWith("beta") ? "llama" : "gemma",
      parameter_size: model.startsWith("beta") ? "26B" : "7B",
      capabilities: ["tools"],
    },
    model_info: {
      "general.architecture": model.startsWith("beta") ? "llama" : "gemma",
      "general.parameter_count": model.startsWith("beta")
        ? 26_000_000_000
        : 7_000_000_000,
    },
    context_length: model.startsWith("beta") ? 262144 : 131072,
  });
  const syncPhase = () => {
    if (
      state.phase === "beta-loading" &&
      Date.now() - state.switchStartedAt >= 900
    ) {
      state.phase = "beta-loaded";
    }
  };
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    syncPhase();
    if (req.method === "GET" && req.url === "/api/version") {
      send(200, { version: "0.0.0-test" });
      return;
    }
    if (req.method === "GET" && req.url === "/api/tags") {
      send(200, { models: tags });
      return;
    }
    if (req.method === "GET" && req.url === "/api/ps") {
      if (state.phase === "alpha-loaded") {
        send(200, {
          models: [
            {
              name: "alpha:latest",
              model: "alpha:latest",
              size: 7_000_000_000,
              size_vram: 4_000_000_000,
              details: { family: "gemma", parameter_size: "7B" },
              context_length: 131072,
            },
          ],
        });
        return;
      }
      if (state.phase === "beta-loading") {
        send(200, {
          models: [
            {
              name: "alpha:latest",
              model: "alpha:latest",
              size: 7_000_000_000,
              size_vram: 4_000_000_000,
              details: { family: "gemma", parameter_size: "7B" },
              context_length: 131072,
            },
          ],
        });
        return;
      }
      send(200, {
        models: [
          {
            name: "beta:latest",
            model: "beta:latest",
            size: 26_000_000_000,
            size_vram: 16_000_000_000,
            details: { family: "llama", parameter_size: "26B" },
            context_length: 262144,
          },
        ],
      });
      return;
    }
    if (
      req.method === "POST" &&
      (req.url === "/api/show" || req.url === "/api/generate")
    ) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {}
        if (req.url === "/api/show") {
          send(200, showFor(String(body.model || "alpha:latest")));
          return;
        }
        if (body.keep_alive === -1) {
          state.phase = "beta-loading";
          state.loadingTarget = String(body.model || "");
          state.switchStartedAt = Date.now();
        } else if (body.keep_alive === 0) {
          state.phase = "alpha-loaded";
          state.loadingTarget = "";
          state.switchStartedAt = 0;
        }
        send(200, { response: "", done: true, model: body.model || null });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  return { server, state };
}

test("router HTTP: model-status JSON shape and query path", async (t) => {
  const routerDir = path.join(__dirname, "..", "router");
  const child = spawnRouter(routerDir, {
    ...process.env,
    ROUTER_PORT: String(TEST_PORT),
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  child.stdout.on("data", (c) => {
    stderr += String(c);
  });

  t.after(() => {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
    const kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }, 2000);
    kill.unref();
  });

  await waitFor(async () => {
    const r = await httpRequest(
      "GET",
      `http://127.0.0.1:${TEST_PORT}/api/logs`,
    );
    return r.status === 200;
  });

  const stats = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/api/stats`,
  );
  assert.strictEqual(stats.status, 200);
  const stj = JSON.parse(stats.body);
  assert.ok(stj.counters);
  assert.strictEqual(typeof stj.counters.requests_total, "number");
  assert.ok(stj.cloud_quota && typeof stj.cloud_quota === "object");
  assert.strictEqual(typeof stj.cloud_quota.exceeded, "boolean");
  assert.strictEqual(typeof stj.cloud_quota.message, "string");
  assert.ok(Array.isArray(stj.cloud_quota.disabled_modes));
  assert.ok(stj.config);
  assert.strictEqual(typeof stj.config.listenHost, "string");
  assert.ok(["hybrid", "cloud", "local"].includes(stj.config.routing_mode));

  const ollamaModels = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/api/ollama-models`,
  );
  assert.strictEqual(ollamaModels.status, 200);
  const om = JSON.parse(ollamaModels.body);
  assert.ok(Array.isArray(om.models));
  assert.strictEqual(typeof om.configured_model, "string");
  assert.strictEqual(typeof om.ollama_reachable, "boolean");
  assert.ok(Array.isArray(om.pool));
  assert.strictEqual(typeof om.smart_routing, "boolean");
  assert.ok(Array.isArray(om.loaded_models));

  const status = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/api/model-status?probe=1`,
  );
  assert.strictEqual(status.status, 200);
  const st = JSON.parse(status.body);
  assert.strictEqual(typeof st.loaded, "boolean");
  assert.strictEqual(typeof st.configured_loaded, "boolean");
  assert.strictEqual(st.loaded, st.configured_loaded);
  assert.ok(Array.isArray(st.loaded_list));
  for (const row of st.loaded_list) {
    assert.strictEqual(typeof row.name, "string");
    assert.ok(row.name.length > 0);
    assert.ok(Object.prototype.hasOwnProperty.call(row, "size_vram"));
  }
  assert.ok(Array.isArray(st.pool_models));
  for (const row of st.pool_models) {
    assert.strictEqual(typeof row.name, "string");
    assert.ok(Object.prototype.hasOwnProperty.call(row, "card_specs"));
    assert.ok(Object.prototype.hasOwnProperty.call(row, "capabilities"));
    assert.ok(Object.prototype.hasOwnProperty.call(row, "request_num_ctx"));
  }
  assert.strictEqual(typeof st.configured_model, "string");
  assert.ok(st.configured_model.length > 0);
  assert.ok("context_max" in st);
  assert.ok("context_allocated" in st);
  assert.ok("request_num_ctx" in st);
  assert.ok("model" in st);
  assert.ok(Object.prototype.hasOwnProperty.call(st, "card_specs"));
  assert.strictEqual(
    st.loaded
      ? typeof st.card_specs === "object" && st.card_specs !== null
      : st.card_specs === null,
    true,
  );
  assert.ok(st.capabilities && typeof st.capabilities === "object");
  assert.ok("has_reasoning" in st.capabilities);
  assert.ok("has_vision" in st.capabilities);
  assert.ok("has_tools" in st.capabilities);

  const details = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/api/router/model-details`,
  );
  assert.strictEqual(details.status, 200);
  const det = JSON.parse(details.body);
  assert.strictEqual(typeof det.model, "string");
  assert.ok(det.router_request_options);
  assert.strictEqual(typeof det.router_request_options.num_ctx, "number");

  const params = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/api/model-params`,
  );
  assert.strictEqual(params.status, 200);
  const pr = JSON.parse(params.body);
  assert.strictEqual(typeof pr.temperature, "number");
  assert.strictEqual(typeof pr.num_ctx, "number");

  const full = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/api/model-params-full`,
  );
  assert.strictEqual(full.status, 200);
  const pf = JSON.parse(full.body);
  assert.ok(Array.isArray(pf.param_keys));
  assert.strictEqual(typeof pf.global, "object");
  assert.strictEqual(typeof pf.built_in, "object");
  assert.strictEqual(typeof pf.preset_patch, "object");
  assert.strictEqual(typeof pf.effective, "object");
  assert.strictEqual(typeof pf.active_model, "string");
  assert.ok("per_model_patch" in pf);

  const fullForConfigured = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/api/model-params-full?model=${encodeURIComponent(st.configured_model)}`,
  );
  assert.strictEqual(fullForConfigured.status, 200);
  const pfc = JSON.parse(fullForConfigured.body);
  assert.strictEqual(pfc.active_model, st.configured_model);
  assert.strictEqual(typeof pfc.loaded, "boolean");

  const bad = await httpRequest(
    "POST",
    `http://127.0.0.1:${TEST_PORT}/v1/messages`,
    "not-json{",
  );
  assert.strictEqual(bad.status, 400);

  const root = await httpRequest("GET", `http://127.0.0.1:${TEST_PORT}/`);
  assert.strictEqual(root.status, 200);
  assert.ok(
    root.body.includes("Claude Hybrid") || root.body.includes("model-card"),
  );

  const odCss = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT}/assets/ollama-dashboard-model-card.css`,
  );
  assert.strictEqual(odCss.status, 200);
  assert.ok(odCss.body.includes("model-cards-row"));
});

test("router HTTP: local-model switch stays non-error while new model is still loading", async (t) => {
  const routerDir = path.join(__dirname, "..", "router");
  const tmpCfg = path.join(
    os.tmpdir(),
    `hybrid-switch-test-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(
    tmpCfg,
    `${JSON.stringify({
      local: {
        model: "alpha:latest",
        models: ["alpha:latest", "beta:latest"],
        smart_routing: true,
        fast_model: "",
      },
      routing: { mode: "local" },
    })}\n`,
    "utf8",
  );

  const mock = createMockOllamaServer();
  await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.server.address().port;

  const child = spawnRouter(routerDir, {
    ...process.env,
    ROUTER_PORT: String(TEST_PORT + 1),
    ROUTER_HYBRID_CONFIG: tmpCfg,
    ROUTER_OLLAMA_HOST: "127.0.0.1",
    ROUTER_OLLAMA_PORT: String(mockPort),
  });

  t.after(() => {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
    const kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }, 2000);
    kill.unref();
    try {
      mock.server.close();
    } catch (_) {}
    try {
      fs.unlinkSync(tmpCfg);
    } catch (_) {}
  });

  await waitFor(async () => {
    const r = await httpRequest(
      "GET",
      `http://127.0.0.1:${TEST_PORT + 1}/api/health`,
    );
    return r.status === 200;
  });

  const switchResp = await httpRequest(
    "POST",
    `http://127.0.0.1:${TEST_PORT + 1}/api/local-model`,
    JSON.stringify({ model: "beta:latest" }),
  );
  assert.strictEqual(switchResp.status, 200, switchResp.body);
  const switchJson = JSON.parse(switchResp.body);
  assert.strictEqual(switchJson.ok, true);
  assert.strictEqual(switchJson.model, "beta:latest");

  const startResp = await httpRequest(
    "POST",
    `http://127.0.0.1:${TEST_PORT + 1}/api/router/model/start`,
    JSON.stringify({}),
  );
  assert.strictEqual(startResp.status, 200, startResp.body);

  const duringLoad = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT + 1}/api/model-status?probe=switch`,
  );
  assert.strictEqual(duringLoad.status, 200, duringLoad.body);
  const during = JSON.parse(duringLoad.body);
  assert.strictEqual(during.configured_model, "beta:latest");
  assert.strictEqual(during.active_model, "beta:latest");
  assert.strictEqual(during.loaded, false);
  assert.strictEqual(during.configured_loaded, false);
  assert.ok(!("error" in during), during.body);
  assert.ok(Array.isArray(during.loaded_list));
  assert.ok(
    during.loaded_list.some((row) => row.name === "alpha:latest"),
    `expected old model to still be visible during load: ${duringLoad.body}`,
  );

  await waitFor(
    async () => {
      const r = await httpRequest(
        "GET",
        `http://127.0.0.1:${TEST_PORT + 1}/api/model-status?probe=loaded`,
      );
      if (r.status !== 200) return false;
      const j = JSON.parse(r.body);
      return j.loaded === true && j.active_model === "beta:latest";
    },
    { timeout: 5000, interval: 150 },
  );

  const loadedResp = await httpRequest(
    "GET",
    `http://127.0.0.1:${TEST_PORT + 1}/api/model-status?probe=loaded-final`,
  );
  assert.strictEqual(loadedResp.status, 200, loadedResp.body);
  const loaded = JSON.parse(loadedResp.body);
  assert.strictEqual(loaded.configured_model, "beta:latest");
  assert.strictEqual(loaded.active_model, "beta:latest");
  assert.strictEqual(loaded.loaded, true);
  assert.strictEqual(loaded.configured_loaded, true);
  assert.ok(!("error" in loaded), loadedResp.body);
});

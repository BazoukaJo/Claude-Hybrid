"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function httpRequest(method, urlStr, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body == null ? null : Buffer.from(body);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(data
          ? {
              "Content-Type": "application/json",
              "Content-Length": data.length,
            }
          : {}),
        ...headers,
      },
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
    if (data) req.write(data);
    req.end();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close((err) => {
        if (err) return reject(err);
        resolve(p);
      });
    });
  });
}

async function waitFor(fn, { timeout = 12000, interval = 120 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error("waitFor timeout");
}

async function postJsonWithRetry(url, body, retries = 1) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await httpRequest("POST", url, body);
    } catch (err) {
      lastErr = err;
      if (!(err && err.code === "ECONNRESET") || i === retries) throw err;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  throw lastErr;
}

function spawnRouter(routerDir, env = {}) {
  return spawn(process.execPath, ["server.js"], {
    cwd: routerDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createMockCloudServer() {
  const state = {
    requests: [],
  };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {}
        state.requests.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_mock_cloud",
            type: "message",
            role: "assistant",
            model: body.model || "claude-mock",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return { server, state };
}

function createMockLocalOllamaServer() {
  const state = {
    requests: [],
  };
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/api/version") {
      send(200, { version: "0.0.0-test" });
      return;
    }
    if (req.method === "GET" && req.url === "/api/tags") {
      send(200, {
        models: [
          { name: "local:test", size: 1_000_000_000, digest: "sha256:x" },
        ],
      });
      return;
    }
    if (req.method === "GET" && req.url === "/api/ps") {
      send(200, {
        models: [
          {
            name: "local:test",
            model: "local:test",
            size: 1_000_000_000,
            size_vram: 700_000_000,
            details: { family: "tiny", parameter_size: "1B" },
            context_length: 8192,
          },
        ],
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/show") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        send(200, {
          model: "local:test",
          details: {
            family: "tiny",
            parameter_size: "1B",
            capabilities: ["tools"],
          },
          context_length: 8192,
        });
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {}
        state.requests.push(body);
        send(200, {
          id: "chatcmpl_local",
          object: "chat.completion",
          model: body.model || "local:test",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "ok" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  return { server, state };
}

test("privacy e2e: cloud-mode request is redacted before upstream send", async (t) => {
  const routerDir = path.join(__dirname, "..", "router");
  const routerPort = await getFreePort();
  const tmpCfg = path.join(
    os.tmpdir(),
    `hybrid-privacy-cloud-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(
    tmpCfg,
    `${JSON.stringify({
      routing: { mode: "cloud" },
      privacy: {
        cloud_redaction: {
          enabled: true,
          redact_tool_results: true,
          redact_paths: true,
          redact_urls: true,
          redact_emails: true,
          redact_secrets: true,
          redact_ids: true,
          redact_identifiers: false,
          custom_terms: ["AcmeProject", "internalWidget"],
        },
      },
    })}\n`,
    "utf8",
  );

  const mockCloud = createMockCloudServer();
  await new Promise((resolve) =>
    mockCloud.server.listen(0, "127.0.0.1", resolve),
  );
  const cloudPort = mockCloud.server.address().port;

  const child = spawnRouter(routerDir, {
    ...process.env,
    ROUTER_PORT: String(routerPort),
    ROUTER_HYBRID_CONFIG: tmpCfg,
    ROUTER_CLOUD_PROTOCOL: "http",
    ROUTER_CLOUD_HOST: "127.0.0.1",
    ROUTER_CLOUD_PORT: String(cloudPort),
  });

  t.after(() => {
    try {
      child.kill("SIGTERM");
    } catch {}
    const kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 1500);
    kill.unref();
    try {
      mockCloud.server.close();
    } catch {}
    try {
      fs.unlinkSync(tmpCfg);
    } catch {}
  });

  await waitFor(async () => {
    const r = await httpRequest(
      "GET",
      `http://127.0.0.1:${routerPort}/api/stats`,
    );
    return r.status === 200;
  });

  const requestBody = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 120,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "AcmeProject uses internalWidget. email me at dev@acme.local, open https://internal.acme.local, path C:\\Acme\\Secret\\app.js, token=sk-supersecretsecret, id 123e4567-e89b-12d3-a456-426614174000",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: {
              file: "/srv/acme/private/config.json",
              note: "AcmeProject internalWidget",
            },
          },
        ],
      },
    ],
  };

  const routed = await postJsonWithRetry(
    `http://127.0.0.1:${routerPort}/v1/messages`,
    JSON.stringify(requestBody),
    1,
  );
  assert.strictEqual(routed.status, 200, routed.body);
  const routedJson = JSON.parse(routed.body || "{}");
  assert.strictEqual(routedJson.id, "msg_mock_cloud", routed.body);
  assert.ok(
    mockCloud.state.requests.length > 0,
    "mock cloud should receive the forwarded request",
  );
  const forwarded = mockCloud.state.requests[0];
  assert.strictEqual(forwarded.model, requestBody.model);
  const payload = JSON.stringify(forwarded);

  assert.ok(payload.includes("TERM_"), payload);
  assert.ok(payload.includes("EMAIL_"), payload);
  assert.ok(payload.includes("URL_"), payload);
  assert.ok(payload.includes("PATH_"), payload);
  assert.ok(payload.includes("SECRET_"), payload);
  assert.ok(payload.includes("ID_"), payload);

  assert.ok(!payload.includes("AcmeProject"), payload);
  assert.ok(!payload.includes("internalWidget"), payload);
  assert.ok(!payload.includes("dev@acme.local"), payload);
  assert.ok(!payload.includes("internal.acme.local"), payload);
  assert.ok(!payload.includes("C:\\\\Acme\\\\Secret"), payload);
  assert.ok(!payload.includes("123e4567-e89b-12d3-a456-426614174000"), payload);
});

test("privacy e2e: local-mode request is not redacted before Ollama send", async (t) => {
  const routerDir = path.join(__dirname, "..", "router");
  const routerPort = await getFreePort();
  const tmpCfg = path.join(
    os.tmpdir(),
    `hybrid-privacy-local-${process.pid}-${Date.now()}.json`,
  );
  fs.writeFileSync(
    tmpCfg,
    `${JSON.stringify({
      local: {
        model: "local:test",
        models: ["local:test"],
        smart_routing: false,
        fast_model: "",
      },
      routing: { mode: "local" },
      privacy: {
        cloud_redaction: {
          enabled: true,
          custom_terms: ["AcmeProject"],
          redact_tool_results: true,
          redact_paths: true,
          redact_urls: true,
          redact_emails: true,
          redact_secrets: true,
          redact_ids: true,
          redact_identifiers: false,
        },
      },
    })}\n`,
    "utf8",
  );

  const mockOllama = createMockLocalOllamaServer();
  await new Promise((resolve) =>
    mockOllama.server.listen(0, "127.0.0.1", resolve),
  );
  const ollamaPort = mockOllama.server.address().port;

  const child = spawnRouter(routerDir, {
    ...process.env,
    ROUTER_PORT: String(routerPort),
    ROUTER_HYBRID_CONFIG: tmpCfg,
    ROUTER_OLLAMA_HOST: "127.0.0.1",
    ROUTER_OLLAMA_PORT: String(ollamaPort),
  });

  t.after(() => {
    try {
      child.kill("SIGTERM");
    } catch {}
    const kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 1500);
    kill.unref();
    try {
      mockOllama.server.close();
    } catch {}
    try {
      fs.unlinkSync(tmpCfg);
    } catch {}
  });

  await waitFor(async () => {
    const r = await httpRequest(
      "GET",
      `http://127.0.0.1:${routerPort}/api/health`,
    );
    return r.status === 200;
  });

  const plainSecret = "token=sk-localnonredactedsecret";
  const plainTerm = "AcmeProject";
  const requestBody = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 120,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${plainTerm} local path C:\\Acme\\Secret\\a.js ${plainSecret}`,
          },
        ],
      },
    ],
  };

  const routed = await httpRequest(
    "POST",
    `http://127.0.0.1:${routerPort}/v1/messages`,
    JSON.stringify(requestBody),
  );
  assert.strictEqual(routed.status, 200, routed.body);

  await waitFor(() => mockOllama.state.requests.length > 0, {
    timeout: 3000,
    interval: 80,
  });
  const ollamaReq = mockOllama.state.requests[0];
  const payload = JSON.stringify(ollamaReq);

  assert.ok(payload.includes(plainSecret), payload);
  assert.ok(payload.includes(plainTerm), payload);
  assert.ok(payload.includes("C:\\\\Acme\\\\Secret\\\\a.js"), payload);
  assert.ok(!payload.includes("SECRET_"), payload);
  assert.ok(!payload.includes("TERM_"), payload);
  assert.ok(!payload.includes("PATH_"), payload);
});

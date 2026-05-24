"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseCloudTarget,
  isKitRouterUrl,
  isCustomAnthropicUrl,
  isDefaultCloudTarget,
  resolveCloudUpstream,
  syncCloudUpstreamToConfig,
  prepareCloudUpstream,
  applyCloudConfig,
  describeRoutingMode,
  PREV_BASE_URL_KEY,
} = require("../scripts/lib/cloud-upstream.js");
const { loadAndApply } = require("../router/lib/hybrid-config.js");

function tempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const routerDir = path.join(dir, "router");
  fs.mkdirSync(routerDir, { recursive: true });
  return { dir, routerDir };
}

test("parseCloudTarget parses https corporate proxy URL", () => {
  const t = parseCloudTarget("https://ai.leihuo.netease.com/");
  assert.equal(t.protocol, "https");
  assert.equal(t.host, "ai.leihuo.netease.com");
  assert.equal(t.port, 443);
});

test("isKitRouterUrl recognizes local router URLs", () => {
  assert.equal(isKitRouterUrl("http://127.0.0.1:8082", "8082"), true);
  assert.equal(isKitRouterUrl("http://127.0.0.1:8082/", "8082"), true);
  assert.equal(isKitRouterUrl("https://ai.leihuo.netease.com/", "8082"), false);
});

test("isCustomAnthropicUrl accepts external proxy only", () => {
  assert.equal(isCustomAnthropicUrl("https://ai.leihuo.netease.com/", "8082"), true);
  assert.equal(isCustomAnthropicUrl("http://127.0.0.1:8082", "8082"), false);
});

test("resolveCloudUpstream prefers ROUTER_CLOUD_HOST env", () => {
  const upstream = resolveCloudUpstream({
    env: {
      ROUTER_CLOUD_HOST: "proxy.example.com",
      ROUTER_CLOUD_PROTOCOL: "https",
      ROUTER_CLOUD_PORT: "443",
    },
    repoRoot: os.tmpdir(),
  });
  assert.equal(upstream.host, "proxy.example.com");
  assert.equal(upstream.source, "env");
});

test("resolveCloudUpstream reads hybrid.config.json cloud section", () => {
  const { dir, routerDir } = tempRepo("cloud-upstream-");
  fs.writeFileSync(
    path.join(routerDir, "hybrid.config.json"),
    `${JSON.stringify(
      {
        cloud: { base_url: "https://ai.leihuo.netease.com/" },
      },
      null,
      2,
    )}\n`,
  );
  const upstream = resolveCloudUpstream({
    env: {},
    repoRoot: dir,
    routerDir,
  });
  assert.equal(upstream.host, "ai.leihuo.netease.com");
  assert.equal(upstream.source, "hybrid.config.json");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveCloudUpstream uses current custom ANTHROPIC_BASE_URL from env", () => {
  const upstream = resolveCloudUpstream({
    env: { ANTHROPIC_BASE_URL: "https://ai.leihuo.netease.com/" },
    settingsEnv: {},
    getUserEnv: () => "",
    repoRoot: os.tmpdir(),
    routerDir: path.join(os.tmpdir(), "missing-router-dir"),
  });
  assert.equal(upstream.host, "ai.leihuo.netease.com");
  assert.equal(upstream.source, "current-custom-client-url");
});

test("resolveCloudUpstream prefers saved previous client URL over current env", () => {
  const upstream = resolveCloudUpstream({
    env: { ANTHROPIC_BASE_URL: "https://other.example.com/" },
    settingsEnv: {
      [PREV_BASE_URL_KEY]: "https://ai.leihuo.netease.com/",
    },
    getUserEnv: () => "",
    repoRoot: os.tmpdir(),
    routerDir: path.join(os.tmpdir(), "missing-router-dir"),
  });
  assert.equal(upstream.host, "ai.leihuo.netease.com");
  assert.equal(upstream.source, "saved-previous-client-url");
});

test("prepareCloudUpstream action: custom client URL writes cloud section and keeps local config", () => {
  const { dir, routerDir } = tempRepo("cloud-prepare-");
  fs.writeFileSync(
    path.join(routerDir, "hybrid.config.json"),
    `${JSON.stringify(
      {
        local: { model: "gemma4:26b", smart_routing: true },
        routing: { mode: "hybrid" },
      },
      null,
      2,
    )}\n`,
  );

  const upstream = prepareCloudUpstream(dir, {
    env: { ANTHROPIC_BASE_URL: "https://ai.leihuo.netease.com/" },
    settingsEnv: {},
    getUserEnv: () => "",
  });

  assert.equal(upstream.host, "ai.leihuo.netease.com");
  assert.equal(upstream.source, "current-custom-client-url");

  const saved = JSON.parse(
    fs.readFileSync(path.join(routerDir, "hybrid.config.json"), "utf8"),
  );
  assert.equal(saved.cloud.host, "ai.leihuo.netease.com");
  assert.equal(saved.local.model, "gemma4:26b");
  assert.equal(saved.routing.mode, "hybrid");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("prepareCloudUpstream action: default Anthropic does not write cloud section", () => {
  const { dir, routerDir } = tempRepo("cloud-default-");
  fs.writeFileSync(
    path.join(routerDir, "hybrid.config.json"),
    `${JSON.stringify({ routing: { mode: "hybrid" } }, null, 2)}\n`,
  );

  const upstream = prepareCloudUpstream(dir, {
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8082" },
    settingsEnv: {},
    getUserEnv: () => "",
  });

  assert.equal(isDefaultCloudTarget(upstream), true);
  assert.equal(upstream.source, "default");

  const saved = JSON.parse(
    fs.readFileSync(path.join(routerDir, "hybrid.config.json"), "utf8"),
  );
  assert.equal(saved.cloud, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("syncCloudUpstreamToConfig is idempotent on repeated writes", () => {
  const { dir, routerDir } = tempRepo("cloud-sync-");
  const upstream = {
    protocol: "https",
    host: "ai.leihuo.netease.com",
    port: 443,
    base_url: "https://ai.leihuo.netease.com",
  };
  assert.equal(syncCloudUpstreamToConfig(routerDir, upstream), true);
  assert.equal(syncCloudUpstreamToConfig(routerDir, upstream), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("applyCloudConfig updates CFG.cloud from file when env unset", () => {
  const CFG = { cloud: { protocol: "https", host: "api.anthropic.com", port: 443 } };
  applyCloudConfig(CFG, {
    cloud: { base_url: "https://ai.leihuo.netease.com/" },
  });
  assert.equal(CFG.cloud.host, "ai.leihuo.netease.com");
});

test("applyCloudConfig action: ROUTER_CLOUD_HOST env overrides hybrid.config.json", () => {
  const prevHost = process.env.ROUTER_CLOUD_HOST;
  process.env.ROUTER_CLOUD_HOST = "env-proxy.example.com";
  try {
    const CFG = { cloud: { protocol: "https", host: "api.anthropic.com", port: 443 } };
    applyCloudConfig(CFG, {
      cloud: { base_url: "https://ai.leihuo.netease.com/" },
    });
    assert.equal(CFG.cloud.host, "api.anthropic.com");
  } finally {
    if (prevHost == null) delete process.env.ROUTER_CLOUD_HOST;
    else process.env.ROUTER_CLOUD_HOST = prevHost;
  }
});

test("loadAndApply action: applies cloud upstream from hybrid.config.json", () => {
  const { dir, routerDir } = tempRepo("cloud-load-");
  const configPath = path.join(routerDir, "hybrid.config.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        cloud: { base_url: "https://ai.leihuo.netease.com/" },
        routing: { mode: "hybrid", quotaRecoveryMinutes: 45 },
      },
      null,
      2,
    )}\n`,
  );

  const prevConfig = process.env.ROUTER_HYBRID_CONFIG;
  const prevCloudHost = process.env.ROUTER_CLOUD_HOST;
  delete process.env.ROUTER_CLOUD_HOST;
  process.env.ROUTER_HYBRID_CONFIG = configPath;
  try {
    const CFG = {
      cloud: { protocol: "https", host: "api.anthropic.com", port: 443 },
      routing: { mode: "hybrid", quotaRecoveryMinutes: 60 },
      local: { model: "devstral:latest" },
      display: {},
    };
    loadAndApply(CFG, routerDir);
    assert.equal(CFG.cloud.host, "ai.leihuo.netease.com");
    assert.equal(CFG.routing.quotaRecoveryMinutes, 45);
  } finally {
    if (prevConfig == null) delete process.env.ROUTER_HYBRID_CONFIG;
    else process.env.ROUTER_HYBRID_CONFIG = prevConfig;
    if (prevCloudHost == null) delete process.env.ROUTER_CLOUD_HOST;
    else process.env.ROUTER_CLOUD_HOST = prevCloudHost;
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test("describeRoutingMode covers hybrid and direct paths", () => {
  assert.equal(
    describeRoutingMode("http://127.0.0.1:8082", "8082", true),
    "hybrid-active",
  );
  assert.equal(
    describeRoutingMode("http://127.0.0.1:8082", "8082", false),
    "hybrid-misconfigured-router-down",
  );
  assert.equal(
    describeRoutingMode("https://ai.leihuo.netease.com/", "8082", false),
    "direct-proxy",
  );
  assert.equal(
    describeRoutingMode("https://ai.leihuo.netease.com/", "8082", true),
    "direct-proxy-bypasses-router",
  );
});

test("PREV_BASE_URL_KEY is exported for merge-env restore contract", () => {
  assert.equal(PREV_BASE_URL_KEY, "CLAUDE_HYBRID_PREV_ANTHROPIC_BASE_URL");
});

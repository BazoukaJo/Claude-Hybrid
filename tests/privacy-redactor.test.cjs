"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  normalizeCloudRedactionConfig,
  redactCloudRequestBody,
} = require("../router/lib/privacy-redactor");

test("normalizeCloudRedactionConfig: fills defaults", () => {
  const cfg = normalizeCloudRedactionConfig({
    enabled: true,
    custom_terms: ["Foo"],
  });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.redact_tool_results, true);
  assert.strictEqual(cfg.redact_identifiers, false);
  assert.deepStrictEqual(cfg.custom_terms, ["Foo"]);
});

test("redactCloudRequestBody: disabled config leaves body untouched", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ],
  };
  const out = redactCloudRequestBody(body, { enabled: false });
  assert.strictEqual(out.changed, false);
  assert.strictEqual(out.body, body);
  assert.strictEqual(out.redactions, 0);
});

test("redactCloudRequestBody: redacts secrets urls emails paths ids and custom terms", () => {
  const body = {
    system: "Project Falcon should stay private.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Email ops@falcon.dev and open https://internal.example.com in C:\\Secret\\Falcon\\app.js using token=sk-secretsecretsecret and id 123e4567-e89b-12d3-a456-426614174000",
          },
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: {
              path: "/srv/Falcon/private/config.json",
              note: "FalconService handles this request.",
            },
          },
        ],
      },
    ],
  };
  const out = redactCloudRequestBody(body, {
    enabled: true,
    custom_terms: ["Falcon", "FalconService"],
    redact_identifiers: false,
  });
  assert.strictEqual(out.changed, true);
  assert.ok(out.redactions >= 6);
  const payload = JSON.stringify(out.body);
  assert.ok(payload.includes("TERM_"), payload);
  assert.ok(payload.includes("EMAIL_"), payload);
  assert.ok(payload.includes("URL_"), payload);
  assert.ok(payload.includes("PATH_"), payload);
  assert.ok(payload.includes("SECRET_"), payload);
  assert.ok(payload.includes("ID_"), payload);
  assert.ok(!payload.includes("ops@falcon.dev"), payload);
  assert.ok(!payload.includes("https://internal.example.com"), payload);
  assert.ok(!payload.includes("C:\\\\Secret\\\\Falcon\\\\app.js"), payload);
  assert.ok(!payload.includes("FalconService"), payload);
});

test("redactCloudRequestBody: identifier redaction is opt-in and stable", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Check doSecretWork and SecretController plus secret_handler for this bug. doSecretWork appears twice: doSecretWork",
          },
        ],
      },
    ],
  };
  const out = redactCloudRequestBody(body, {
    enabled: true,
    redact_identifiers: true,
  });
  const payload = JSON.stringify(out.body);
  assert.ok(payload.includes("IDENT_1"), payload);
  assert.ok(payload.includes("IDENT_2"), payload);
  assert.ok(payload.includes("IDENT_3"), payload);
  const matches = payload.match(/IDENT_1/g) || [];
  assert.ok(matches.length >= 2, payload);
});

test("redactCloudRequestBody: tool_result redaction can be disabled", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content:
              "Path /srv/secret/file.txt and FalconService should remain here.",
          },
        ],
      },
    ],
  };
  const out = redactCloudRequestBody(body, {
    enabled: true,
    custom_terms: ["FalconService"],
    redact_tool_results: false,
  });
  assert.strictEqual(out.changed, false);
  assert.strictEqual(
    out.body.messages[0].content[0].content,
    body.messages[0].content[0].content,
  );
});

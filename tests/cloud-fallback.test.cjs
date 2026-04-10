"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  getCloudLimitFeedback,
  isCloudLimitResponse,
} = require("../router/lib/cloud-fallback");

test("cloud fallback: detects standard JSON quota responses", () => {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: "You've hit your limit · resets 3pm (America/Toronto)",
    },
  });
  assert.strictEqual(isCloudLimitResponse(429, body, "application/json"), true);
  assert.strictEqual(
    getCloudLimitFeedback(429, body, "application/json"),
    "You've hit your limit · resets 3pm (America/Toronto)",
  );
});

test("cloud fallback: detects SSE error payloads carrying limit text", () => {
  const body = [
    "event: error",
    'data: {"type":"error","error":{"type":"rate_limit_error","message":"You have hit your limit for today"}}',
    "",
  ].join("\n");
  assert.strictEqual(
    isCloudLimitResponse(200, body, "text/event-stream"),
    true,
  );
});

test("cloud fallback: detects Claude Code smart-apostrophe quota message", () => {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message:
        "You’ve hit your limit for Claude messages. Limits will reset at 3:00 PM.",
    },
  });
  assert.strictEqual(isCloudLimitResponse(429, body, "application/json"), true);
  assert.strictEqual(
    getCloudLimitFeedback(429, body, "application/json"),
    "You’ve hit your limit for Claude messages. Limits will reset at 3:00 PM.",
  );
});

test("cloud fallback: treats bare HTTP 429 as quota for local fallback", () => {
  assert.strictEqual(isCloudLimitResponse(429, "{}", "application/json"), true);
  assert.match(
    getCloudLimitFeedback(429, "{}", "application/json"),
    /429/,
  );
});

test("cloud fallback: detects rate_limit_error without English limit phrase", () => {
  const body = JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "" },
  });
  assert.strictEqual(isCloudLimitResponse(400, body, "application/json"), true);
});

test("cloud fallback: ignores normal SSE assistant content", () => {
  const body = [
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Rate limit guidance for APIs"}}',
    "",
  ].join("\n");
  assert.strictEqual(
    isCloudLimitResponse(200, body, "text/event-stream"),
    false,
  );
});

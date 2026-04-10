"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  analyzeMessages,
  normalizeRoutingMode,
} = require("../router/lib/routing-logic");

const ROUTING = {
  tokenThreshold: 5000,
  fileReadThreshold: 7,
  keywords: ["system design", "deep reason", "audit", "performance optim"],
};

test("last user text only: local despite many historical tool_results", () => {
  const messages = [];
  for (let i = 0; i < 5; i++) {
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `t${i}a`, content: "x" },
        { type: "tool_result", tool_use_id: `t${i}b`, content: "y" },
      ],
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: "thanks" }],
  });
  const r = analyzeMessages({ messages }, ROUTING);
  assert.strictEqual(r.dest, "local");
});

test("last user message with 8 tool_results: cloud", () => {
  const content = [];
  for (let i = 0; i < 8; i++) {
    content.push({
      type: "tool_result",
      tool_use_id: `id${i}`,
      content: "data",
    });
  }
  const r = analyzeMessages({ messages: [{ role: "user", content }] }, ROUTING);
  assert.strictEqual(r.dest, "cloud");
  assert.ok(r.reason.includes("tool results"));
});

test("keyword in last user text: cloud", () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Need system design help" }],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "cloud");
});

test("generic audit keyword stays local without stronger security context", () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Add audit logging for this endpoint response.",
            },
          ],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "local");
  assert.ok(r.reason.includes('generic keyword prompt "audit" stayed local'));
});

test("generic audit keyword still escalates with security context", () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please audit the authentication tokens and permissions flow.",
            },
          ],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "cloud");
  assert.ok(r.reason.includes('keyword "audit"'));
});

test("stemmed performance optim keyword still matches optimization phrasing", () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Need performance optimization advice for this API endpoint.",
            },
          ],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "cloud");
  assert.ok(r.reason.includes('keyword "performance optim"'));
});

test("concise keyword prompt stays local to save cloud cost", () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Give me a brief system design summary in one paragraph.",
            },
          ],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "local");
  assert.ok(r.reason.includes("concise keyword prompt"));
});

test("tiny prompt: local", () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "local");
});

test("normalizeRoutingMode accepts synonyms and defaults", () => {
  assert.strictEqual(normalizeRoutingMode("hybrid"), "hybrid");
  assert.strictEqual(normalizeRoutingMode("cloud"), "cloud");
  assert.strictEqual(normalizeRoutingMode("local"), "local");
  assert.strictEqual(normalizeRoutingMode("Claude"), "cloud");
  assert.strictEqual(normalizeRoutingMode("ollama_only"), "local");
  assert.strictEqual(normalizeRoutingMode(""), "hybrid");
  assert.strictEqual(normalizeRoutingMode(null), "hybrid");
});

"use strict";

/**
 * Daily-use routing scenarios for a programmer on limited Claude Code / Opus API quota.
 *
 * Validity: decisions match hybrid.config.example.json routing rules (token / tool / keyword).
 * Pertinence: routine coding stays local (Ollama); high-signal work escalates to cloud (Opus-class API).
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { analyzeMessages } = require("../router/lib/routing-logic");

const examplePath = path.join(
  __dirname,
  "..",
  "router",
  "hybrid.config.example.json",
);
const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
const ROUTING = {
  tokenThreshold: example.routing.tokenThreshold,
  fileReadThreshold: example.routing.fileReadThreshold,
  keywords: example.routing.keywords,
};

function userText(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

function lastUserOnlyToolResults(count) {
  const content = [];
  for (let i = 0; i < count; i++) {
    content.push({
      type: "tool_result",
      tool_use_id: `sim-${i}`,
      content: JSON.stringify({ path: `src/f${i}.ts`, lines: 40 }),
    });
  }
  return { role: "user", content };
}

test("daily: greeting and tiny follow-ups stay local (preserve API quota)", () => {
  for (const text of ["hi", "ok thanks", "yes", "apply that"]) {
    const r = analyzeMessages({ messages: [userText(text)] }, ROUTING);
    assert.strictEqual(
      r.dest,
      "local",
      `expected local for: ${JSON.stringify(text)}`,
    );
  }
});

test("daily: quick error / stack trace question stays local", () => {
  const text = `Why does Node throw "Cannot find module './x'" here?\n    at Object.<anonymous> (app.js:12:5)`;
  const r = analyzeMessages({ messages: [userText(text)] }, ROUTING);
  assert.strictEqual(r.dest, "local");
});

test("daily: small refactor without routing keywords stays local", () => {
  const r = analyzeMessages(
    {
      messages: [
        userText(
          "Extract this into a helper and add a null check before the return.",
        ),
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "local");
});

test("daily: long transcript but last user turn is short text stays local (tool_results not in last message)", () => {
  const messages = [];
  for (let i = 0; i < 4; i++) {
    messages.push(lastUserOnlyToolResults(2));
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Read files." }],
    });
  }
  messages.push(userText("Summarize what you found in one paragraph."));
  const r = analyzeMessages({ messages }, ROUTING);
  assert.strictEqual(r.dest, "local");
});

test("daily: architecture / security / design keywords escalate to cloud (worth Opus)", () => {
  const cases = [
    "We need to architect a new service boundary between billing and auth.",
    "Please do a security audit of this authentication flow.",
    "Which design pattern fits a job queue with retries?",
    "I suspect a race condition between these two useEffects.",
    "Help me with system design for a read-heavy API.",
  ];
  for (const text of cases) {
    const r = analyzeMessages({ messages: [userText(text)] }, ROUTING);
    assert.strictEqual(
      r.dest,
      "cloud",
      `expected cloud for high-signal prompt: ${text.slice(0, 60)}…`,
    );
    assert.ok(r.reason.includes("keyword"), `reason: ${r.reason}`);
  }
});

test("daily: keyword match is case-insensitive on user text", () => {
  const r = analyzeMessages(
    { messages: [userText("Need SYSTEM DESIGN advice for Postgres.")] },
    ROUTING,
  );
  assert.strictEqual(r.dest, "cloud");
});

test("daily: concise keyword prompt can stay local and use Ollama smart routing", () => {
  const r = analyzeMessages(
    {
      messages: [
        userText("Give me a brief system design summary in one paragraph."),
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "local");
  assert.ok(r.reason.includes("concise keyword prompt"), r.reason);
});

test("daily: generic audit logging request stays local", () => {
  const r = analyzeMessages(
    {
      messages: [
        userText("Add audit logging to this route and include the request id."),
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "local");
  assert.ok(
    r.reason.includes('generic keyword prompt "audit" stayed local'),
    r.reason,
  );
});

test("daily: security audit still escalates to cloud", () => {
  const r = analyzeMessages(
    {
      messages: [
        userText("Do a security audit of this auth and permissions flow."),
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, "cloud");
  assert.ok(r.reason.includes('keyword "security audit"'), r.reason);
});

test("daily: one-shot read of many files this turn escalates to cloud (heavy tool context)", () => {
  const r = analyzeMessages(
    { messages: [lastUserOnlyToolResults(ROUTING.fileReadThreshold + 1)] },
    ROUTING,
  );
  assert.strictEqual(r.dest, "cloud");
  assert.ok(r.reason.includes("tool results"), r.reason);
});

test("daily: at fileReadThreshold tool results stays local (boundary)", () => {
  const r = analyzeMessages(
    { messages: [lastUserOnlyToolResults(ROUTING.fileReadThreshold)] },
    ROUTING,
  );
  assert.strictEqual(r.dest, "local");
});

test("daily: huge pasted transcript escalates to cloud (quality / context limit)", () => {
  const big = "x".repeat(ROUTING.tokenThreshold * 4 + 8);
  const r = analyzeMessages({ messages: [userText(big)] }, ROUTING);
  assert.strictEqual(r.dest, "cloud");
  assert.ok(r.reason.includes("tokens"), r.reason);
});

test("daily: routing config matches shipped hybrid.config.example.json defaults", () => {
  assert.strictEqual(example.routing.mode, "hybrid");
  assert.strictEqual(ROUTING.tokenThreshold, 5000);
  assert.strictEqual(ROUTING.fileReadThreshold, 10);
  assert.ok(ROUTING.keywords.includes("system design"));
  assert.ok(ROUTING.keywords.includes("security audit"));
});

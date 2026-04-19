'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  getEffectiveThresholds,
  sanitizeRoutingThresholds,
  analyzeMessages,
  ROUTING_TOKEN_THRESHOLD_MIN,
  ROUTING_TOKEN_THRESHOLD_MAX,
  ROUTING_FILE_READ_THRESHOLD_MIN,
  ROUTING_FILE_READ_THRESHOLD_MAX,
} = require('../router/lib/routing-logic');

test('getEffectiveThresholds clamps token threshold', () => {
  assert.deepStrictEqual(
    getEffectiveThresholds({ tokenThreshold: 50, fileReadThreshold: 7 }),
    { tokenThreshold: ROUTING_TOKEN_THRESHOLD_MIN, fileReadThreshold: 7 },
  );
  assert.deepStrictEqual(
    getEffectiveThresholds({ tokenThreshold: 9_999_999, fileReadThreshold: 7 }),
    { tokenThreshold: ROUTING_TOKEN_THRESHOLD_MAX, fileReadThreshold: 7 },
  );
});

test('getEffectiveThresholds clamps file-read threshold', () => {
  assert.deepStrictEqual(
    getEffectiveThresholds({ tokenThreshold: 5000, fileReadThreshold: 0 }),
    { tokenThreshold: 5000, fileReadThreshold: ROUTING_FILE_READ_THRESHOLD_MIN },
  );
  assert.deepStrictEqual(
    getEffectiveThresholds({ tokenThreshold: 5000, fileReadThreshold: 999 }),
    { tokenThreshold: 5000, fileReadThreshold: ROUTING_FILE_READ_THRESHOLD_MAX },
  );
});

test('getEffectiveThresholds defaults when missing or NaN', () => {
  assert.deepStrictEqual(getEffectiveThresholds({}), {
    tokenThreshold: 32000,
    fileReadThreshold: 10,
  });
  assert.deepStrictEqual(
    getEffectiveThresholds({ tokenThreshold: 'nope', fileReadThreshold: null }),
    { tokenThreshold: 32000, fileReadThreshold: 10 },
  );
});

test('sanitizeRoutingThresholds mutates object in place', () => {
  const r = { tokenThreshold: 100, fileReadThreshold: 0, keywords: [] };
  sanitizeRoutingThresholds(r);
  assert.strictEqual(r.tokenThreshold, ROUTING_TOKEN_THRESHOLD_MIN);
  assert.strictEqual(r.fileReadThreshold, ROUTING_FILE_READ_THRESHOLD_MIN);
  assert.deepStrictEqual(r.keywords, []);
});

test('analyzeMessages uses clamped thresholds (tiny configured gate still floors at min)', () => {
  const tiny = { tokenThreshold: 400, fileReadThreshold: 7, keywords: [] };
  const body = { messages: [{ role: 'user', content: 'x'.repeat(4000) }] };
  const r = analyzeMessages(body, tiny);
  assert.strictEqual(r.dest, 'local');
  assert.ok(
    getEffectiveThresholds(tiny).tokenThreshold >= ROUTING_TOKEN_THRESHOLD_MIN,
  );
});

// ── Saturation-guard threshold (effectiveNumCtx > 32768) ─────────────────────

test('saturation guard: default 16K ctx stays local even above 82%', () => {
  // 16384 is the default num_ctx. At 82% that fires at ~13 435 tokens, which is
  // within a normal Claude Code session — the guard must NOT fire here.
  const cfg = { tokenThreshold: 500_000, fileReadThreshold: 10, keywords: [], effectiveNumCtx: 16384 };
  // ~55 000 chars → ~13 750 tokens → ~84% of 16 384 but ctx ≤ 32 768 → local
  const body = { messages: [{ role: 'user', content: 'x'.repeat(55_000) }] };
  const r = analyzeMessages(body, cfg);
  assert.strictEqual(r.dest, 'local', `expected local, got cloud: ${r.reason}`);
});

test('saturation guard: exact 32768 boundary stays local', () => {
  // Condition is strictly >, so 32768 itself must NOT trigger.
  const cfg = { tokenThreshold: 500_000, fileReadThreshold: 10, keywords: [], effectiveNumCtx: 32768 };
  // ~110 000 chars → ~27 500 tokens → ~84% of 32 768, but ctx is NOT > 32 768 → local
  const body = { messages: [{ role: 'user', content: 'x'.repeat(110_000) }] };
  const r = analyzeMessages(body, cfg);
  assert.strictEqual(r.dest, 'local', `expected local, got cloud: ${r.reason}`);
});

test('saturation guard: 64K ctx escalates to cloud when input fills > 82%', () => {
  // A model with explicit 64K context: overflow is a real risk, guard should fire.
  const cfg = { tokenThreshold: 500_000, fileReadThreshold: 10, keywords: [], effectiveNumCtx: 65536 };
  // ~220 000 chars → ~55 000 tokens → ~84% of 65 536 → cloud
  const body = { messages: [{ role: 'user', content: 'x'.repeat(220_000) }] };
  const r = analyzeMessages(body, cfg);
  assert.strictEqual(r.dest, 'cloud');
  assert.ok(/local context/.test(r.reason), `reason should mention "local context", got: ${r.reason}`);
});

test('saturation guard: 64K ctx stays local when input is well under 82%', () => {
  const cfg = { tokenThreshold: 500_000, fileReadThreshold: 10, keywords: [], effectiveNumCtx: 65536 };
  // 1 000 chars → 250 tokens → 0.4% of 65 536 → local
  const body = { messages: [{ role: 'user', content: 'x'.repeat(1_000) }] };
  const r = analyzeMessages(body, cfg);
  assert.strictEqual(r.dest, 'local');
});

test('analyzeMessages respects clamped high tool-result threshold', () => {
  const cfg = { tokenThreshold: 5000, fileReadThreshold: 256, keywords: [] };
  const toolBlocks = Array.from({ length: 257 }, () => ({
    type: 'tool_result',
    content: 'ok',
  }));
  const r = analyzeMessages(
    { messages: [{ role: 'user', content: toolBlocks }] },
    cfg,
  );
  assert.strictEqual(r.dest, 'cloud');
});

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

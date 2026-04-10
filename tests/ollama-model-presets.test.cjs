'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { matchPresetPatch } = require('../router/lib/ollama-model-presets');

test('matchPresetPatch: llama3.2 tag beats llama3', () => {
  const p = matchPresetPatch('llama3.2:3b');
  assert.strictEqual(typeof p.temperature, 'number');
  assert.ok(p.num_ctx >= 8192);
});

test('matchPresetPatch: registry path uses model segment', () => {
  const p = matchPresetPatch('vladimirgav/gemma4-26b-16gb-vram:latest');
  assert.ok(Object.keys(p).length > 0);
  assert.strictEqual(typeof p.temperature, 'number');
});

test('matchPresetPatch: unknown model returns {}', () => {
  assert.deepStrictEqual(matchPresetPatch('totally-unknown-model:1b'), {});
});

test('matchPresetPatch: qwen2.5-coder', () => {
  const p = matchPresetPatch('qwen2.5-coder:7b');
  assert.ok(p.temperature < 0.5);
});

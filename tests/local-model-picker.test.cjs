'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  resolveLocalPool,
  parseParameterBillions,
  analyzeLocalTask,
  pickBestLocalModel,
} = require('../router/lib/local-model-picker');

const baseCfg = () => ({
  local: { model: 'big:latest', models: [], smart_routing: true },
});

test('resolveLocalPool: empty models list uses all installed', () => {
  const pool = resolveLocalPool(baseCfg(), ['small:latest', 'big:latest']);
  assert.deepStrictEqual(pool, ['small:latest', 'big:latest']);
});

test('resolveLocalPool: respects explicit models subset', () => {
  const cfg = { local: { model: 'big:latest', models: ['small:latest', 'ghost:latest'], smart_routing: true } };
  const pool = resolveLocalPool(cfg, ['small:latest', 'big:latest']);
  assert.deepStrictEqual(pool, ['small:latest']);
});

test('parseParameterBillions', () => {
  assert.strictEqual(parseParameterBillions('26B'), 26);
  assert.strictEqual(parseParameterBillions('8.0B'), 8);
  assert.strictEqual(parseParameterBillions('500M'), 0.5);
  assert.strictEqual(parseParameterBillions(null), null);
});

test('analyzeLocalTask: tools and vision', () => {
  const t1 = analyzeLocalTask({
    tools: [{ name: 'x', input_schema: {} }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.strictEqual(t1.needsTools, true);
  assert.strictEqual(t1.needsVision, false);

  const t2 = analyzeLocalTask({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }],
  });
  assert.strictEqual(t2.needsVision, true);
});

test('analyzeLocalTask: prefersSpeed from prompt (no tools/vision/heavy)', () => {
  const t = analyzeLocalTask({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Give a brief summary of two lines only.' }] }],
  });
  assert.strictEqual(t.prefersSpeed, true);
  assert.strictEqual(t.prefersHeavy, false);
});

test('analyzeLocalTask: no prefersSpeed when tools requested', () => {
  const t = analyzeLocalTask({
    tools: [{ name: 'x', input_schema: {} }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'quick answer using tools' }] }],
  });
  assert.strictEqual(t.prefersSpeed, false);
});

test('pickBestLocalModel: prefers vision model when images', () => {
  const profiles = [
    { name: 'tiny:latest', context_max: 8192, has_vision: false, has_tools: true, has_reasoning: false, param_billions: 1, family: 'q' },
    { name: 'llava:latest', context_max: 8192, has_vision: true, has_tools: false, has_reasoning: false, param_billions: 7, family: 'l' },
  ];
  const task = { estTokens: 100, needsTools: false, needsVision: true, prefersHeavy: false, prefersSpeed: false };
  const { model } = pickBestLocalModel(profiles, task, 'tiny:latest', 4096);
  assert.strictEqual(model, 'llava:latest');
});

test('pickBestLocalModel: prefers larger model for heavy prompt', () => {
  const profiles = [
    { name: 'small:latest', context_max: 32768, has_vision: null, has_tools: null, has_reasoning: null, param_billions: 2, family: 's' },
    { name: 'huge:latest', context_max: 32768, has_vision: null, has_tools: null, has_reasoning: null, param_billions: 26, family: 'h' },
  ];
  const task = { estTokens: 5000, needsTools: false, needsVision: false, prefersHeavy: true, prefersSpeed: false };
  const { model } = pickBestLocalModel(profiles, task, 'small:latest', 4096);
  assert.strictEqual(model, 'huge:latest');
});

test('pickBestLocalModel: speed-priority + fast_model picks small draft-like tag', () => {
  const profiles = [
    { name: 'small:latest', context_max: 32768, has_vision: null, has_tools: null, has_reasoning: null, param_billions: 2, family: 's' },
    { name: 'huge:latest', context_max: 32768, has_vision: null, has_tools: null, has_reasoning: null, param_billions: 26, family: 'h' },
  ];
  const task = {
    estTokens: 400,
    needsTools: false,
    needsVision: false,
    prefersHeavy: false,
    prefersSpeed: true,
  };
  const { model, reason } = pickBestLocalModel(profiles, task, 'huge:latest', 4096, 'small:latest');
  assert.strictEqual(model, 'small:latest');
  assert.ok(reason.includes('fast_model'));
});

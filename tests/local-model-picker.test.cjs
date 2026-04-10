'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  resolveLocalPool,
  parseParameterBillions,
  inferParamBillionsFromName,
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

test('inferParamBillionsFromName', () => {
  assert.strictEqual(inferParamBillionsFromName('org/llama3.2:3b'), 3);
  assert.strictEqual(inferParamBillionsFromName('foo-26b-q4'), 26);
  assert.strictEqual(inferParamBillionsFromName('no-size-here'), null);
});

test('analyzeLocalTask: tools in schema and vision', () => {
  const t1 = analyzeLocalTask({
    tools: [{ name: 'x', input_schema: {} }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.strictEqual(t1.toolsInSchema, true);
  assert.strictEqual(t1.toolResultsThisTurn, 0);
  assert.strictEqual(t1.needsVision, false);

  const t2 = analyzeLocalTask({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }],
  });
  assert.strictEqual(t2.needsVision, true);
});

test('analyzeLocalTask: prefersSpeed from prompt even when tools are in schema (Claude Code shape)', () => {
  const t = analyzeLocalTask({
    tools: [{ name: 'x', input_schema: {} }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Give a brief summary of two lines only.' }] }],
  });
  assert.strictEqual(t.prefersSpeed, true);
  assert.strictEqual(t.prefersHeavy, false);
  assert.strictEqual(t.toolResultsThisTurn, 0);
});

test('analyzeLocalTask: no prefersSpeed when last message has tool results', () => {
  const t = analyzeLocalTask({
    tools: [{ name: 'x', input_schema: {} }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'data' }],
      },
    ],
  });
  assert.strictEqual(t.prefersSpeed, false);
});

test('analyzeLocalTask: many tool results this turn → prefersHeavy', () => {
  const content = [];
  for (let i = 0; i < 5; i++) {
    content.push({ type: 'tool_result', tool_use_id: `id${i}`, content: '{}' });
  }
  const t = analyzeLocalTask({
    messages: [{ role: 'user', content }],
  });
  assert.strictEqual(t.toolResultsThisTurn, 5);
  assert.strictEqual(t.prefersHeavy, true);
});

test('pickBestLocalModel: prefers vision model when images', () => {
  const profiles = [
    { name: 'tiny:latest', context_max: 8192, has_vision: false, has_tools: true, has_reasoning: false, param_billions: 1, family: 'q' },
    { name: 'llava:latest', context_max: 8192, has_vision: true, has_tools: false, has_reasoning: false, param_billions: 7, family: 'l' },
  ];
  const task = {
    estTokens: 100,
    toolsInSchema: false,
    toolResultsThisTurn: 0,
    needsVision: true,
    prefersHeavy: false,
    prefersSpeed: false,
  };
  const { model } = pickBestLocalModel(profiles, task, 'tiny:latest', 4096);
  assert.strictEqual(model, 'llava:latest');
});

test('pickBestLocalModel: prefers larger model for heavy prompt', () => {
  const profiles = [
    { name: 'small:latest', context_max: 32768, has_vision: null, has_tools: null, has_reasoning: null, param_billions: 2, family: 's' },
    { name: 'huge:latest', context_max: 32768, has_vision: null, has_tools: null, has_reasoning: null, param_billions: 26, family: 'h' },
  ];
  const task = {
    estTokens: 5000,
    toolsInSchema: false,
    toolResultsThisTurn: 0,
    needsVision: false,
    prefersHeavy: true,
    prefersSpeed: false,
  };
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
    toolsInSchema: false,
    toolResultsThisTurn: 0,
    needsVision: false,
    prefersHeavy: false,
    prefersSpeed: true,
  };
  const { model, reason } = pickBestLocalModel(profiles, task, 'huge:latest', 4096, 'small:latest');
  assert.strictEqual(model, 'small:latest');
  assert.ok(reason.includes('fast_model'));
});

test('pickBestLocalModel: tools in schema but light prompt prefers smaller capable model', () => {
  const profiles = [
    { name: 'small:latest', context_max: 32768, has_vision: null, has_tools: true, has_reasoning: null, param_billions: 2, family: 's' },
    { name: 'huge:latest', context_max: 32768, has_vision: null, has_tools: true, has_reasoning: null, param_billions: 26, family: 'h' },
  ];
  const task = {
    estTokens: 200,
    toolsInSchema: true,
    toolResultsThisTurn: 0,
    needsVision: false,
    prefersHeavy: false,
    prefersSpeed: false,
  };
  const { model } = pickBestLocalModel(profiles, task, 'huge:latest', 4096);
  assert.strictEqual(model, 'small:latest');
});

test('pickBestLocalModel: task.needsTools alias maps to toolsInSchema', () => {
  const profiles = [
    { name: 'a:latest', context_max: 8192, has_vision: false, has_tools: true, has_reasoning: false, param_billions: 2, family: 'a' },
    { name: 'b:latest', context_max: 8192, has_vision: false, has_tools: false, has_reasoning: false, param_billions: 2, family: 'b' },
  ];
  const task = { estTokens: 100, needsTools: true, toolResultsThisTurn: 0, needsVision: false, prefersHeavy: false, prefersSpeed: false };
  const { model } = pickBestLocalModel(profiles, task, 'a:latest', 4096);
  assert.strictEqual(model, 'a:latest');
});

test('pickBestLocalModel: infers billions from name when profile missing parameter_size', () => {
  const profiles = [
    { name: 'mymodel:3b', context_max: 8192, has_vision: false, has_tools: true, has_reasoning: false, param_billions: null, family: null },
    { name: 'mymodel:70b', context_max: 8192, has_vision: false, has_tools: true, has_reasoning: false, param_billions: null, family: null },
  ];
  const task = {
    estTokens: 300,
    toolsInSchema: true,
    toolResultsThisTurn: 0,
    needsVision: false,
    prefersHeavy: false,
    prefersSpeed: false,
  };
  const { model } = pickBestLocalModel(profiles, task, 'mymodel:70b', 4096);
  assert.strictEqual(model, 'mymodel:3b');
});

test('pickBestLocalModel: mid tool-turn (2–4 results) tilts toward larger capable model', () => {
  const profiles = [
    { name: 'small:latest', context_max: 32768, has_vision: null, has_tools: true, has_reasoning: null, param_billions: 3, family: 's' },
    { name: 'huge:latest', context_max: 32768, has_vision: null, has_tools: true, has_reasoning: null, param_billions: 26, family: 'h' },
  ];
  const task = {
    estTokens: 900,
    toolsInSchema: true,
    toolResultsThisTurn: 3,
    needsVision: false,
    prefersHeavy: false,
    prefersSpeed: false,
  };
  const { model, reason } = pickBestLocalModel(profiles, task, 'small:latest', 4096);
  assert.strictEqual(model, 'huge:latest');
  assert.ok(reason.includes('mid tool-turn'), reason);
});

test('pickBestLocalModel: many tool results this turn prefers larger model (heavy path)', () => {
  const profiles = [
    { name: 'small:latest', context_max: 32768, has_vision: null, has_tools: true, has_reasoning: null, param_billions: 3, family: 's' },
    { name: 'huge:latest', context_max: 32768, has_vision: null, has_tools: true, has_reasoning: null, param_billions: 24, family: 'h' },
  ];
  const task = {
    estTokens: 800,
    toolsInSchema: true,
    toolResultsThisTurn: 5,
    needsVision: false,
    prefersHeavy: true,
    prefersSpeed: false,
  };
  const { model } = pickBestLocalModel(profiles, task, 'small:latest', 4096);
  assert.strictEqual(model, 'huge:latest');
});

test('analyzeLocalTask: reasoning keywords set prefersReasoning (unless speed-priority)', () => {
  const t1 = analyzeLocalTask({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Prove step by step that sqrt(2) is irrational.' }] }],
  });
  assert.strictEqual(t1.prefersReasoning, true);
  const t2 = analyzeLocalTask({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Give a brief one-sentence summary of induction proofs.' }] }],
  });
  assert.strictEqual(t2.prefersSpeed, true);
  assert.strictEqual(t2.prefersReasoning, false);
});

test('pickBestLocalModel: reasoning-oriented prompt prefers stronger reasoning profile', () => {
  const profiles = [
    { name: 'tiny-general:latest', context_max: 8192, has_vision: false, has_tools: true, has_reasoning: false, param_billions: 3, family: 't' },
    { name: 'think-big:latest', context_max: 8192, has_vision: false, has_tools: true, has_reasoning: true, param_billions: 8, family: 'b' },
  ];
  const task = analyzeLocalTask({
    tools: [{ name: 'x', input_schema: {} }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Explain why this recurrence solves to O(n log n). Show the induction.' }] },
    ],
  });
  assert.strictEqual(task.prefersReasoning, true);
  const { model, reason } = pickBestLocalModel(profiles, task, 'tiny-general:latest', 4096);
  assert.strictEqual(model, 'think-big:latest');
  assert.ok(reason.includes('reasoning-oriented'), reason);
});

test('pickBestLocalModel: explicit has_tools false excluded when tools in schema', () => {
  const profiles = [
    { name: 'notool:latest', context_max: 32768, has_vision: null, has_tools: false, has_reasoning: null, param_billions: 2, family: 'n' },
    { name: 'ok:latest', context_max: 32768, has_vision: null, has_tools: true, has_reasoning: null, param_billions: 8, family: 'o' },
  ];
  const task = {
    estTokens: 200,
    toolsInSchema: true,
    toolResultsThisTurn: 0,
    needsVision: false,
    prefersHeavy: false,
    prefersSpeed: false,
  };
  const { model } = pickBestLocalModel(profiles, task, 'ok:latest', 4096);
  assert.strictEqual(model, 'ok:latest');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  pathOnly,
  pickRunningModel,
  firstLoadedPsRow,
  listPsModels,
  psModelId,
  modelNamesMatch,
  stripOptionalOllamaTagNorm,
  maxContextFromShow,
} = require('../router/lib/model-utils');

test('pathOnly strips query string', () => {
  assert.strictEqual(pathOnly('/api/model-status'), '/api/model-status');
  assert.strictEqual(pathOnly('/api/model-status?foo=1'), '/api/model-status');
  assert.strictEqual(pathOnly('/v1/messages?beta=true'), '/v1/messages');
  assert.strictEqual(pathOnly('/'), '/');
});

test('listPsModels handles null, dict, and top-level array', () => {
  assert.deepStrictEqual(listPsModels(null), []);
  assert.deepStrictEqual(listPsModels(undefined), []);
  assert.deepStrictEqual(listPsModels({}), []);
  assert.deepStrictEqual(listPsModels({ models: 'bad' }), []);
  const rows = [{ model: 'a' }, { name: 'b' }];
  assert.deepStrictEqual(listPsModels({ models: rows }), rows);
  assert.deepStrictEqual(listPsModels(rows), rows);
});

test('psModelId prefers model then name', () => {
  assert.strictEqual(psModelId({ model: 'm1', name: 'n1' }), 'm1');
  assert.strictEqual(psModelId({ name: 'n2' }), 'n2');
  assert.strictEqual(psModelId({}), '');
});

test('pickRunningModel returns null for empty ps or empty configured', () => {
  assert.strictEqual(pickRunningModel(null, 'any'), null);
  assert.strictEqual(pickRunningModel({}, 'any'), null);
  assert.strictEqual(pickRunningModel({ models: [] }, 'any'), null);
  assert.strictEqual(
    pickRunningModel({ models: [{ model: 'x:latest' }] }, ''),
    null,
  );
  assert.strictEqual(
    pickRunningModel({ models: [{ model: 'x:latest' }] }, '   '),
    null,
  );
});

test('pickRunningModel exact match on configured model', () => {
  const ps = {
    models: [
      { model: 'first:latest', name: 'first:latest' },
      { model: 'gemma4:26b-a4b-it-q4_k_m', name: 'gemma4:26b-a4b-it-q4_k_m' },
    ],
  };
  const picked = pickRunningModel(ps, 'gemma4:26b-a4b-it-q4_k_m');
  assert.strictEqual(psModelId(picked), 'gemma4:26b-a4b-it-q4_k_m');
});

test('pickRunningModel does not always use first row when second matches', () => {
  const ps = {
    models: [
      { model: 'llama3:latest' },
      { model: 'myorg/want:q4' },
    ],
  };
  const picked = pickRunningModel(ps, 'myorg/want:q4');
  assert.strictEqual(psModelId(picked), 'myorg/want:q4');
});

test('pickRunningModel does not fall back to unrelated first model', () => {
  const ps = { models: [{ model: 'only:tag' }] };
  assert.strictEqual(pickRunningModel(ps, 'something/else:latest'), null);
});

test('pickRunningModel does not match short name inside long path (substring bug)', () => {
  const ps = {
    models: [{ model: 'gemma4:latest', name: 'gemma4:latest' }],
  };
  assert.strictEqual(
    pickRunningModel(ps, 'myorg/gemma4-custom:latest'),
    null,
  );
});

test('pickRunningModel matches optional Ollama tag on same base', () => {
  const ps = { models: [{ model: 'llama3.2:latest' }] };
  const a = pickRunningModel(ps, 'llama3.2');
  assert.ok(a);
  assert.strictEqual(psModelId(a), 'llama3.2:latest');
  const b = pickRunningModel(ps, 'llama3.2:latest');
  assert.strictEqual(psModelId(b), 'llama3.2:latest');
});

test('firstLoadedPsRow returns first row or null', () => {
  assert.strictEqual(firstLoadedPsRow(null), null);
  assert.strictEqual(firstLoadedPsRow({ models: [] }), null);
  const ps = { models: [{ model: 'a' }, { model: 'b' }] };
  assert.strictEqual(psModelId(firstLoadedPsRow(ps)), 'a');
});

test('modelNamesMatch and stripOptionalOllamaTagNorm', () => {
  assert.strictEqual(modelNamesMatch('Foo:bar', 'foo:bar'), true);
  assert.strictEqual(modelNamesMatch('Foo', 'foo:latest'), true);
  assert.strictEqual(
    modelNamesMatch('myorg/gemma4-custom:latest', 'gemma4:latest'),
    false,
  );
  assert.strictEqual(stripOptionalOllamaTagNorm('a:b'), 'a');
  assert.strictEqual(stripOptionalOllamaTagNorm('no-colon'), 'no-colon');
});

test('maxContextFromShow reads top-level context_length', () => {
  assert.strictEqual(maxContextFromShow({ context_length: 8192 }), 8192);
  assert.strictEqual(maxContextFromShow({ context_length: 0 }), null);
});

test('maxContextFromShow coerces numeric strings', () => {
  assert.strictEqual(maxContextFromShow({ context_length: '131072' }), 131072);
  assert.strictEqual(maxContextFromShow({ details: { context_length: '4096' } }), 4096);
});

test('maxContextFromShow reads model_info suffix', () => {
  assert.strictEqual(
    maxContextFromShow({ model_info: { 'gemma2.context_length': 131072 } }),
    131072,
  );
  assert.strictEqual(
    maxContextFromShow({ model_info: { 'llama.context_length': 4096 } }),
    4096,
  );
});

test('maxContextFromShow reads details.context_length', () => {
  assert.strictEqual(maxContextFromShow({ details: { context_length: 2048 } }), 2048);
});

test('maxContextFromShow returns null when missing', () => {
  assert.strictEqual(maxContextFromShow(null), null);
  assert.strictEqual(maxContextFromShow({}), null);
});

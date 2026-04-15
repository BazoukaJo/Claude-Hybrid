'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pickAutoDefaultModels, primaryPreferenceScore } = require('../router/lib/auto-default-models');

test('primaryPreferenceScore favors kit Gemma 26B id', () => {
  assert.ok(primaryPreferenceScore('gemma4:26b-a4b-it-q4_k_m') > primaryPreferenceScore('llama3.2:3b'));
});

test('pickAutoDefaultModels prefers gemma4:26b and gemma4:e4b as fast', () => {
  const r = pickAutoDefaultModels([
    { name: 'llama3.2:3b', size: 2e9 },
    { name: 'gemma4:26b-a4b-it-q4_k_m', size: 15e9 },
    { name: 'gemma4:e4b', size: 4e9 },
  ]);
  assert.strictEqual(r.primary, 'gemma4:26b-a4b-it-q4_k_m');
  assert.strictEqual(r.fast, 'gemma4:e4b');
});

test('pickAutoDefaultModels single tag has empty fast', () => {
  const r = pickAutoDefaultModels([{ name: 'mistral:7b', size: 4e9 }]);
  assert.strictEqual(r.primary, 'mistral:7b');
  assert.strictEqual(r.fast, '');
});

test('pickAutoDefaultModels fixedPrimary only derives fast', () => {
  const r = pickAutoDefaultModels(
    [
      { name: 'big:latest', size: 10e9 },
      { name: 'small:1b', size: 1e9 },
    ],
    { fixedPrimary: 'big:latest' },
  );
  assert.strictEqual(r.primary, 'big:latest');
  assert.strictEqual(r.fast, 'small:1b');
});

test('pickAutoDefaultModels picks largest when no name preference', () => {
  const r = pickAutoDefaultModels([
    { name: 'tiny:1b', size: 1e9 },
    { name: 'mid:7b', size: 4e9 },
  ]);
  assert.strictEqual(r.primary, 'mid:7b');
  assert.strictEqual(r.fast, 'tiny:1b');
});

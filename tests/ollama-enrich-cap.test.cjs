'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  OLLAMA_CONTEXT_ENRICH_CAP,
  selectEnrichmentHead,
  mergeEnrichedModels,
} = require('../router/lib/ollama-enrich-cap');

test('selectEnrichmentHead returns all when under cap', () => {
  const m = [{ name: 'z' }, { name: 'a' }];
  const h = selectEnrichmentHead(m);
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[0].name, 'z');
});

test('selectEnrichmentHead takes first N names alphabetically when over cap', () => {
  const names = Array.from({ length: OLLAMA_CONTEXT_ENRICH_CAP + 15 }, (_, i) => ({
    name: `m${String(i).padStart(2, '0')}`,
  }));
  const h = selectEnrichmentHead(names);
  assert.strictEqual(h.length, OLLAMA_CONTEXT_ENRICH_CAP);
  const sorted = [...names].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepStrictEqual(
    h.map((x) => x.name),
    sorted.slice(0, OLLAMA_CONTEXT_ENRICH_CAP).map((x) => x.name),
  );
});

test('mergeEnrichedModels preserves original order', () => {
  const orig = [{ name: 'c' }, { name: 'a' }, { name: 'b' }];
  const enriched = [
    { name: 'a', context_max: 4096 },
    { name: 'b', context_max: 8192 },
  ];
  const out = mergeEnrichedModels(orig, enriched);
  assert.strictEqual(out[0].name, 'c');
  assert.strictEqual(out[0].context_max, null);
  assert.strictEqual(out[1].context_max, 4096);
  assert.strictEqual(out[2].context_max, 8192);
});

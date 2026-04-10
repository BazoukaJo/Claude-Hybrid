'use strict';

delete process.env.ROUTER_OLLAMA_ENRICH_CAP;

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

test('OLLAMA_CONTEXT_ENRICH_CAP env is clamped 5..100', () => {
  try {
    process.env.ROUTER_OLLAMA_ENRICH_CAP = '3';
    delete require.cache[require.resolve('../router/lib/ollama-enrich-cap')];
    let m = require('../router/lib/ollama-enrich-cap');
    assert.strictEqual(m.OLLAMA_CONTEXT_ENRICH_CAP, 5);
    delete require.cache[require.resolve('../router/lib/ollama-enrich-cap')];
    process.env.ROUTER_OLLAMA_ENRICH_CAP = '60';
    m = require('../router/lib/ollama-enrich-cap');
    assert.strictEqual(m.OLLAMA_CONTEXT_ENRICH_CAP, 60);
    delete require.cache[require.resolve('../router/lib/ollama-enrich-cap')];
    process.env.ROUTER_OLLAMA_ENRICH_CAP = '500';
    m = require('../router/lib/ollama-enrich-cap');
    assert.strictEqual(m.OLLAMA_CONTEXT_ENRICH_CAP, 100);
  } finally {
    delete process.env.ROUTER_OLLAMA_ENRICH_CAP;
    delete require.cache[require.resolve('../router/lib/ollama-enrich-cap')];
  }
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

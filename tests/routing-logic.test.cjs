'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { analyzeMessages, normalizeRoutingMode } = require('../router/lib/routing-logic');

const ROUTING = {
  tokenThreshold: 5000,
  fileReadThreshold: 7,
  keywords: ['system design', 'deep reason'],
};

test('last user text only: local despite many historical tool_results', () => {
  const messages = [];
  for (let i = 0; i < 5; i++) {
    messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: `t${i}a`, content: 'x' },
        { type: 'tool_result', tool_use_id: `t${i}b`, content: 'y' },
      ],
    });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  }
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: 'thanks' }],
  });
  const r = analyzeMessages({ messages }, ROUTING);
  assert.strictEqual(r.dest, 'local');
});

test('last user message with 8 tool_results: cloud', () => {
  const content = [];
  for (let i = 0; i < 8; i++) {
    content.push({ type: 'tool_result', tool_use_id: `id${i}`, content: 'data' });
  }
  const r = analyzeMessages(
    { messages: [{ role: 'user', content }] },
    ROUTING,
  );
  assert.strictEqual(r.dest, 'cloud');
  assert.ok(r.reason.includes('tool results'));
});

test('keyword in last user text: cloud', () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Need system design help' }],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, 'cloud');
});

test('tiny prompt: local', () => {
  const r = analyzeMessages(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
        },
      ],
    },
    ROUTING,
  );
  assert.strictEqual(r.dest, 'local');
});

test('normalizeRoutingMode accepts synonyms and defaults', () => {
  assert.strictEqual(normalizeRoutingMode('hybrid'), 'hybrid');
  assert.strictEqual(normalizeRoutingMode('cloud'), 'cloud');
  assert.strictEqual(normalizeRoutingMode('local'), 'local');
  assert.strictEqual(normalizeRoutingMode('Claude'), 'cloud');
  assert.strictEqual(normalizeRoutingMode('ollama_only'), 'local');
  assert.strictEqual(normalizeRoutingMode(''), 'hybrid');
  assert.strictEqual(normalizeRoutingMode(null), 'hybrid');
});

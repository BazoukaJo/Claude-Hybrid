'use strict';

const ROUTING_MODES = ['hybrid', 'cloud', 'local'];

/**
 * Canonical routing.mode for hybrid.config.json: hybrid | cloud (Claude API only) | local (Ollama only).
 */
function normalizeRoutingMode(value) {
  const s = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (s === 'claude' || s === 'claude_only' || s === 'anthropic') return 'cloud';
  if (s === 'ollama' || s === 'ollama_only' || s === 'local_only') return 'local';
  if (ROUTING_MODES.includes(s)) return s;
  return 'hybrid';
}

/**
 * Pure routing analysis for /v1/messages (no logging).
 * Tool-result overload is judged on the *last user message* only: Claude Code sends the
 * full transcript each time; counting every historical tool_result made >7 hits trivial,
 * so nothing ever routed locally after a short session.
 */
function analyzeMessages(body, routingCfg) {
  const msgs = body.messages || [];
  const tokenThreshold = routingCfg.tokenThreshold;
  const fileReadThreshold = routingCfg.fileReadThreshold;
  const keywords = routingCfg.keywords || [];

  let chars = 0;
  for (const m of msgs) {
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ text: typeof m.content === 'string' ? m.content : '' }];
    for (const b of blocks) {
      chars += (b.text || b.content || JSON.stringify(b)).length;
    }
  }

  const estTokens = Math.ceil(chars / 4);
  if (estTokens > tokenThreshold) {
    return { dest: 'cloud', reason: `~${estTokens} tokens` };
  }

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  let toolResultsThisTurn = 0;
  if (lastUser) {
    const blocks = Array.isArray(lastUser.content) ? lastUser.content : [];
    for (const b of blocks) {
      if (b.type === 'tool_result') toolResultsThisTurn++;
    }
  }
  if (toolResultsThisTurn > fileReadThreshold) {
    return {
      dest: 'cloud',
      reason: `${toolResultsThisTurn} tool results this turn`,
    };
  }

  if (lastUser) {
    const text = (
      typeof lastUser.content === 'string'
        ? lastUser.content
        : (lastUser.content || []).map((b) => b.text || '').join('')
    ).toLowerCase();
    const kw = keywords.find((k) => text.includes(k));
    if (kw) return { dest: 'cloud', reason: `keyword "${kw}"` };
  }

  return { dest: 'local', reason: 'routine task' };
}

module.exports = { analyzeMessages, normalizeRoutingMode, ROUTING_MODES };

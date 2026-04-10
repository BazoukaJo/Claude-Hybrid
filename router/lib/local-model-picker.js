'use strict';

/**
 * Resolve which installed Ollama models participate in smart routing.
 * Empty `cfg.local.models` means "all models returned by Ollama tags".
 */
function resolveLocalPool(cfg, installedNames) {
  const names = (installedNames || []).map((n) => String(n || '').trim()).filter(Boolean);
  const lower = (s) => String(s || '').trim().toLowerCase();
  const installedLc = new Set(names.map(lower));
  const has = (n) => installedLc.has(lower(n));
  const def = String(cfg.local?.model || '').trim();

  const listed = Array.isArray(cfg.local?.models) ? cfg.local.models.map((x) => String(x).trim()).filter(Boolean) : [];
  if (listed.length) {
    const hit = listed.filter((m) => has(m));
    if (hit.length) return hit;
    if (def && has(def)) return [def];
    return names.length ? [names[0]] : [];
  }

  if (names.length) return names;
  return def ? [def] : [];
}

function parseParameterBillions(parameterSize) {
  if (parameterSize == null) return null;
  const s = String(parameterSize).trim();
  const bm = s.match(/([\d.]+)\s*B\b/i);
  if (bm) {
    const n = Number(bm[1]);
    return Number.isFinite(n) ? n : null;
  }
  const mm = s.match(/([\d.]+)\s*M\b/i);
  if (mm) {
    const n = Number(mm[1]);
    return Number.isFinite(n) ? n / 1000 : null;
  }
  return null;
}

/** Inspect Anthropic-shaped /v1/messages body for routing hints. */
function analyzeLocalTask(body) {
  const msgs = body.messages || [];
  let chars = 0;
  for (const m of msgs) {
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ text: typeof m.content === 'string' ? m.content : '' }];
    for (const b of blocks) {
      chars += (b.text || b.content || (typeof b === 'string' ? b : JSON.stringify(b))).length;
    }
  }
  const estTokens = Math.ceil(chars / 4);

  const needsTools = Array.isArray(body.tools) && body.tools.length > 0;

  let needsVision = false;
  for (const m of msgs) {
    const blocks = Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b && b.type === 'image') {
        needsVision = true;
        break;
      }
    }
    if (needsVision) break;
  }

  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  let text = '';
  if (lastUser) {
    if (typeof lastUser.content === 'string') text = lastUser.content;
    else text = (lastUser.content || []).map((b) => b.text || '').join(' ');
  }
  const t = text.toLowerCase();
  const heavyKeywords = [
    'refactor', 'architecture', 'debug', 'complex', 'multi-file', 'performance',
    'security audit', 'system design', 'deep reason', 'race condition', 'design pattern',
    'from scratch', 'data model', 'api design',
  ];
  const prefersHeavy = estTokens > 2200 || heavyKeywords.some((k) => t.includes(k));

  /** Latency-oriented prompts (router analogue to “draft path” / small model — not true speculative decoding). */
  const speedKeywords = [
    'quick answer', 'quickly', 'brief', 'briefly', 'short answer', 'in one sentence',
    'tl;dr', 'tldr', 'concise', 'asap', 'few words', 'one paragraph', 'speed up',
    'low latency', 'respond fast', 'fast as possible',
  ];
  const prefersSpeed =
    !prefersHeavy &&
    !needsVision &&
    !needsTools &&
    speedKeywords.some((k) => t.includes(k));

  return { estTokens, needsTools, needsVision, prefersHeavy, prefersSpeed };
}

function nameSuggestsVision(name) {
  return /llava|vision|vl-|qwen.*vl|bakllava|moondream|minicpm-v|internvl|pixtral/i.test(String(name || ''));
}

function nameSuggestsTools(name) {
  return /tool|function|hermes|firefunction|nexusraven/i.test(String(name || ''));
}

/**
 * @param {Array<object>} profiles - from buildModelProfile on server
 * @param {ReturnType<typeof analyzeLocalTask>} task
 * @param {string} defaultModel
 * @param {number} effectiveNumCtx - num_ctx after global + per-model overrides for default (hint)
 * @param {string} [fastModelOpt] - optional small model name (hybrid.config `local.fast_model`) boosted on speed-priority tasks
 */
function pickBestLocalModel(profiles, task, defaultModel, effectiveNumCtx, fastModelOpt) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const fastNorm = norm(fastModelOpt);
  const minCtx = Math.min(
    131072,
    Math.max(2048, Math.ceil(task.estTokens * 2.2), Number(effectiveNumCtx) || 4096),
  );

  const viable = profiles.filter((p) => {
    if (p.context_max != null && Number.isFinite(p.context_max) && p.context_max < minCtx) return false;
    if (task.needsVision && p.has_vision === false && !nameSuggestsVision(p.name)) return false;
    if (task.needsTools && p.has_tools === false && !nameSuggestsTools(p.name)) return false;
    return true;
  });
  const pool = viable.length ? viable : profiles;

  const scoreOf = (p) => {
    let s = 0;
    const pb = p.param_billions != null && Number.isFinite(p.param_billions) ? p.param_billions : 7;

    if (task.prefersHeavy) {
      s += pb * 4;
      if (p.has_reasoning === true) s += 5;
      if (p.has_tools === true) s += task.needsTools ? 12 : 1;
      if (p.has_vision === true) s += task.needsVision ? 14 : 0;
      else if (task.needsVision && nameSuggestsVision(p.name)) s += 8;
    } else {
      s -= pb * 2.5;
      if (p.has_tools === true) s += task.needsTools ? 15 : 2;
      if (p.has_vision === true) s += task.needsVision ? 15 : 0;
      else if (task.needsVision && nameSuggestsVision(p.name)) s += 10;
      if (pb < 4) s += 6;
      if (task.prefersSpeed) s -= pb * 1.8;
    }

    if (
      task.prefersSpeed &&
      !task.prefersHeavy &&
      fastNorm &&
      norm(p.name) === fastNorm
    ) {
      s += 24;
    }

    if (norm(p.name) === norm(defaultModel)) s += 3;
    return s;
  };

  const scored = pool.map((p) => ({ p, score: scoreOf(p) }));
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0].p;

  let reason = task.prefersHeavy ? 'heavier task → larger / capable model' : 'lighter task → smaller / fast model';
  if (task.prefersSpeed) reason += ' · speed-priority prompt';
  if (fastNorm && task.prefersSpeed && norm(winner.name) === fastNorm) reason += ' · fast_model';
  if (task.needsVision) reason += ' · vision';
  if (task.needsTools) reason += ' · tools';
  if (viable.length < profiles.length) reason += ' · filtered by context/caps';

  return { model: winner.name, reason, scores: scored.map((x) => ({ name: x.p.name, score: x.score })) };
}

module.exports = {
  resolveLocalPool,
  parseParameterBillions,
  analyzeLocalTask,
  pickBestLocalModel,
  nameSuggestsVision,
};

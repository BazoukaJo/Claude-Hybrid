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

/**
 * When Ollama /api/show omits parameter_size, infer scale from tag (e.g. llama3.2:3b, mymodel-26b-q4).
 */
function inferParamBillionsFromName(name) {
  const s = String(name || '').toLowerCase();
  const m1 = s.match(/(?:^|[\/:_-])(\d+(?:\.\d+)?)\s*b\b/);
  if (m1) {
    const n = Number(m1[1]);
    return Number.isFinite(n) ? n : null;
  }
  const m2 = s.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b\b/);
  if (m2) {
    const n = Number(m2[2]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function effectiveParamBillions(profile) {
  if (profile.param_billions != null && Number.isFinite(profile.param_billions)) {
    return profile.param_billions;
  }
  const inferred = inferParamBillionsFromName(profile.name);
  if (inferred != null) return inferred;
  return 7;
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

  /** Claude Code sends tool definitions on almost every request — do not treat as “active tool work”. */
  const toolsInSchema = Array.isArray(body.tools) && body.tools.length > 0;

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
  let toolResultsThisTurn = 0;
  if (lastUser) {
    if (typeof lastUser.content === 'string') text = lastUser.content;
    else {
      for (const b of lastUser.content || []) {
        if (b && b.type === 'tool_result') toolResultsThisTurn++;
        else if (b && b.type === 'text') text += `${b.text || ''} `;
      }
      text = text.trim();
    }
  }
  const t = text.toLowerCase();
  const heavyKeywords = [
    'refactor', 'architecture', 'debug', 'complex', 'multi-file', 'performance',
    'security audit', 'system design', 'deep reason', 'race condition', 'design pattern',
    'from scratch', 'data model', 'api design',
  ];
  const hasHeavyKeyword = heavyKeywords.some((k) => t.includes(k));

  /** Tokens in the last user message only — separate from the full-transcript estTokens. */
  const lastUserTokens = Math.ceil(text.length / 4);

  /**
   * Short follow-up in a long session: the user's actual message is brief, carries little
   * new tool context, and has no heavy-intent signals. Keeps the fast model eligible even
   * when the accumulated transcript is large — prevents always picking the big model for
   * trivial follow-ups like “ok fix that” or “add a comment” mid-session.
   */
  const isQuickFollowUp =
    lastUserTokens < 120 &&
    toolResultsThisTurn <= 1 &&
    !hasHeavyKeyword &&
    !needsVision;

  const prefersHeavy =
    !isQuickFollowUp &&
    (estTokens > 3000 ||
    hasHeavyKeyword ||
    toolResultsThisTurn >= 5);

  /** Distinct from “heavy” coding context: math, proofs, explicit reasoning (can be short prompts). */
  const reasoningKeywords = [
    'prove ', 'proof ', 'theorem', 'lemma', 'step by step', 'step-by-step',
    'why does', 'explain why', 'chain of thought', 'mathematical', 'equation',
    'integrate ', 'derivative ', 'logic puzzle', 'brain teaser', 'deduce',
    'infer from', 'formal verification', 'induction', 'contradiction',
    'probability that', 'expected value', 'combinatorics',
  ];
  const prefersReasoning = reasoningKeywords.some((k) => t.includes(k));

  /** Latency-oriented prompts (router analogue to “draft path” / small model — not true speculative decoding). */
  const speedKeywords = [
    'quick answer', 'quickly', 'brief', 'briefly', 'short answer', 'in one sentence',
    'tl;dr', 'tldr', 'concise', 'asap', 'few words', 'one paragraph', 'speed up',
    'low latency', 'respond fast', 'fast as possible',
  ];
  const prefersSpeed =
    !prefersHeavy &&
    !needsVision &&
    toolResultsThisTurn === 0 &&
    speedKeywords.some((k) => t.includes(k));

  return {
    estTokens,
    toolsInSchema,
    toolResultsThisTurn,
    needsVision,
    prefersHeavy,
    prefersReasoning: !!prefersReasoning && !prefersSpeed,
    prefersSpeed,
    isQuickFollowUp,
  };
}

function nameSuggestsVision(name) {
  return /llava|vision|vl-|qwen.*vl|bakllava|moondream|minicpm-v|internvl|pixtral/i.test(String(name || ''));
}

/** Coding-oriented tags (tool + code quality) — boosts when tools are in play or tool results are heavy. */
function nameSuggestsCoder(name) {
  return /coder|code-|starcoder|codestral|codellama|deepseek.*coder|qwen.*coder|granite-code|command-r|devstral|mistral-nemo|phi4|gpt-oss|solar-pro|wizardcoder|phind|duckdb-nsm|gemma|llama3|llama-3|qwen2|qwen3|mistral|mixtral/i.test(
    String(name || ''),
  );
}

/** Tags often used for reasoning / thinking variants (complements Ollama capability flags). */
function nameSuggestsReasoning(name) {
  return /\b(r1\b|qwq|deepseek-r1|reasoning|think|thinking|-think|magistral|nemotron|gpt-oss|olmo|exaone)/i.test(
    String(name || ''),
  );
}

/** Only models explicitly marked non-tool should be skipped when Claude sends a tool schema. */
function toolCapableProfile(p) {
  return p.has_tools !== false;
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

  const toolsInSchema =
    task.toolsInSchema !== undefined && task.toolsInSchema !== null
      ? !!task.toolsInSchema
      : !!task.needsTools; /* backward compat: external callers may set needsTools */
  const toolResultsThisTurn =
    task.toolResultsThisTurn != null && Number.isFinite(task.toolResultsThisTurn)
      ? Math.max(0, Math.trunc(task.toolResultsThisTurn))
      : 0;
  const needsVision = !!task.needsVision;
  const prefersHeavy = !!task.prefersHeavy;
  const prefersSpeed = !!task.prefersSpeed;
  const prefersReasoning = !!task.prefersReasoning;
  const isQuickFollowUp = !!task.isQuickFollowUp;

  const viable = profiles.filter((p) => {
    if (p.context_max != null && Number.isFinite(p.context_max) && p.context_max < minCtx) return false;
    if (needsVision && p.has_vision === false && !nameSuggestsVision(p.name)) return false;
    if (toolsInSchema && !toolCapableProfile(p)) return false;
    return true;
  });
  const pool = viable.length ? viable : profiles;

  const activeToolPayload = toolResultsThisTurn > 0;
  /** Several tool outputs this turn but below prefersHeavy threshold — favor larger models slightly. */
  const midToolTurn =
    !prefersHeavy && activeToolPayload && toolResultsThisTurn >= 2 && toolResultsThisTurn < 5;
  const coderBoostWeight = toolsInSchema || activeToolPayload ? 1 : 0;

  const scoreOf = (p) => {
    let s = 0;
    const pb = effectiveParamBillions(p);
    const toolCap = toolCapableProfile(p);
    const ctxMax = p.context_max != null && Number.isFinite(p.context_max) ? p.context_max : null;
    if (ctxMax != null && ctxMax >= minCtx) {
      s += Math.min(6, (ctxMax - minCtx) / 16384);
    }

    let toolShapeBonus = 0;
    if (toolsInSchema && toolCap) toolShapeBonus += 3;
    if (activeToolPayload && toolCap) toolShapeBonus += 8 + Math.min(10, toolResultsThisTurn * 1.2);
    if (coderBoostWeight && nameSuggestsCoder(p.name)) s += 5 + (activeToolPayload ? 4 : 0);

    if (prefersHeavy) {
      s += pb * 4;
      if (p.has_reasoning === true) s += 5;
      s += toolShapeBonus;
      if (p.has_vision === true) s += needsVision ? 14 : 0;
      else if (needsVision && nameSuggestsVision(p.name)) s += 8;
    } else {
      const lightSizePenalty = midToolTurn ? 0.85 : 2.5;
      s -= pb * lightSizePenalty;
      s += toolShapeBonus;
      if (midToolTurn) s += pb * 1.35;
      if (p.has_vision === true) s += needsVision ? 15 : 0;
      else if (needsVision && nameSuggestsVision(p.name)) s += 10;
      if (pb < 4) s += 6;
      if (prefersSpeed) s -= pb * 1.8;
      if (toolsInSchema && toolCap && !activeToolPayload && pb <= 9) s += 4;
    }

    if ((prefersSpeed || isQuickFollowUp) && !prefersHeavy && fastNorm && norm(p.name) === fastNorm) {
      s += 24;
    }

    if (prefersReasoning) {
      if (p.has_reasoning === true) s += 13;
      if (nameSuggestsReasoning(p.name)) s += 11;
      s += Math.min(20, pb * 1.25);
    }

    if (norm(p.name) === norm(defaultModel)) s += 3;
    return s;
  };

  const scored = pool.map((p) => ({ p, score: scoreOf(p) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = norm(a.p.name) === norm(defaultModel);
    const db = norm(b.p.name) === norm(defaultModel);
    if (da !== db) return db ? 1 : -1;
    return norm(a.p.name).localeCompare(norm(b.p.name));
  });
  const winner = scored[0].p;

  let reason = prefersHeavy ? 'heavier task → larger / capable model' : 'lighter task → smaller / fast model';
  if (prefersSpeed) reason += ' · speed-priority prompt';
  if (isQuickFollowUp) reason += ' · quick follow-up';
  if (fastNorm && (prefersSpeed || isQuickFollowUp) && norm(winner.name) === fastNorm) reason += ' · fast_model';
  if (needsVision) reason += ' · vision';
  if (toolsInSchema) reason += ' · tools in schema';
  if (prefersReasoning) reason += ' · reasoning-oriented prompt';
  if (activeToolPayload) {
    reason += ` · ${toolResultsThisTurn} tool results this turn`;
    if (midToolTurn) reason += ' · mid tool-turn';
  }
  if (viable.length < profiles.length) reason += ' · filtered by context/caps';

  return { model: winner.name, reason, scores: scored.map((x) => ({ name: x.p.name, score: x.score })) };
}

module.exports = {
  resolveLocalPool,
  parseParameterBillions,
  inferParamBillionsFromName,
  effectiveParamBillions,
  analyzeLocalTask,
  pickBestLocalModel,
  nameSuggestsVision,
  nameSuggestsCoder,
  nameSuggestsReasoning,
};

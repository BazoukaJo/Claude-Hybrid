'use strict';

const { nameSuggestsVision } = require('./local-model-picker');

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Score names for “primary” default: prefer this kit’s Gemma 26B, then other large instruct models.
 * @param {string} name
 */
function primaryPreferenceScore(name) {
  const n = norm(name);
  if (n.includes('vladimirgav/gemma4-26b') || n.includes('gemma4-26b-16gb')) return 100;
  if ((/26b|22b|32b|70b|405b|120b/.test(n) || /mixtral|command-r\+?|deepseek-r1|qwen2\.5:72|llama3\.1:70|llama3\.3/.test(n)) && !/embed|embedding|rerank|vision|vl-|llava|moondream/.test(n)) {
    return 80;
  }
  if (/gemma4|qwen2\.5|llama3|mistral|phi-4|deepseek/.test(n) && !/embed|embedding|vision|vl-|llava/.test(n)) return 40;
  return 0;
}

/**
 * Choose default + speed-assist names from Ollama /api/tags list.
 * @param {Array<{name:string,size?:number|null}>} models
 * @param {{ fixedPrimary?: string|null }} [opts] - if set, do not re-pick primary (only fast_model)
 * @returns {{ primary: string, fast: string }}
 */
function pickAutoDefaultModels(models, opts = {}) {
  const list = (models || []).filter((m) => m && m.name && String(m.name).trim());
  if (!list.length) return { primary: '', fast: '' };

  const fixedPrimary = opts.fixedPrimary != null && String(opts.fixedPrimary).trim() ? String(opts.fixedPrimary).trim() : null;

  let primary = fixedPrimary || '';
  if (!primary) {
    const scored = list.map((m) => ({
      m,
      pref: primaryPreferenceScore(m.name),
      size: typeof m.size === 'number' && m.size > 0 ? m.size : 0,
    }));
    scored.sort((a, b) => {
      if (b.pref !== a.pref) return b.pref - a.pref;
      if (b.size !== a.size) return b.size - a.size;
      return norm(a.m.name).localeCompare(norm(b.m.name));
    });
    primary = scored[0].m.name;
  }

  const pNorm = norm(primary);
  const rest = list.filter((m) => norm(m.name) !== pNorm);
  if (!rest.length) return { primary, fast: '' };

  const fast = pickFastAssistModel(rest, primary, list);
  return { primary, fast };
}

/**
 * @param {Array<{name:string,size?:number|null}>} rest - installed models excluding primary
 * @param {string} primaryName
 * @param {Array<{name:string,size?:number|null}>} fullList - for primary size comparison
 */
function pickFastAssistModel(rest, primaryName, fullList) {
  const e4b = rest.find((m) => norm(m.name) === 'gemma4:e4b');
  if (e4b) return e4b.name;

  const smallHint = /(:e4b|:1b|:2b|:3b\b|:4b|:7b|qwen2\.5:0\.5b|qwen2\.5:1\.5b|tinyllama|phi-3|phi3|smollm|llama3\.2:1b|llama3\.2:3b|gemma2:2b|gemma:2b|0\.5b|1\.5b)/i;
  const nonVision = rest.filter((m) => !nameSuggestsVision(m.name));
  const pool = nonVision.length ? nonVision : rest;

  const hinted = pool.filter((m) => smallHint.test(m.name));
  if (hinted.length) {
    hinted.sort((a, b) => (a.size || 1e18) - (b.size || 1e18) || norm(a.name).localeCompare(norm(b.name)));
    return hinted[0].name;
  }

  const primaryRow = fullList.find((m) => norm(m.name) === norm(primaryName));
  const primarySize = primaryRow && typeof primaryRow.size === 'number' && primaryRow.size > 0 ? primaryRow.size : null;
  const sized = pool.filter((m) => typeof m.size === 'number' && m.size > 0);
  if (sized.length && primarySize) {
    const smaller = sized.filter((m) => m.size < primarySize);
    const candidates = smaller.length ? smaller : sized;
    candidates.sort((a, b) => a.size - b.size || norm(a.name).localeCompare(norm(b.name)));
    return candidates[0].name;
  }

  if (sized.length) {
    sized.sort((a, b) => a.size - b.size || norm(a.name).localeCompare(norm(b.name)));
    return sized[0].name;
  }

  pool.sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  return pool[0].name;
}

module.exports = {
  pickAutoDefaultModels,
  primaryPreferenceScore,
};

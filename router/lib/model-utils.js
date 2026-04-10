'use strict';

function pathOnly(url) {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

function normModelName(s) {
  return String(s || '').trim().toLowerCase();
}

/** Ollama /api/ps row id (name and model are both used in the wild). */
function psModelId(row) {
  if (!row || typeof row !== 'object') return '';
  const raw = String(row.model || row.name || '').trim();
  return raw;
}

/**
 * Normalized model string without a trailing :tag when the suffix looks like an Ollama tag.
 * Avoids matching `gemma4:latest` to unrelated full names that contain the substring "gemma4".
 */
function stripOptionalOllamaTagNorm(normalized) {
  const s = normModelName(normalized);
  if (!s) return s;
  const i = s.lastIndexOf(':');
  if (i <= 0) return s;
  const tag = s.slice(i + 1);
  if (!/^[a-z0-9._+-]+$/i.test(tag)) return s;
  return s.slice(0, i);
}

/** True if configured model string refers to the same Ollama id as a /api/ps row name. */
function modelNamesMatch(configuredModel, psRowName) {
  const a = normModelName(configuredModel);
  const b = normModelName(psRowName);
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = stripOptionalOllamaTagNorm(a);
  const sb = stripOptionalOllamaTagNorm(b);
  if (sa === sb) return true;
  if (a === sb || sa === b) return true;
  return false;
}

/**
 * Normalize Ollama /api/ps JSON: `{ models: [...] }` or (legacy) a top-level array.
 */
function listPsModels(ps) {
  if (!ps || typeof ps !== 'object') return [];
  let m = ps.models;
  if (Array.isArray(ps)) m = ps;
  if (!Array.isArray(m)) return [];
  return m.filter((row) => row && typeof row === 'object');
}

/**
 * Row from /api/ps that matches the configured router model, or null.
 * Never returns an unrelated row (no "first running model" fallback).
 */
function pickRunningModel(ps, configuredModel) {
  const cfg = String(configuredModel || '').trim();
  if (!cfg) return null;
  const rows = listPsModels(ps);
  for (const row of rows) {
    const id = psModelId(row);
    if (id && modelNamesMatch(cfg, id)) return row;
  }
  return null;
}

/** First process in /api/ps (for unload when default is not loaded). */
function firstLoadedPsRow(ps) {
  const rows = listPsModels(ps);
  return rows[0] || null;
}

function positiveContextInt(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

function maxContextFromShow(show) {
  if (!show) return null;
  const top = positiveContextInt(show.context_length);
  if (top != null) return top;
  const mi = show.model_info || {};
  for (const k of Object.keys(mi)) {
    if (k.endsWith('.context_length')) {
      const v = positiveContextInt(mi[k]);
      if (v != null) return v;
    }
  }
  return positiveContextInt(show.details?.context_length);
}

module.exports = {
  pathOnly,
  normModelName,
  psModelId,
  stripOptionalOllamaTagNorm,
  modelNamesMatch,
  listPsModels,
  pickRunningModel,
  firstLoadedPsRow,
  maxContextFromShow,
};

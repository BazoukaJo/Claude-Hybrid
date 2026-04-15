"use strict";

/**
 * quality-logger.js
 *
 * Tracks cloud routing decisions and response quality to power an automatic
 * improvement feedback loop.
 *
 * HOW IT WORKS
 * ─────────────
 *  1. When a request routes to cloud → startCloud() creates a log entry.
 *  2. When the cloud response ends  → finishCloud() adds quality signals:
 *       response_length, code_blocks, response_ms, could_have_been_local.
 *  3. Optionally (shadow_eval_enabled in config) → startShadowEval() fires
 *     an async mini-prompt to the local fast model, which rates whether the
 *     response truly NEEDED cloud (1 = trivial, 10 = complex).
 *  4. getStats() / getRecentEntries() are exposed via /api/quality-log.
 *
 * IMPROVEMENT LOOP
 * ─────────────────
 *  getStats().suggestions returns routing-refinement hints when a routing
 *  reason consistently produces low-complexity responses (shadow_score < 4)
 *  or very short/simple responses (could_have_been_local high rate).
 *
 * SHADOW EVAL PROMPT (sent to fast / small local model)
 * ──────────────────────────────────────────────────────
 *  The prompt is intentionally tiny so the fast model (e.g. qwen3.5 7B)
 *  can answer with a single digit in < 1 second, adding no user-visible lag.
 */

const fs = require("fs");
const path = require("path");

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum entries kept in the in-memory ring buffer. */
const RING_MAX = 300;

/** Minimum cloud responses before a suggestion is emitted. */
const SUGGESTION_MIN_SAMPLES = 6;

/**
 * "could have been local" threshold: if a cloud response has no code blocks AND
 * is shorter than this many characters, it was probably simple enough for local.
 */
const SIMPLE_RESPONSE_CHARS = 700;

// ─── QualityLogger ─────────────────────────────────────────────────────────────

class QualityLogger {
  /**
   * @param {object} opts
   * @param {string|null} opts.logPath   Path to JSONL log file (null = memory only)
   * @param {boolean} opts.shadowEvalEnabled  Fire async local eval after cloud response
   * @param {string}  opts.shadowEvalModel    Ollama model name for eval (empty = fast_model)
   */
  constructor(opts = {}) {
    this.logPath = opts.logPath || null;
    this.shadowEvalEnabled = !!opts.shadowEvalEnabled;
    this.shadowEvalModel = String(opts.shadowEvalModel || "").trim();

    /** Ring buffer of recent entries — oldest overwritten first. */
    this.ring = [];
    this._ringIdx = 0;

    /** Running aggregates (reset on restart; persisted entries survive in logPath). */
    this.stats = {
      total_cloud: 0,
      total_shadow_eval: 0,
      could_have_been_local: 0,
      shadow_score_sum: 0,
      avg_shadow_score: null,
      /** { [reason_key]: { count, could_local, shadow_sum, shadow_n } } */
      by_reason: {},
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Record the start of a cloud-bound request.
   * Call immediately when routing is decided → returns an entry object.
   *
   * @param {{ reason: string, estTokens: number, model: string }} opts
   * @returns {object} entry  Keep this and pass to finishCloud() later.
   */
  startCloud(opts) {
    const entry = {
      id: `ql_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      ts: new Date().toISOString(),
      routing_reason: String(opts.reason || ""),
      est_tokens: Number(opts.estTokens) || 0,
      cloud_model: String(opts.model || ""),
      // Filled by finishCloud()
      response_length: null,
      code_blocks: null,
      response_ms: null,
      could_have_been_local: null,
      // Filled by startShadowEval() callback
      shadow_score: null,
      shadow_eval_ms: null,
    };
    this.stats.total_cloud++;
    this._addToRing(entry);
    return entry;
  }

  /**
   * Update an entry once the full cloud response text is available.
   *
   * @param {object}  entry         Returned by startCloud()
   * @param {string}  responseText  Full response body (or SSE stream concatenated)
   * @param {number}  responseMs    Wall time since request start
   */
  finishCloud(entry, responseText, responseMs) {
    const text = String(responseText || "");
    const codeBlocks = Math.floor((text.match(/```/g) || []).length / 2);
    const len = text.length;

    // Simple heuristic: short + no code blocks = response was trivial
    const couldHaveBeenLocal = len < SIMPLE_RESPONSE_CHARS && codeBlocks === 0;

    entry.response_length = len;
    entry.code_blocks = codeBlocks;
    entry.response_ms = typeof responseMs === "number" ? Math.round(responseMs) : null;
    entry.could_have_been_local = couldHaveBeenLocal;

    if (couldHaveBeenLocal) this.stats.could_have_been_local++;

    const rk = this._reasonKey(entry.routing_reason);
    if (!this.stats.by_reason[rk]) {
      this.stats.by_reason[rk] = { count: 0, could_local: 0, shadow_sum: 0, shadow_n: 0 };
    }
    this.stats.by_reason[rk].count++;
    if (couldHaveBeenLocal) this.stats.by_reason[rk].could_local++;

    this._persist(entry);
  }

  /**
   * Fire an async shadow evaluation: ask the fast local model to score whether
   * the cloud response truly needed a powerful model (1–10).
   *
   * Must be called AFTER the response has been sent to the client so it adds
   * zero user-facing latency.
   *
   * @param {object}   entry           From startCloud()
   * @param {string}   lastUserText    Last user message text (max 300 chars used)
   * @param {string}   cloudResponse   Cloud response text (max 800 chars used)
   * @param {Function} ollamaGenerateFn  async (model, prompt) → string
   * @param {string}   [modelOverride] Override eval model for this call
   */
  async startShadowEval(entry, lastUserText, cloudResponse, ollamaGenerateFn, modelOverride) {
    if (!this.shadowEvalEnabled || typeof ollamaGenerateFn !== "function") return;
    const evalModel = String(modelOverride || this.shadowEvalModel || "").trim();
    if (!evalModel) return;

    const evalStart = Date.now();
    try {
      const userSnippet = String(lastUserText || "").slice(0, 300);
      const respSnippet = String(cloudResponse || "").slice(0, 800);

      const prompt =
        `Rate 1-10: did this coding AI response REQUIRE a powerful cloud model?\n` +
        `1 = trivial, any small local model could handle this.\n` +
        `10 = complex, definitely needed a powerful cloud model.\n\n` +
        `User asked: ${userSnippet}\n\n` +
        `Response (excerpt): ${respSnippet}\n\n` +
        `Reply with ONLY a single integer 1-10.`;

      const raw = await ollamaGenerateFn(evalModel, prompt);
      const match = String(raw || "").match(/\b([1-9]|10)\b/);
      if (!match) return;

      const score = parseInt(match[1], 10);
      entry.shadow_score = score;
      entry.shadow_eval_ms = Date.now() - evalStart;

      this.stats.total_shadow_eval++;
      this.stats.shadow_score_sum += score;
      this.stats.avg_shadow_score =
        this.stats.shadow_score_sum / this.stats.total_shadow_eval;

      const rk = this._reasonKey(entry.routing_reason);
      if (this.stats.by_reason[rk]) {
        this.stats.by_reason[rk].shadow_sum += score;
        this.stats.by_reason[rk].shadow_n++;
      }

      this._persist(entry);
    } catch (_) {
      // Shadow eval is non-critical — ignore errors silently
    }
  }

  /**
   * Return the last `limit` quality log entries (newest last).
   */
  getRecentEntries(limit = 50) {
    const n = Math.min(limit, this.ring.length);
    if (!n) return [];
    // Ring buffer can wrap; reconstruct chronological order
    const start = this.ring.length < RING_MAX
      ? 0
      : this._ringIdx % RING_MAX;
    const all = [];
    for (let i = 0; i < this.ring.length; i++) {
      const e = this.ring[(start + i) % RING_MAX];
      if (e) all.push(e);
    }
    return all.slice(-n);
  }

  /**
   * Return aggregate stats and routing improvement suggestions.
   */
  getStats() {
    const total = this.stats.total_cloud;
    const byReason = Object.entries(this.stats.by_reason).map(([k, v]) => ({
      reason: k,
      count: v.count,
      could_local_rate: v.count ? +(v.could_local / v.count).toFixed(2) : 0,
      avg_shadow_score: v.shadow_n
        ? +(v.shadow_sum / v.shadow_n).toFixed(1)
        : null,
    }));

    return {
      total_cloud: total,
      total_shadow_eval: this.stats.total_shadow_eval,
      could_have_been_local_count: this.stats.could_have_been_local,
      could_have_been_local_rate:
        total ? +(this.stats.could_have_been_local / total).toFixed(2) : 0,
      avg_shadow_score: this.stats.avg_shadow_score != null
        ? +this.stats.avg_shadow_score.toFixed(1)
        : null,
      by_reason: byReason,
      suggestions: this._buildSuggestions(byReason),
    };
  }

  /**
   * Update shadow eval settings at runtime (e.g. after config reload).
   */
  updateConfig(opts = {}) {
    if (typeof opts.shadowEvalEnabled === "boolean") this.shadowEvalEnabled = opts.shadowEvalEnabled;
    if (typeof opts.shadowEvalModel === "string") this.shadowEvalModel = opts.shadowEvalModel.trim();
    if (typeof opts.logPath === "string") this.logPath = opts.logPath || null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _reasonKey(reason) {
    // Normalise routing reasons to a short category key for grouping.
    if (!reason) return "unknown";
    if (reason.startsWith("keyword")) return "keyword";
    if (reason.includes("token")) return "tokens";
    if (reason.includes("tool result")) return "tool_results";
    if (reason.includes("context")) return "ctx_saturation";
    if (reason.includes("cascade")) return "cascade_abort";
    if (reason.includes("quota") || reason.includes("fallback")) return "fallback";
    if (reason.includes("Claude only") || reason.includes("routing mode")) return "mode_forced";
    return reason.split(" ")[0].slice(0, 20);
  }

  _addToRing(entry) {
    if (this.ring.length < RING_MAX) {
      this.ring.push(entry);
    } else {
      this.ring[this._ringIdx % RING_MAX] = entry;
      this._ringIdx++;
    }
  }

  _persist(entry) {
    if (!this.logPath) return;
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf8");
    } catch (_) {
      // Non-critical: disk write failure should never crash the router
    }
  }

  _buildSuggestions(byReason) {
    const suggestions = [];

    for (const r of byReason) {
      // High "could have been local" rate → routing trigger may be too aggressive
      if (r.count >= SUGGESTION_MIN_SAMPLES && r.could_local_rate >= 0.55) {
        suggestions.push({
          type: "over_escalation",
          reason: r.reason,
          message: `${Math.round(r.could_local_rate * 100)}% of "${r.reason}" requests produced simple responses (no code, short text). This routing trigger may be escalating unnecessarily — consider raising the threshold or narrowing the keyword list.`,
          sample_count: r.count,
          could_local_rate: r.could_local_rate,
        });
      }

      // Low shadow score average → cloud requests were simpler than expected
      if (r.avg_shadow_score != null && r.count >= SUGGESTION_MIN_SAMPLES && r.avg_shadow_score < 4) {
        suggestions.push({
          type: "shadow_score_low",
          reason: r.reason,
          message: `Average shadow score for "${r.reason}" is ${r.avg_shadow_score}/10 — local model rated these as simple. Consider routing this type of request locally.`,
          sample_count: r.count,
          avg_shadow_score: r.avg_shadow_score,
        });
      }
    }

    return suggestions;
  }
}

// ─── Factory / singleton ──────────────────────────────────────────────────────

let _instance = null;

/**
 * Get or create the process-level QualityLogger singleton.
 *
 * @param {object} [opts]  Pass opts only on first call (or after resetForTest()).
 */
function getQualityLogger(opts) {
  if (!_instance) _instance = new QualityLogger(opts || {});
  return _instance;
}

/** Reset singleton — for unit tests only. */
function _resetQualityLogger() { _instance = null; }

module.exports = {
  QualityLogger,
  getQualityLogger,
  _resetQualityLogger,
};

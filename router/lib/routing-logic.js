"use strict";

const ROUTING_MODES = ["hybrid", "cloud", "local"];

/**
 * Estimated-token gate for hybrid routing (~chars/4).
 *
 * Why 32 000 by default:
 *   Claude Code requests include a large system prompt (CLAUDE.md + env block),
 *   git status, and several tool-result file reads.  A typical session turn is
 *   60 000–120 000 characters, which estimates to 15 000–30 000 tokens.
 *   The old 5 000 default sent every single turn to cloud.  32 000 lets routine
 *   coding turns stay local while routing genuinely large context to cloud.
 */
const ROUTING_TOKEN_THRESHOLD_MIN = 1000;
const ROUTING_TOKEN_THRESHOLD_MAX = 2_000_000;
const ROUTING_TOKEN_THRESHOLD_DEFAULT = 32000;

/** Tool-result blocks in the *last user message* that trigger cloud. */
const ROUTING_FILE_READ_THRESHOLD_MIN = 1;
const ROUTING_FILE_READ_THRESHOLD_MAX = 256;
const ROUTING_FILE_READ_THRESHOLD_DEFAULT = 10;

function toIntRoutingField(value, defaultVal) {
  if (value == null || value === "") return defaultVal;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return defaultVal;
  return n;
}

/**
 * Effective thresholds for routing math (pure; does not mutate).
 * Invalid or missing values fall back to shipped defaults, then clamp to safe ranges.
 */
function getEffectiveThresholds(routingCfg) {
  const r = routingCfg && typeof routingCfg === "object" ? routingCfg : {};
  let tt = toIntRoutingField(r.tokenThreshold, ROUTING_TOKEN_THRESHOLD_DEFAULT);
  let fr = toIntRoutingField(r.fileReadThreshold, ROUTING_FILE_READ_THRESHOLD_DEFAULT);
  tt = Math.max(
    ROUTING_TOKEN_THRESHOLD_MIN,
    Math.min(ROUTING_TOKEN_THRESHOLD_MAX, tt),
  );
  fr = Math.max(
    ROUTING_FILE_READ_THRESHOLD_MIN,
    Math.min(ROUTING_FILE_READ_THRESHOLD_MAX, fr),
  );
  return { tokenThreshold: tt, fileReadThreshold: fr };
}

/** Mutates `routing` in place so CFG and /api/stats always reflect clamped values. */
function sanitizeRoutingThresholds(routing) {
  if (!routing || typeof routing !== "object") return;
  const e = getEffectiveThresholds(routing);
  routing.tokenThreshold = e.tokenThreshold;
  routing.fileReadThreshold = e.fileReadThreshold;
}

/**
 * Keywords that use prefix/stem matching (no word-boundary requirement at end).
 * "vulnerabilit" matches vulnerability / vulnerabilities / vulnerable.
 * "threat model" matches threat model / threat modeling / threat models.
 */
const KEYWORD_PREFIX_STEMS = new Set(["vulnerabilit", "threat model"]);

const CONCISE_LOCAL_HINTS = [
  "brief",
  "briefly",
  "concise",
  "quick answer",
  "quick overview",
  "short answer",
  "one paragraph",
  "two paragraphs",
  "in one paragraph",
  "tldr",
  "tl;dr",
  "summary",
  "summarize",
];

const GENERIC_KEYWORD_CONTEXT = {
  audit: [
    "security",
    "auth",
    "authentication",
    "authorization",
    "permission",
    "permissions",
    "vulnerability",
    "threat",
    "exploit",
    "token",
    "secret",
  ],
  "performance optim": [
    "latency",
    "throughput",
    "cpu",
    "memory",
    "query",
    "database",
    "api",
    "benchmark",
    "profil",
    "slow",
  ],
};

function normalizeUserText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function keywordMatches(text, keyword) {
  const kw = normalizeUserText(keyword);
  if (!kw) return false;
  const hay = ` ${normalizeUserText(text)} `;
  if (hay.includes(` ${kw} `)) return true;
  // Prefix/stem matching: keyword is a deliberate word-stem; match any word that
  // starts with it.  Applied to " optim" stems and entries in KEYWORD_PREFIX_STEMS.
  if (KEYWORD_PREFIX_STEMS.has(kw) || kw.endsWith(" optim")) return hay.includes(` ${kw}`);
  return false;
}

function genericKeywordNeedsCloud(
  keyword,
  text,
  estTokens,
  toolResultsThisTurn,
) {
  const ctx = GENERIC_KEYWORD_CONTEXT[keyword];
  if (!ctx) return true;
  if (toolResultsThisTurn > 0) return true;
  // Only escalate based on conversation length when the session is substantial (≥2500 tokens).
  // The previous threshold of 900 was too aggressive: a handful of code-snippet exchanges
  // routinely exceeded it, causing generic "audit logging" requests to be misrouted to cloud.
  if (estTokens >= 2500) return true;
  return ctx.some((hint) => text.includes(hint));
}

/**
 * Canonical routing.mode for hybrid.config.json: hybrid | cloud (Claude API only) | local (Ollama only).
 */
function normalizeRoutingMode(value) {
  const s = String(value == null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (s === "claude" || s === "claude_only" || s === "anthropic")
    return "cloud";
  if (s === "ollama" || s === "ollama_only" || s === "local_only")
    return "local";
  if (ROUTING_MODES.includes(s)) return s;
  return "hybrid";
}

/**
 * Pure routing analysis for /v1/messages (no logging).
 * Tool-result overload is judged on the *last user message* only: Claude Code sends the
 * full transcript each time; counting every historical tool_result made >7 hits trivial,
 * so nothing ever routed locally after a short session.
 *
 * Extended routing fields (all optional, set via hybrid.config.json):
 *   routingCfg.alwaysLocalTerms      — string[] — force local before ALL other rules when
 *                                       last user message contains any of these terms.
 *                                       Useful for sensitive internal names that must never
 *                                       reach cloud regardless of token count or keywords.
 *   routingCfg.forceLocalIfPrivacyTerms — boolean — when true + privacyCustomTerms has
 *                                       entries, force local if any privacy term appears in
 *                                       the last user message (checked after hard thresholds,
 *                                       before keyword escalation).
 *   routingCfg.privacyCustomTerms    — string[] — terms list used by forceLocalIfPrivacyTerms.
 */
function analyzeMessages(body, routingCfg) {
  const msgs = body.messages || [];
  const { tokenThreshold, fileReadThreshold } =
    getEffectiveThresholds(routingCfg);
  const keywords =
    (routingCfg && routingCfg.keywords) || [];

  // ── Extract last user message text early (needed for alwaysLocalTerms) ────
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  let toolResultsThisTurn = 0;
  let lastUserText = "";
  if (lastUser) {
    if (typeof lastUser.content === "string") {
      lastUserText = lastUser.content;
    } else {
      const blocks = Array.isArray(lastUser.content) ? lastUser.content : [];
      for (const b of blocks) {
        if (b.type === "tool_result") toolResultsThisTurn++;
        else if (b && typeof b.text === "string") lastUserText += `${b.text} `;
      }
      lastUserText = lastUserText.trim();
    }
  }

  // ── 0. alwaysLocalTerms — absolute force-local before any escalation ─────
  const alwaysLocalTerms = (routingCfg && routingCfg.alwaysLocalTerms) || [];
  if (alwaysLocalTerms.length > 0) {
    const normText = normalizeUserText(lastUserText);
    for (const term of alwaysLocalTerms) {
      const normTerm = normalizeUserText(term);
      if (normTerm && normText.includes(normTerm)) {
        return { dest: "local", reason: `always-local term "${term}"` };
      }
    }
  }

  let chars = 0;
  for (const m of msgs) {
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ text: typeof m.content === "string" ? m.content : "" }];
    for (const b of blocks) {
      chars += (b.text || b.content || JSON.stringify(b)).length;
    }
  }

  // ── 1. Token threshold ────────────────────────────────────────────────────
  const estTokens = Math.ceil(chars / 4);
  if (estTokens > tokenThreshold) {
    return { dest: "cloud", reason: `~${estTokens} tokens` };
  }

  // ── 2. Local context window saturation ───────────────────────────────────
  // Route to cloud when input fills most of the local context window so the model has
  // enough room to produce a complete response. effectiveNumCtx is injected by server.js
  // at runtime; absent in unit tests (no-op when 0 or missing).
  //
  // Guard: only apply saturation routing when effectiveNumCtx > 32768.
  // The default num_ctx is 16 384.  At 82 % that fires at ~13 435 tokens, which is
  // below the typical Claude Code session size (15 000–30 000 tokens) and means
  // practically every request goes to cloud — defeating local routing entirely.
  // The token-threshold check (step 1) already handles the 16K default correctly.
  // Saturation is only meaningful for models explicitly configured with a large
  // context window (> 32K) where overflow is a real risk.
  const effectiveNumCtx = Number.isFinite(Number(routingCfg && routingCfg.effectiveNumCtx))
    ? Number(routingCfg.effectiveNumCtx) : 0;
  if (effectiveNumCtx > 32768 && estTokens > effectiveNumCtx * 0.82) {
    return { dest: "cloud", reason: `input fills ~${Math.round(estTokens / effectiveNumCtx * 100)}% of local context` };
  }

  // ── 3. Tool-result flood ──────────────────────────────────────────────────
  if (toolResultsThisTurn > fileReadThreshold) {
    return {
      dest: "cloud",
      reason: `${toolResultsThisTurn} tool results this turn`,
    };
  }

  if (lastUser) {
    const text = normalizeUserText(lastUserText);

    // ── 4. forceLocalIfPrivacyTerms — privacy-aware routing ─────────────────
    // Force local when the prompt contains sensitive custom terms, short-circuiting
    // keyword escalation. Only active when below hard thresholds (cloud is a last
    // resort for very large or tool-heavy requests even with sensitive terms).
    const forceLocalIfPrivacy = !!(routingCfg && routingCfg.forceLocalIfPrivacyTerms);
    const privacyTerms = (routingCfg && routingCfg.privacyCustomTerms) || [];
    if (forceLocalIfPrivacy && privacyTerms.length > 0) {
      for (const term of privacyTerms) {
        const normTerm = normalizeUserText(term);
        if (normTerm && text.includes(normTerm)) {
          return { dest: "local", reason: `privacy term "${term}" kept local` };
        }
      }
    }

    // ── 5. Keyword escalation ─────────────────────────────────────────────
    const lastUserTokens = Math.ceil(lastUserText.length / 4);
    const wantsConciseLocal =
      toolResultsThisTurn === 0 &&
      lastUserTokens <= 220 &&
      CONCISE_LOCAL_HINTS.some((hint) => text.includes(hint));
    const matchedKeywords = keywords.filter((k) => keywordMatches(text, k));
    const kw = matchedKeywords[0];
    if (kw) {
      if (wantsConciseLocal && estTokens < Math.min(tokenThreshold, 1800)) {
        return { dest: "local", reason: `concise keyword prompt "${kw}"` };
      }
      if (!genericKeywordNeedsCloud(kw, text, estTokens, toolResultsThisTurn)) {
        return {
          dest: "local",
          reason: `generic keyword prompt "${kw}" stayed local`,
        };
      }
      return { dest: "cloud", reason: `keyword "${kw}"` };
    }
  }

  return { dest: "local", reason: "routine task" };
}

module.exports = {
  analyzeMessages,
  normalizeRoutingMode,
  ROUTING_MODES,
  getEffectiveThresholds,
  sanitizeRoutingThresholds,
  ROUTING_TOKEN_THRESHOLD_MIN,
  ROUTING_TOKEN_THRESHOLD_MAX,
  ROUTING_FILE_READ_THRESHOLD_MIN,
  ROUTING_FILE_READ_THRESHOLD_MAX,
};

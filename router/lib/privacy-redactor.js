"use strict";

const DEFAULT_CLOUD_REDACTION = {
  enabled: false,
  redact_tool_results: true,
  redact_paths: true,
  redact_urls: true,
  redact_emails: true,
  redact_secrets: true,
  redact_ids: true,
  redact_identifiers: false,
  custom_terms: [],
};

const PLACEHOLDER_RE = /^(?:TERM|EMAIL|URL|PATH|SECRET|ID|IDENT)_\d+$/;
const IDENTIFIER_RE =
  /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+|[a-z]+(?:_[a-z0-9]+)+)\b/g;
const RESERVED_IDENTIFIERS = new Set(
  [
    "tool_result",
    "tool_use",
    "input_schema",
    "max_tokens",
    "system",
    "messages",
    "content",
    "prompt",
    "stream",
    "model",
    "httpRequest",
    "json",
    "response",
    "request",
  ].map((v) => String(v).toLowerCase()),
);

function normalizeCloudRedactionConfig(input) {
  const cfg = { ...DEFAULT_CLOUD_REDACTION };
  if (!input || typeof input !== "object") return cfg;
  for (const key of [
    "enabled",
    "redact_tool_results",
    "redact_paths",
    "redact_urls",
    "redact_emails",
    "redact_secrets",
    "redact_ids",
    "redact_identifiers",
  ]) {
    if (typeof input[key] === "boolean") cfg[key] = input[key];
  }
  if (Array.isArray(input.custom_terms)) {
    cfg.custom_terms = input.custom_terms
      .map((term) => String(term || "").trim())
      .filter(Boolean);
  }
  return cfg;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createReplacementState() {
  return {
    maps: new Map(),
    // Monotonic placeholder numbering per category — incremented only when a
    // NEW distinct value is seen.  Kept separate from stats.categories (which
    // counts total occurrences including repeats) so placeholder numbering
    // stays contiguous (EMAIL_1, EMAIL_2, …) even when the same value repeats.
    counters: {
      secret: 0,
      url: 0,
      email: 0,
      path: 0,
      id: 0,
      term: 0,
      identifier: 0,
    },
    stats: {
      redactions: 0,
      categories: {
        secret: 0,
        url: 0,
        email: 0,
        path: 0,
        id: 0,
        term: 0,
        identifier: 0,
      },
    },
  };
}

function stablePlaceholder(state, category, raw) {
  const key = `${category}:${String(raw)}`;
  if (!state.maps.has(key)) {
    state.counters[category] = (state.counters[category] || 0) + 1;
    const prefix = category === "identifier" ? "IDENT" : category.toUpperCase();
    state.maps.set(key, `${prefix}_${state.counters[category]}`);
  }
  state.stats.categories[category] += 1;
  state.stats.redactions += 1;
  return state.maps.get(key);
}

function replaceMatches(text, regex, state, category) {
  return text.replace(regex, (match, ...rest) => {
    const groups = rest.slice(0, -2);
    if (typeof groups[0] === "string" && groups.length > 1) {
      const prefix = groups[0] || "";
      const target = groups[1] || match;
      return `${prefix}${stablePlaceholder(state, category, target)}`;
    }
    return stablePlaceholder(state, category, match);
  });
}

function redactCustomTerms(text, cfg, state) {
  let out = text;
  const ordered = [...cfg.custom_terms].sort((a, b) => b.length - a.length);
  for (const term of ordered) {
    // Purely alphanumeric/underscore terms get word boundaries so short names
    // like "Ace" don't redact "Aces" / "Facebook" / etc.  Terms containing
    // punctuation or spaces keep the literal-match behavior.
    const plain = /^[A-Za-z0-9_]+$/.test(term);
    const pattern = plain
      ? `\\b${escapeRegExp(term)}\\b`
      : escapeRegExp(term);
    const rx = new RegExp(pattern, "gi");
    out = out.replace(rx, (match) => stablePlaceholder(state, "term", match));
  }
  return out;
}

function redactIdentifiers(text, state) {
  return text.replace(IDENTIFIER_RE, (match) => {
    const lower = match.toLowerCase();
    if (PLACEHOLDER_RE.test(match)) return match;
    if (RESERVED_IDENTIFIERS.has(lower)) return match;
    return stablePlaceholder(state, "identifier", match);
  });
}

function redactString(text, cfg, state) {
  let out = String(text);
  if (cfg.redact_secrets) {
    out = replaceMatches(
      out,
      /\b(?:sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      state,
      "secret",
    );
    out = out.replace(
      /\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*["']?)([^\s"'`]{8,})/gi,
      (_match, label, sep, value) =>
        `${label}${sep}${stablePlaceholder(state, "secret", value)}`,
    );
  }
  if (cfg.redact_urls) {
    out = replaceMatches(out, /\bhttps?:\/\/[^\s<>")']+/gi, state, "url");
  }
  if (cfg.redact_emails) {
    out = replaceMatches(
      out,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      state,
      "email",
    );
  }
  if (cfg.redact_paths) {
    out = replaceMatches(
      out,
      /\b[A-Za-z]:\\[^\s"'<>|]+(?:\\[^\s"'<>|]+)*/g,
      state,
      "path",
    );
    out = replaceMatches(
      out,
      /(?:^|\s)(\/[^\s"'<>]+(?:\/[^\s"'<>]+)*)/g,
      state,
      "path",
    );
  }
  if (cfg.redact_ids) {
    out = replaceMatches(
      out,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      state,
      "id",
    );
  }
  if (cfg.custom_terms.length) out = redactCustomTerms(out, cfg, state);
  if (cfg.redact_identifiers) out = redactIdentifiers(out, state);
  return out;
}

function redactValue(value, cfg, state) {
  if (typeof value === "string") return redactString(value, cfg, state);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, cfg, state));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = redactValue(inner, cfg, state);
  }
  return out;
}

function redactMessageContent(content, cfg, state) {
  if (typeof content === "string") return redactString(content, cfg, state);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const next = { ...block };
    if (typeof next.text === "string")
      next.text = redactString(next.text, cfg, state);
    if (next.type === "tool_result" && cfg.redact_tool_results) {
      next.content = redactValue(next.content, cfg, state);
    }
    return next;
  });
}

function redactCloudRequestBody(body, inputCfg) {
  const cfg = normalizeCloudRedactionConfig(inputCfg);
  if (!cfg.enabled || !body || typeof body !== "object") {
    return { body, changed: false, redactions: 0, categories: {} };
  }
  const state = createReplacementState();
  const next = { ...body };
  if (typeof next.system === "string") {
    next.system = redactString(next.system, cfg, state);
  } else if (Array.isArray(next.system)) {
    next.system = next.system.map((block) => {
      if (!block || typeof block !== "object") return block;
      const copy = { ...block };
      if (typeof copy.text === "string")
        copy.text = redactString(copy.text, cfg, state);
      return copy;
    });
  }
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      return {
        ...message,
        content: redactMessageContent(message.content, cfg, state),
      };
    });
  }
  return {
    body: next,
    changed: state.stats.redactions > 0,
    redactions: state.stats.redactions,
    categories: state.stats.categories,
  };
}

module.exports = {
  DEFAULT_CLOUD_REDACTION,
  normalizeCloudRedactionConfig,
  redactCloudRequestBody,
};

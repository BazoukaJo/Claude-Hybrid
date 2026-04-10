"use strict";

const LIMIT_MARKERS = [
  "you've hit your limit",
  "you have hit your limit",
  "hit your limit for claude",
  "rate limit",
  "exceeded your current quota",
  "insufficient credits",
  "credit balance is too low",
];

function matchesLimitMarker(text) {
  const lower = String(text || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'");
  return LIMIT_MARKERS.some((marker) => lower.includes(marker));
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function collectErrorMessages(value, out) {
  if (!value) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectErrorMessages(item, out);
    return;
  }
  if (typeof value !== "object") return;
  if (typeof value.message === "string") out.push(value.message);
  if (typeof value.error === "string") out.push(value.error);
  if (value.error && typeof value.error === "object") {
    collectErrorMessages(value.error, out);
  }
}

function collectSseMessages(text, out) {
  const chunks = String(text || "").split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    if (!chunk) continue;
    let eventName = "";
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim().toLowerCase();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      if (eventName === "error") out.push(payload);
      const parsed = tryParseJson(payload);
      if (parsed) collectErrorMessages(parsed, out);
    }
  }
}

/** True when JSON (any depth) includes Anthropic quota-style error types. */
function valueContainsRateLimitType(value, depth = 0) {
  if (!value || depth > 18) return false;
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsRateLimitType(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const t = value.type;
  if (t === "rate_limit_error") return true;
  return Object.keys(value).some((k) =>
    valueContainsRateLimitType(value[k], depth + 1),
  );
}

function collectCandidates(statusCode, bodyText, contentType = "") {
  const candidates = [];
  const text = String(bodyText || "");
  const type = String(contentType || "").toLowerCase();

  if (statusCode === 429) candidates.push(text);
  if (statusCode >= 400) candidates.push(text);

  const parsed = tryParseJson(text);
  if (parsed) collectErrorMessages(parsed, candidates);

  if (
    type.includes("event-stream") ||
    text.includes("event:") ||
    text.includes("data:")
  ) {
    collectSseMessages(text, candidates);
  }

  return candidates;
}

function getCloudLimitFeedback(statusCode, bodyText, contentType = "") {
  const candidates = collectCandidates(statusCode, bodyText, contentType);
  const match = candidates
    .filter(matchesLimitMarker)
    .sort((a, b) => String(a).length - String(b).length)[0];
  if (match) return String(match).trim();
  if (Number(statusCode) === 429) return "HTTP 429 from Anthropic (rate limited)";
  return "";
}

function isCloudLimitResponse(statusCode, bodyText, contentType = "") {
  if (Number(statusCode) === 429) return true;
  const text = String(bodyText || "");
  const candidates = collectCandidates(statusCode, bodyText, contentType);
  if (candidates.some(matchesLimitMarker)) return true;
  const parsed = tryParseJson(text);
  if (parsed && valueContainsRateLimitType(parsed)) return true;
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("event-stream") || text.includes("data:")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const pl = line.slice(5).trim();
      if (!pl || pl === "[DONE]") continue;
      const p = tryParseJson(pl);
      if (p && valueContainsRateLimitType(p)) return true;
    }
  }
  return false;
}

module.exports = {
  getCloudLimitFeedback,
  isCloudLimitResponse,
};

"use strict";

const LIMIT_MARKERS = [
  "you've hit your limit",
  "you have hit your limit",
  "rate limit",
  "exceeded your current quota",
  "insufficient credits",
  "credit balance is too low",
];

function matchesLimitMarker(text) {
  const lower = String(text || "").toLowerCase();
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
  return match ? String(match).trim() : "";
}

function isCloudLimitResponse(statusCode, bodyText, contentType = "") {
  const candidates = collectCandidates(statusCode, bodyText, contentType);

  return candidates.some(matchesLimitMarker);
}

module.exports = {
  getCloudLimitFeedback,
  isCloudLimitResponse,
};

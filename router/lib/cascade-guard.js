"use strict";

/**
 * cascade-guard.js — Quality escape-hatch for local model streaming.
 *
 * When a local Ollama model emits a refusal/incapability phrase in its first
 * SCAN_CHARS characters, the guard fires 'abort' so the caller can transparently
 * retry the same request against Anthropic cloud — zero user-visible difference.
 *
 * API:
 *   createStreamGuard(upstream, abortPhrases?) → EventEmitter
 *     Emits: 'flushing'       — quality OK, headers can be sent; attach pipeLocalStream now
 *            'abort' {phrase} — phrase detected; caller should fall back to cloud
 *            'data'           — raw chunk (after 'flushing'; replay + live)
 *            'end'            — stream done
 *            'error'          — upstream error
 *
 *   checkNonStreamingContent(text, abortPhrases?) → matchedPhrase | null
 *     For non-streaming responses: check first 480 chars.
 *
 *   extractSSEText(chunk) → string
 *     Decode text tokens from a raw Ollama SSE data chunk.
 */

const { EventEmitter } = require("events");

/** Number of decoded text characters to scan before deciding. */
const SCAN_CHARS = 240;

/**
 * Phrases that signal the local model cannot answer — trigger cloud fallback.
 * All lowercase; matching is case-insensitive (text is lowercased before check).
 */
const DEFAULT_ABORT_PHRASES = [
  "i don't have access to",
  "i do not have access to",
  "i cannot assist with",
  "i'm not able to",
  "i am not able to",
  "as an ai language model",
  "as an ai, i",
  "as an ai assistant",
  "i apologize, i cannot",
  "i apologize but i cannot",
  "i don't have enough information",
  "i don't have enough context",
  "i lack the context",
  "i'm unable to",
  "i am unable to",
  "i cannot determine",
  "i cannot access",
  "i don't have the ability",
  "i lack access to",
];

/**
 * Extract plain-text tokens from a raw Ollama SSE buffer/string chunk.
 * Ollama SSE lines: "data: {"choices":[{"delta":{"content":"token"},...}]}"
 */
function extractSSEText(raw) {
  let out = "";
  const str = typeof raw === "string" ? raw : raw.toString("utf8");
  const lines = str.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const p = JSON.parse(payload);
      const delta = p.choices?.[0]?.delta;
      if (delta) out += delta.content || delta.reasoning || "";
    } catch {
      // ignore malformed SSE frames
    }
  }
  return out;
}

/**
 * Scan up to SCAN_CHARS*2 characters of a non-streaming response text for abort phrases.
 * Returns the first matched phrase (lowercase) or null.
 */
function checkNonStreamingContent(text, abortPhrases) {
  const probe = String(text || "")
    .slice(0, SCAN_CHARS * 2)
    .toLowerCase();
  const phrases = Array.isArray(abortPhrases) ? abortPhrases : DEFAULT_ABORT_PHRASES;
  for (const phrase of phrases) {
    if (probe.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Wrap an Ollama HTTP upstream response in a quality-gate EventEmitter.
 *
 * The guard accumulates decoded text from the first incoming SSE chunks.
 * Once SCAN_CHARS characters are collected (or the stream ends):
 *   - If an abort phrase is detected → emit 'abort' and stop. Caller redirects to cloud.
 *   - Otherwise → emit 'flushing' (caller sends response headers + attaches pipeLocalStream),
 *     then replay all buffered raw chunks via process.nextTick, then forward live chunks + 'end'.
 *
 * process.nextTick ordering guarantee:
 *   nextTick fires BEFORE the next I/O event, so the replay always precedes any
 *   subsequent upstream data events that arrive in a later I/O tick.
 *   When 'end' arrives before the nextTick replay completes (rare: full response in one TCP
 *   packet), the guard defers 'end' until after the replay.
 */
function createStreamGuard(upstream, abortPhrases) {
  const ee = new EventEmitter();
  const phrases = Array.isArray(abortPhrases) ? abortPhrases : DEFAULT_ABORT_PHRASES;

  const pending = [];      // raw Buffer chunks buffered before decision
  let textBuf = "";        // decoded text accumulated for phrase scanning
  let decided = false;
  let aborted = false;
  let replayDone = false;
  let pendingEndEvent = false;

  function decide(matchedPhrase) {
    if (decided) return;
    decided = true;

    if (matchedPhrase) {
      aborted = true;
      ee.emit("abort", { phrase: matchedPhrase });
      return;
    }

    // Quality OK — notify caller so it can write response headers and attach pipeLocalStream
    // BEFORE the buffered data is replayed.
    ee.emit("flushing");

    // Replay buffered chunks in the next tick (before any live upstream data event).
    process.nextTick(() => {
      const toReplay = pending.splice(0);
      for (const chunk of toReplay) ee.emit("data", chunk);
      replayDone = true;
      if (pendingEndEvent) ee.emit("end");
    });
  }

  upstream.on("data", (chunk) => {
    if (aborted) return;
    if (!decided) {
      pending.push(chunk);
      textBuf += extractSSEText(chunk);
      if (textBuf.length >= SCAN_CHARS) {
        decide(checkNonStreamingContent(textBuf, phrases));
      }
      return;
    }
    // Decision already made — forward directly
    ee.emit("data", chunk);
  });

  upstream.on("end", () => {
    if (!decided) {
      // Response shorter than SCAN_CHARS — check what accumulated
      const matched = checkNonStreamingContent(textBuf, phrases);
      if (matched) {
        decided = true;
        aborted = true;
        ee.emit("abort", { phrase: matched });
        return;
      }
      decided = true;
      ee.emit("flushing");
      process.nextTick(() => {
        const toReplay = pending.splice(0);
        for (const chunk of toReplay) ee.emit("data", chunk);
        ee.emit("end");
      });
      return;
    }
    if (aborted) return;
    if (replayDone) {
      ee.emit("end");
    } else {
      // Replay nextTick is still pending — defer end until it finishes
      pendingEndEvent = true;
    }
  });

  upstream.on("error", (err) => {
    if (!aborted) ee.emit("error", err);
  });

  return ee;
}

module.exports = {
  SCAN_CHARS,
  DEFAULT_ABORT_PHRASES,
  extractSSEText,
  checkNonStreamingContent,
  createStreamGuard,
};

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  normalizeTimeZone,
  formatClockTime,
} = require("../router/lib/time-format");

test("normalizeTimeZone accepts valid IANA zone", () => {
  assert.strictEqual(normalizeTimeZone("America/Toronto"), "America/Toronto");
});

test("normalizeTimeZone rejects invalid zone", () => {
  assert.strictEqual(normalizeTimeZone("Montreal/Local"), "");
});

test("formatClockTime renders Toronto winter time in HH:MM:SS", () => {
  const date = new Date("2026-01-15T17:04:05Z");
  assert.strictEqual(formatClockTime(date, "America/Toronto"), "12:04:05");
});

test("formatClockTime renders Toronto summer time in HH:MM:SS", () => {
  const date = new Date("2026-07-15T16:04:05Z");
  assert.strictEqual(formatClockTime(date, "America/Toronto"), "12:04:05");
});

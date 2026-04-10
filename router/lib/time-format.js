"use strict";

function normalizeTimeZone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    Intl.DateTimeFormat("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: raw,
    }).format(new Date());
    return raw;
  } catch {
    return "";
  }
}

function localResolvedTimeZone() {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "";
  }
}

function clockFormatter(timeZone) {
  const options = {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  const normalized = normalizeTimeZone(timeZone);
  if (normalized) options.timeZone = normalized;
  return new Intl.DateTimeFormat("en-CA", options);
}

function formatClockTime(date = new Date(), timeZone) {
  try {
    const parts = clockFormatter(timeZone).formatToParts(date);
    const byType = Object.create(null);
    for (const part of parts) {
      if (part && part.type && !(part.type in byType))
        byType[part.type] = part.value;
    }
    if (byType.hour && byType.minute && byType.second) {
      return `${byType.hour}:${byType.minute}:${byType.second}`;
    }
  } catch {}
  return String(date.toTimeString()).slice(0, 8);
}

module.exports = {
  normalizeTimeZone,
  localResolvedTimeZone,
  formatClockTime,
};

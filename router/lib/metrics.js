"use strict";

const { formatClockTime } = require("./time-format");

function createMetrics() {
  const m = {
    requests_total: 0,
    routed_local: 0,
    routed_cloud: 0,
    fallback_to_cloud: 0,
    fallback_to_local: 0,
    cascade_aborts: 0,
    startedAt: Date.now(),
  };
  let lastRoute = null;

  return {
    bumpRequest() {
      m.requests_total++;
    },
    recordRoute(dest, reason, fallback, timeStr) {
      lastRoute = {
        time: timeStr || formatClockTime(new Date()),
        dest,
        reason: String(reason || ""),
        fallback: !!fallback,
      };
      if (fallback) {
        if (dest === "cloud") m.fallback_to_cloud++;
        else m.fallback_to_local++;
      } else if (dest === "local") m.routed_local++;
      else m.routed_cloud++;
    },
    /** Record a cascade quality abort: local started streaming but bailed to cloud. */
    recordCascadeAbort(_modelName) {
      m.cascade_aborts++;
    },
    getLastRoute() {
      return lastRoute;
    },
    snapshot() {
      return {
        requests_total: m.requests_total,
        routed_local: m.routed_local,
        routed_cloud: m.routed_cloud,
        fallback_to_cloud: m.fallback_to_cloud,
        fallback_to_local: m.fallback_to_local,
        cascade_aborts: m.cascade_aborts,
        uptime_seconds: Math.floor((Date.now() - m.startedAt) / 1000),
      };
    },
  };
}

module.exports = { createMetrics };

"use strict";

/**
 * Routing-logic validation.
 *
 * Tests the pure analyzeMessages() function against real-world payload shapes:
 *   - Small greetings / fixes stay local (saves API quota)
 *   - Keywords escalate to cloud
 *   - Token threshold gates large transcripts
 *   - Tool-result count gates heavy tool turns
 *   - Context-saturation guard works but only above 8 192 ctx
 */

const { analyzeMessages } = require("../router/lib/routing-logic");
const fs = require("fs");
const path = require("path");

// Load thresholds + keywords straight from the shipped example config
const exCfg = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../router/hybrid.config.example.json"),
    "utf8",
  ),
);
const ROUTING = {
  tokenThreshold: exCfg.routing.tokenThreshold,     // 32 000
  fileReadThreshold: exCfg.routing.fileReadThreshold, // 10
  keywords: exCfg.routing.keywords,
};

let passed = 0;
let failed = 0;

function check(label, result, expectedDest, expectedReasonPart) {
  const destOk = result.dest === expectedDest;
  const reasonOk =
    !expectedReasonPart || result.reason.includes(expectedReasonPart);
  if (destOk && reasonOk) {
    console.log(`  [PASS] ${label}`);
    console.log(`         dest=${result.dest}  reason="${result.reason}"`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    console.log(`         dest=${result.dest}  reason="${result.reason}"`);
    if (!destOk)
      console.log(`         EXPECTED dest=${expectedDest}`);
    if (!reasonOk)
      console.log(`         EXPECTED reason to include "${expectedReasonPart}"`);
    failed++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Single user text message in content-array format (same as Claude Code sends). */
function msg(text) {
  return {
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

/** Last user message that is purely tool_result blocks (like a file-read turn). */
function toolResultMsg(count) {
  const content = Array.from({ length: count }, (_, i) => ({
    type: "tool_result",
    tool_use_id: `call-${i}`,
    content: `// file ${i} content placeholder`,
  }));
  return { messages: [{ role: "user", content }] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("══ ROUTING VALIDATION ══════════════════════════════════════════");
console.log(
  `Config: tokenThreshold=${ROUTING.tokenThreshold}` +
    `, fileReadThreshold=${ROUTING.fileReadThreshold}` +
    `, keywords=${ROUTING.keywords.length}`,
);
console.log();

// 1. Tiny greeting → local
check(
  "tiny greeting stays local",
  analyzeMessages(msg("hi"), ROUTING),
  "local",
);

// 2. Short code fix → local
check(
  "short code fix stays local",
  analyzeMessages(
    msg("Extract this logic into a helper and add a null check."),
    ROUTING,
  ),
  "local",
);

// 3. Security-audit keyword → cloud
check(
  'keyword "security audit" → cloud',
  analyzeMessages(
    msg("Please do a security audit of this authentication flow."),
    ROUTING,
  ),
  "cloud",
  "keyword",
);

// 4. Architect keyword → cloud
check(
  'keyword "architect" → cloud',
  analyzeMessages(
    msg(
      "We need to architect a new service boundary between billing and auth.",
    ),
    ROUTING,
  ),
  "cloud",
  "keyword",
);

// 5. Huge transcript → cloud (chars > tokenThreshold * 4)
const bigText = "x".repeat(ROUTING.tokenThreshold * 4 + 200);
check(
  `huge transcript (>${ROUTING.tokenThreshold} tokens) → cloud`,
  analyzeMessages(msg(bigText), ROUTING),
  "cloud",
  "tokens",
);

// 6. tool_results > fileReadThreshold → cloud
check(
  `${ROUTING.fileReadThreshold + 1} tool results this turn → cloud`,
  analyzeMessages(toolResultMsg(ROUTING.fileReadThreshold + 1), ROUTING),
  "cloud",
  "tool results",
);

// 7. Exactly at fileReadThreshold → local (boundary, not exceeded)
check(
  `exactly ${ROUTING.fileReadThreshold} tool results stays local`,
  analyzeMessages(toolResultMsg(ROUTING.fileReadThreshold), ROUTING),
  "local",
);

// 8. effectiveNumCtx ≤ 8192 → saturation guard skips (no false cloud routing)
//    82 % of 4 096 = 3 358 tokens; should NOT route to cloud.
const smallCtxCfg = { ...ROUTING, effectiveNumCtx: 4096 };
const text3500tok = "x".repeat(3500 * 4); // ~3 500 tokens
check(
  "saturation guard skipped when effectiveNumCtx ≤ 8192",
  analyzeMessages(msg(text3500tok), smallCtxCfg),
  "local",
);

// 9. effectiveNumCtx = 16384 + tokens > 82 % → cloud
//    82 % of 16 384 = 13 434 tokens
const largeCtxCfg = { ...ROUTING, effectiveNumCtx: 16384 };
const text14000tok = "x".repeat(14000 * 4); // ~14 000 tokens > 13 434
check(
  "saturation fires when effectiveNumCtx=16384 and tokens ~14 000 → cloud",
  analyzeMessages(msg(text14000tok), largeCtxCfg),
  "cloud",
  "local context",
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log();
console.log(`  Result: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

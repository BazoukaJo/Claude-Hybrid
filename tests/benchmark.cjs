"use strict";

/**
 * benchmark.cjs — Claude-Hybrid Router Comprehensive Benchmark
 *
 * Dimensions:
 *   1. Routing accuracy       — 57 scenarios, expected vs actual dest
 *   2. Cost savings estimate  — 200-message workload, projected $/1k msgs
 *   3. Privacy layer coverage — redaction hit-rate across all categories
 *   4. Quality trade-off      — routing appropriateness by task complexity
 *   5. Improvement report     — auto-suggested fixes from failing scenarios
 *   6. Team features          — cascade guard, alwaysLocalTerms, forceLocalIfPrivacyTerms
 *
 * Run: node tests/benchmark.cjs
 * No external deps required.
 *
 * Exit code 0 = all accuracy scenarios pass.
 * Exit code 1 = one or more accuracy scenarios fail (improvement needed).
 */

const { analyzeMessages } = require("../router/lib/routing-logic");
const { redactCloudRequestBody } = require("../router/lib/privacy-redactor");
const {
  checkNonStreamingContent,
  extractSSEText,
  createStreamGuard,
  DEFAULT_ABORT_PHRASES,
  SCAN_CHARS,
} = require("../router/lib/cascade-guard");
const { EventEmitter } = require("events");
const fs   = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Config — load production defaults from example file
// ─────────────────────────────────────────────────────────────────────────────
const examplePath = path.join(__dirname, "..", "router", "hybrid.config.example.json");
const exampleCfg  = JSON.parse(fs.readFileSync(examplePath, "utf8"));
const ROUTING = {
  tokenThreshold:    exampleCfg.routing.tokenThreshold,
  fileReadThreshold: exampleCfg.routing.fileReadThreshold,
  keywords:          exampleCfg.routing.keywords,
};

// Anthropic Sonnet 3.5 pricing (per 1M tokens)
const PRICE_INPUT_PER_MTOK  = 3.00;
const PRICE_OUTPUT_PER_MTOK = 15.00;
// Local Ollama cost: negligible (electricity amortised ~0.1% of cloud cost)
const LOCAL_COST_FACTOR     = 0.001;

// ─────────────────────────────────────────────────────────────────────────────
// Message builders
// ─────────────────────────────────────────────────────────────────────────────
const msg = (text) => ({ messages: [{ role: "user", content: [{ type: "text", text }] }] });

const msgTools = (n) => ({
  messages: [{
    role: "user",
    content: Array.from({ length: n }, (_, i) => ({
      type: "tool_result",
      tool_use_id: `t${i}`,
      content: `{"file":"src/module${i}.ts","lines":80}`,
    })),
  }],
});

const msgLong = (chars) => msg("x".repeat(chars));

// Multi-turn history followed by a short final message
const msgHistory = (historyChars, finalText) => ({
  messages: [
    { role: "user",      content: [{ type: "text", text: "x".repeat(historyChars) }] },
    { role: "assistant", content: [{ type: "text", text: "Understood. What next?" }] },
    { role: "user",      content: [{ type: "text", text: finalText }] },
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Routing accuracy scenarios
//
// tier:
//   localOk      — local model fully adequate; routing local has zero quality loss
//   cloudBetter  — cloud model clearly superior; routing local risks quality drop
//   neutral       — either tier works; boundary / structural test
//
// knownIssue: present on scenarios that FAIL before a planned fix
// ─────────────────────────────────────────────────────────────────────────────
const SCENARIOS = [

  // ── Greetings / tiny follow-ups (always local) ───────────────────────────
  { label: "hi",                               body: msg("hi"),                                                                     expect: "local", tier: "localOk" },
  { label: "ok thanks",                        body: msg("ok thanks"),                                                              expect: "local", tier: "localOk" },
  { label: "yes apply that",                   body: msg("yes, apply that"),                                                        expect: "local", tier: "localOk" },
  { label: "looks good continue",              body: msg("looks good, continue"),                                                   expect: "local", tier: "localOk" },

  // ── Quick code help (local) ──────────────────────────────────────────────
  { label: "fix typo on line 3",               body: msg("fix the typo on line 3"),                                                 expect: "local", tier: "localOk" },
  { label: "add null check",                   body: msg("add a null check before the return"),                                     expect: "local", tier: "localOk" },
  { label: "rename variable",                  body: msg("rename this variable to `userId`"),                                       expect: "local", tier: "localOk" },
  { label: "add JSDoc",                        body: msg("add JSDoc comments to this method"),                                      expect: "local", tier: "localOk" },
  { label: "extract helper function",          body: msg("extract this block into a helper function"),                              expect: "local", tier: "localOk" },
  { label: "write unit test",                  body: msg("write a unit test for parseDate()"),                                      expect: "local", tier: "localOk" },
  { label: "add error handling",               body: msg("add try/catch error handling to this async route"),                       expect: "local", tier: "localOk" },
  { label: "format JSON",                      body: msg("format this JSON output for readability"),                                expect: "local", tier: "localOk" },
  { label: "TypeError question",               body: msg("why does this throw TypeError: Cannot read properties of undefined?"),    expect: "local", tier: "localOk" },
  { label: "module not found error",           body: msg("Why does Node throw \"Cannot find module './x'\" here?"),                 expect: "local", tier: "localOk" },
  { label: "async/await usage",                body: msg("how do I use async/await in this function?"),                            expect: "local", tier: "localOk" },
  { label: "simple refactor no keywords",      body: msg("extract this into a helper and add a null check before the return"),     expect: "local", tier: "localOk" },
  { label: "add type annotation",              body: msg("add TypeScript type annotations to this function signature"),             expect: "local", tier: "localOk" },

  // ── Generic "audit" without security context (local) ─────────────────────
  { label: "audit logging endpoint",           body: msg("add audit logging to this endpoint"),                                    expect: "local", tier: "localOk" },
  { label: "audit trail user actions",         body: msg("add an audit trail to track user actions in the dashboard"),             expect: "local", tier: "localOk" },
  { label: "audit log with request id",        body: msg("add audit logging and include the request id"),                          expect: "local", tier: "localOk" },

  // ── Generic "audit" in a medium-length conversation (local — FIX: raise threshold 900→2500) ──
  { label: "audit in medium conversation",
    body: msgHistory(3600, "add audit logging to this route"),
    expect: "local", tier: "localOk",
    knownIssue: "genericKeyword token threshold 900 → 2500 needed",
  },

  // ── Generic "performance optim" without cloud context (local) ────────────
  { label: "perf optim webpack no context",    body: msg("add performance optimization hints to webpack config"),                  expect: "local", tier: "localOk" },

  // ── Concise keywords override cloud keywords (local) ─────────────────────
  { label: "concise: brief system design",     body: msg("Give me a brief system design summary in one paragraph."),               expect: "local", tier: "neutral" },
  { label: "concise: short design pattern",    body: msg("Short answer: what design pattern works for retry logic?"),              expect: "local", tier: "neutral" },
  { label: "concise: summarize api design",    body: msg("Summarize the api design approach in two paragraphs."),                  expect: "local", tier: "neutral" },
  { label: "concise: quick deep reason",       body: msg("quick answer: deep reason why this algorithm fails"),                   expect: "local", tier: "neutral" },
  { label: "concise: tldr system design",      body: msg("tldr of system design considerations for this feature"),                expect: "local", tier: "neutral" },

  // ── Direct cloud keywords ─────────────────────────────────────────────────
  { label: "architect microservices",          body: msg("I need to architect a new microservices boundary"),                      expect: "cloud", tier: "cloudBetter" },
  { label: "security audit auth flow",         body: msg("do a security audit of this authentication flow"),                      expect: "cloud", tier: "cloudBetter" },
  { label: "design pattern job queue",         body: msg("which design pattern fits a job queue with retries?"),                  expect: "cloud", tier: "cloudBetter" },
  { label: "race condition goroutines",        body: msg("I suspect a race condition between these two goroutines"),              expect: "cloud", tier: "cloudBetter" },
  { label: "system design read-heavy API",     body: msg("help with system design for a read-heavy API service"),                 expect: "cloud", tier: "cloudBetter" },
  { label: "data model multi-tenant SaaS",     body: msg("design the data model for a multi-tenant SaaS application"),           expect: "cloud", tier: "cloudBetter" },
  { label: "deep reason O(n²)",                body: msg("deep reason through why this has O(n²) time complexity"),               expect: "cloud", tier: "cloudBetter" },
  { label: "api design realtime collab",       body: msg("we need api design for a real-time collaboration endpoint"),            expect: "cloud", tier: "cloudBetter" },
  { label: "system design UPPERCASE",          body: msg("SYSTEM DESIGN for a distributed cache cluster"),                        expect: "cloud", tier: "cloudBetter" },
  { label: "race condition useEffects",        body: msg("is there a race condition between these two useEffects?"),              expect: "cloud", tier: "cloudBetter" },
  { label: "architect billing system",         body: msg("architect the entire billing and subscription system"),                 expect: "cloud", tier: "cloudBetter" },

  // ── Generic "audit" with security context (escalates to cloud) ───────────
  { label: "audit + auth tokens context",      body: msg("audit the authentication tokens and permissions flow"),                 expect: "cloud", tier: "cloudBetter" },
  { label: "audit + vulnerability context",    body: msg("audit this endpoint for vulnerability exploits and token leaks"),       expect: "cloud", tier: "cloudBetter" },
  { label: "audit + security context",         body: msg("audit this module — check authentication and secret handling"),         expect: "cloud", tier: "cloudBetter" },

  // ── Generic "performance optim" with cloud context (escalates to cloud) ──
  { label: "perf optim + slow DB queries",     body: msg("need performance optimization for slow database queries"),              expect: "cloud", tier: "cloudBetter" },
  { label: "perf optim + CPU latency",         body: msg("performance optimization of the CPU-bound latency bottleneck"),        expect: "cloud", tier: "cloudBetter" },
  { label: "perf optim + memory/throughput",   body: msg("performance optimization to reduce memory usage and throughput"),       expect: "cloud", tier: "cloudBetter" },

  // ── NEW: standalone vulnerability (FIX: add 'vulnerabilit' keyword) ──────
  { label: "vulnerability check auth module",
    body: msg("check for vulnerabilities in this authentication module"),
    expect: "cloud", tier: "cloudBetter",
    knownIssue: "add 'vulnerabilit' to keywords",
  },
  { label: "vulnerability scan API endpoint",
    body: msg("perform a vulnerability scan of this API endpoint"),
    expect: "cloud", tier: "cloudBetter",
    knownIssue: "add 'vulnerabilit' to keywords",
  },
  { label: "find vulnerabilities login flow",
    body: msg("find all vulnerabilities in this login flow"),
    expect: "cloud", tier: "cloudBetter",
    knownIssue: "add 'vulnerabilit' to keywords",
  },

  // ── NEW: threat modeling (FIX: add 'threat model' keyword) ───────────────
  { label: "threat model payment service",
    body: msg("create a threat model for this payment service"),
    expect: "cloud", tier: "cloudBetter",
    knownIssue: "add 'threat model' to keywords",
  },
  { label: "threat modeling user auth",
    body: msg("let's do threat modeling for the user authentication system"),
    expect: "cloud", tier: "cloudBetter",
    knownIssue: "add 'threat model' to keywords",
  },

  // ── Token threshold ───────────────────────────────────────────────────────
  { label: `large transcript → cloud`,         body: msgLong(ROUTING.tokenThreshold * 4 + 100),                                   expect: "cloud", tier: "cloudBetter" },
  { label: `just below threshold → local`,     body: msgLong((ROUTING.tokenThreshold - 200) * 4),                                 expect: "local", tier: "neutral" },

  // ── Tool-result threshold ─────────────────────────────────────────────────
  { label: `${ROUTING.fileReadThreshold + 1} tool results → cloud`, body: msgTools(ROUTING.fileReadThreshold + 1),                expect: "cloud", tier: "cloudBetter" },
  { label: `${ROUTING.fileReadThreshold} tool results → local`,     body: msgTools(ROUTING.fileReadThreshold),                    expect: "local", tier: "neutral" },
  { label: "1 tool result → local",            body: msgTools(1),                                                                  expect: "local", tier: "localOk" },
  { label: "5 tool results → local",           body: msgTools(5),                                                                  expect: "local", tier: "neutral" },
];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Cost savings simulation (200-message workload)
// ─────────────────────────────────────────────────────────────────────────────
// Each category: {weight%, body, label, avgInputTok, avgOutputTok}
const WORKLOAD_CATEGORIES = [
  { weight: 15, body: msg("hi"),                                             label: "greeting",      avgIn: 10,   avgOut: 50   },
  { weight: 25, body: msg("what does this function return?"),                label: "quick_question", avgIn: 100,  avgOut: 300  },
  { weight: 15, body: msg("extract this into a helper and add null check"),  label: "code_task",      avgIn: 400,  avgOut: 800  },
  { weight: 10, body: msg("architect a new service boundary here"),          label: "architecture",   avgIn: 300,  avgOut: 1500 },
  { weight: 10, body: msgLong(2000 * 4),                                     label: "long_transcript", avgIn: 2500, avgOut: 1000 },
  { weight:  8, body: msg("help me with system design for this service"),    label: "system_design",  avgIn: 400,  avgOut: 2000 },
  { weight:  5, body: msg("do a security audit of this authentication flow"), label: "security_audit", avgIn: 500, avgOut: 2000 },
  { weight:  5, body: msgTools(12),                                           label: "heavy_tools",   avgIn: 1500, avgOut: 2000 },
  { weight:  4, body: msg("which design pattern fits this plugin system?"),  label: "design_pattern", avgIn: 200,  avgOut: 800  },
  { weight:  3, body: msg("add audit logging to this route"),                label: "audit_generic",  avgIn: 100,  avgOut: 300  },
];

function runCostSimulation() {
  let totalLocal = 0, totalCloud = 0;
  let costCloudOnly = 0, costHybrid = 0;
  const breakdown = [];

  for (const cat of WORKLOAD_CATEGORIES) {
    const n = Math.round(200 * cat.weight / 100);
    const result = analyzeMessages(cat.body, ROUTING);
    const dest = result.dest;

    const perMsgCost = (cat.avgIn / 1e6) * PRICE_INPUT_PER_MTOK
                     + (cat.avgOut / 1e6) * PRICE_OUTPUT_PER_MTOK;
    const hybridCost = dest === "local" ? perMsgCost * LOCAL_COST_FACTOR : perMsgCost;

    for (let i = 0; i < n; i++) {
      if (dest === "local") totalLocal++; else totalCloud++;
      costCloudOnly += perMsgCost;
      costHybrid    += hybridCost;
    }
    breakdown.push({ label: cat.label, n, dest, perMsgCost });
  }
  return { totalLocal, totalCloud, costCloudOnly, costHybrid, breakdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Privacy layer coverage
// ─────────────────────────────────────────────────────────────────────────────
const FULL_REDACT_CFG = {
  enabled: true,
  redact_secrets: true,
  redact_urls:    true,
  redact_emails:  true,
  redact_paths:   true,
  redact_ids:     true,
  redact_tool_results: true,
  redact_identifiers: false,
  custom_terms: [],
};

function mkBody(text, customTerms) {
  const cfg = customTerms ? { ...FULL_REDACT_CFG, custom_terms: customTerms } : FULL_REDACT_CFG;
  return {
    body: { messages: [{ role: "user", content: [{ type: "text", text }] }] },
    cfg,
  };
}

const PRIVACY_CASES = [
  // Secrets
  { id: "secret-sk",        cat: "secret",  ...mkBody("Using API key sk-abcdefghijklmnopqrstuvwxyz12345"),                       mustMatch: /SECRET_/ },
  { id: "secret-ghp",       cat: "secret",  ...mkBody("Git token: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB"),                 mustMatch: /SECRET_/ },
  { id: "secret-pat",       cat: "secret",  ...mkBody("PAT: github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz012345"),   mustMatch: /SECRET_/ },
  { id: "secret-aws",       cat: "secret",  ...mkBody("AWS: AKIAIOSFODNN7EXAMPLE"),                                              mustMatch: /SECRET_/ },
  { id: "secret-labeled",   cat: "secret",  ...mkBody('api_key = "super-secret-key-12345678"'),                                  mustMatch: /SECRET_/ },
  { id: "secret-password",  cat: "secret",  ...mkBody('password: "hunter2secure!abc"'),                                          mustMatch: /SECRET_/ },
  // URLs
  { id: "url-https",        cat: "url",     ...mkBody("Endpoint: https://api.internal.company.com/v2/users"),                    mustMatch: /URL_/ },
  { id: "url-http",         cat: "url",     ...mkBody("Webhook: http://staging.myapp.io/webhook/events"),                        mustMatch: /URL_/ },
  { id: "url-with-params",  cat: "url",     ...mkBody("Auth: https://api.example.com/auth?token=abc123"),                        mustMatch: /URL_/ },
  // Emails
  { id: "email-user",       cat: "email",   ...mkBody("Contact john.doe@company-internal.com for access"),                       mustMatch: /EMAIL_/ },
  { id: "email-admin",      cat: "email",   ...mkBody("Email ops@internal.corp.example.org about the issue"),                    mustMatch: /EMAIL_/ },
  { id: "email-multiple",   cat: "email",   ...mkBody("CC alice@mycompany.com and bob@mycompany.com"),                            mustMatch: /EMAIL_/ },
  // Paths
  { id: "path-win",         cat: "path",    ...mkBody("Config at C:\\Users\\Admin\\projects\\myapp\\config.json"),               mustMatch: /PATH_/ },
  { id: "path-win-deep",    cat: "path",    ...mkBody("Secrets: D:\\workspace\\company\\backend\\secrets\\keys.pem"),             mustMatch: /PATH_/ },
  { id: "path-unix",        cat: "path",    ...mkBody("Found in /home/alice/projects/myapp/src/config.env"),                     mustMatch: /PATH_/ },
  { id: "path-unix-etc",    cat: "path",    ...mkBody("Reading /etc/ssl/private/server.key for TLS"),                            mustMatch: /PATH_/ },
  // UUIDs
  { id: "uuid-v4",          cat: "id",      ...mkBody("User session: 550e8400-e29b-41d4-a716-446655440000"),                      mustMatch: /ID_/ },
  { id: "uuid-v1",          cat: "id",      ...mkBody("Trace ID: 123e4567-e89b-12d3-a456-426614174000"),                          mustMatch: /ID_/ },
  // Custom terms
  { id: "custom-single",    cat: "term",    ...mkBody("Working on Project Phoenix deadline", ["Project Phoenix"]),                 mustMatch: /TERM_/ },
  { id: "custom-multi",     cat: "term",    ...mkBody("OperationNightfall uses Codename Alpha", ["OperationNightfall", "Codename Alpha"]), mustMatch: /TERM_/ },
  // Tool results path redaction
  { id: "tool-result-path", cat: "path",
    body: { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "File: /srv/secret/config.json" }] }] },
    cfg: FULL_REDACT_CFG,
    mustMatch: /PATH_/,
  },
];

// These should NOT have their text changed by the redactor
const PRIVACY_FP_CASES = [
  { id: "fp-plain-code",    text: "function getUser(id) { return users.find(u => u.id === id); }" },
  { id: "fp-simple-text",   text: "add error handling to this async function" },
  { id: "fp-var-assign",    text: "const userId = parseInt(req.params.id, 10);" },
  { id: "fp-comment",       text: "// This function processes user input and returns a result" },
  { id: "fp-import",        text: 'import { createServer } from "http";' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Runner utilities
// ─────────────────────────────────────────────────────────────────────────────
const PASS_SYM  = "✓";
const FAIL_SYM  = "✗";
const WARN_SYM  = "⚠";
const NOTE_SYM  = "→";
const W = 62;
const hr = (c = "─") => c.repeat(W);

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

function printSection(title) {
  console.log("\n" + hr("─"));
  console.log(title);
  console.log(hr("─"));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(W));
console.log(" CLAUDE-HYBRID ROUTER  —  COMPREHENSIVE BENCHMARK");
console.log("═".repeat(W));
console.log(` Config: tokenThreshold=${ROUTING.tokenThreshold}  fileReadThreshold=${ROUTING.fileReadThreshold}`);
console.log(` Keywords (${ROUTING.keywords.length}): ${ROUTING.keywords.join(", ")}`);

// ─── SECTION 1: ROUTING ACCURACY ──────────────────────────────────────────
printSection("SECTION 1 — ROUTING ACCURACY");

let passes = 0, failures = 0;
const failedScenarios = [];
const qualityGaps   = []; // cloudBetter → local
const costWastes    = []; // localOk → cloud

for (const s of SCENARIOS) {
  const result = analyzeMessages(s.body, ROUTING);
  const ok = result.dest === s.expect;

  if (ok) {
    passes++;
  } else {
    failures++;
    failedScenarios.push(s);
    if (s.tier === "cloudBetter" && result.dest === "local") qualityGaps.push(s);
    if (s.tier === "localOk"     && result.dest === "cloud") costWastes.push(s);
  }

  const sym  = ok ? PASS_SYM : FAIL_SYM;
  const mark = s.knownIssue ? " [KNOWN]" : "";
  const direction = `${pad(s.expect, 5)} → ${result.dest}`;
  const issue = !ok && s.knownIssue ? `  ← ${s.knownIssue}` : "";
  console.log(` ${sym} ${pad(s.label + mark, 42)} ${direction}${issue}`);
}

const total = SCENARIOS.length;
const pct   = ((passes / total) * 100).toFixed(1);
console.log(`\n Passed: ${passes}/${total} (${pct}%)   Failed: ${failures}/${total}`);
if (qualityGaps.length)
  console.log(` ${WARN_SYM} Quality gaps (cloudBetter→local): ${qualityGaps.length} — potential answer quality loss`);
if (costWastes.length)
  console.log(` ${WARN_SYM} Cost wastes (localOk→cloud):       ${costWastes.length} — unnecessary cloud spend`);

// ─── SECTION 2: COST SAVINGS SIMULATION ───────────────────────────────────
printSection("SECTION 2 — COST SAVINGS (200-message workload simulation)");

const sim = runCostSimulation();
const localPct  = ((sim.totalLocal  / 200) * 100).toFixed(1);
const cloudPct  = ((sim.totalCloud  / 200) * 100).toFixed(1);
const savingsPct = (((sim.costCloudOnly - sim.costHybrid) / sim.costCloudOnly) * 100).toFixed(1);
const savingsDollar = ((sim.costCloudOnly - sim.costHybrid) * 5).toFixed(4); // scale to 1000 msgs

console.log(` Message distribution:`);
for (const b of sim.breakdown) {
  const dest = b.dest === "local" ? "LOCAL " : "CLOUD ";
  console.log(`   ${dest} ${pad(b.label, 16)} ${rpad(b.n, 3)} msgs  ~$${b.perMsgCost.toFixed(5)}/msg`);
}

console.log(`\n RESULT (200 msgs):`);
console.log(`   Local  (Ollama):   ${rpad(sim.totalLocal, 3)} msgs  (${localPct}%)`);
console.log(`   Cloud  (Anthropic): ${rpad(sim.totalCloud, 3)} msgs  (${cloudPct}%)`);
console.log(`\n Estimated cost per 1 000 messages (Claude Sonnet 3.5 pricing):`);
console.log(`   Cloud-only:  $${(sim.costCloudOnly * 5).toFixed(4)}`);
console.log(`   Hybrid:      $${(sim.costHybrid    * 5).toFixed(4)}`);
console.log(`   ${PASS_SYM} Savings: ${savingsPct}%  (~$${savingsDollar} saved per 1 000 msgs)`);

// ─── SECTION 3: PRIVACY LAYER COVERAGE ───────────────────────────────────
printSection("SECTION 3 — PRIVACY LAYER COVERAGE");

const catCounts  = {};
const catHits    = {};
let privPasses   = 0;

for (const c of PRIVACY_CASES) {
  catCounts[c.cat] = (catCounts[c.cat] || 0) + 1;
  const out    = redactCloudRequestBody(c.body, c.cfg);
  const text   = JSON.stringify(out.body);
  const caught = c.mustMatch.test(text);
  if (caught) {
    privPasses++;
    catHits[c.cat] = (catHits[c.cat] || 0) + 1;
  }
  const sym = caught ? PASS_SYM : FAIL_SYM;
  console.log(` ${sym} [${pad(c.cat, 6)}] ${c.id}`);
}

console.log(` ─`);

// False-positive checks
let fpOk = 0;
for (const fp of PRIVACY_FP_CASES) {
  const out   = redactCloudRequestBody({ messages: [{ role: "user", content: [{ type: "text", text: fp.text }] }] }, FULL_REDACT_CFG);
  const after = out.body.messages[0].content[0].text;
  // False positives: check for unexpected placeholder injection (allow PATH_ for unix routes)
  const changed = out.changed;
  // We accept minor changes (short paths); flag only if redactions > 0 on truly neutral text
  const fpExpectClean = !changed;
  const sym = fpExpectClean ? PASS_SYM : WARN_SYM;
  if (fpExpectClean) fpOk++;
  console.log(` ${sym} [FP CHECK] ${fp.id}${changed ? `  ← redacted ${out.redactions} item(s) (review)` : ""}`);
}

const privTotal = PRIVACY_CASES.length;
const privPct   = ((privPasses / privTotal) * 100).toFixed(1);
console.log(`\n Coverage: ${privPasses}/${privTotal} sensitive cases caught (${privPct}%)`);
console.log(` False-positive clean: ${fpOk}/${PRIVACY_FP_CASES.length}`);
console.log(` ${NOTE_SYM}  Some code paths (e.g. Unix routes) are intentionally over-redacted for maximum IP protection.`);

for (const [cat, total_] of Object.entries(catCounts)) {
  const hits  = catHits[cat] || 0;
  const p     = ((hits / total_) * 100).toFixed(0);
  const sym   = hits === total_ ? PASS_SYM : FAIL_SYM;
  console.log(`   ${sym} ${pad(cat, 8)} ${hits}/${total_} (${p}%)`);
}

// ─── SECTION 4: QUALITY TRADE-OFF ANALYSIS ────────────────────────────────
printSection("SECTION 4 — QUALITY TRADE-OFF ANALYSIS");

const cloudBetterScenarios = SCENARIOS.filter((s) => s.tier === "cloudBetter");
const localOkScenarios     = SCENARIOS.filter((s) => s.tier === "localOk");

const cloudBetterCorrect = cloudBetterScenarios.filter((s) => analyzeMessages(s.body, ROUTING).dest === "cloud").length;
const localOkCorrect     = localOkScenarios    .filter((s) => analyzeMessages(s.body, ROUTING).dest === "local").length;

const cloudBetterPct = ((cloudBetterCorrect / cloudBetterScenarios.length) * 100).toFixed(1);
const localOkPct     = ((localOkCorrect     / localOkScenarios.length)     * 100).toFixed(1);
const dimRisk        = (100 - parseFloat(cloudBetterPct)).toFixed(1);
const wasteRisk      = (100 - parseFloat(localOkPct)).toFixed(1);

console.log(` Task complexity vs routing destination:`);
console.log(`   cloudBetter tasks → cloud:  ${cloudBetterCorrect}/${cloudBetterScenarios.length} (${cloudBetterPct}%)`);
console.log(`   localOk tasks     → local:  ${localOkCorrect}/${localOkScenarios.length} (${localOkPct}%)`);
console.log(``);
console.log(` Answer quality diminution risk:   ${dimRisk}%`);
console.log(`   (% of complex tasks routed to local model — lower is better)`);
console.log(`   0% = all Opus-worthy tasks always reach cloud  [TARGET]`);
console.log(``);
console.log(` Unnecessary cloud cost waste:     ${wasteRisk}%`);
console.log(`   (% of simple tasks wasting cloud API budget — lower is better)`);
console.log(`   0% = simple tasks always stay on Ollama  [TARGET]`);

// Quality map legend
console.log(`\n Quality tier map:`);
console.log(`   localOk     — local model adequate (greetings, simple fixes, quick questions)`);
console.log(`   cloudBetter — cloud clearly better (architecture, security, deep reasoning)`);
console.log(`   neutral     — structural/threshold boundary tests`);

// ─── SECTION 5: IMPROVEMENT OPPORTUNITIES ─────────────────────────────────
printSection("SECTION 5 — IMPROVEMENT OPPORTUNITIES");

if (failedScenarios.length === 0) {
  console.log(` ${PASS_SYM} All scenarios pass — no routing improvements needed.`);
} else {
  // Group failures by knownIssue fix hint
  const byFix = {};
  for (const s of failedScenarios) {
    const key = s.knownIssue || "unknown";
    (byFix[key] = byFix[key] || []).push(s);
  }

  for (const [fix, scenarios] of Object.entries(byFix)) {
    console.log(`\n FIX: ${fix}`);
    for (const s of scenarios) {
      const actual = analyzeMessages(s.body, ROUTING).dest;
      const type   = s.tier === "cloudBetter" ? "quality gap" : "cost waste";
      console.log(`   ${FAIL_SYM} [${type}] "${s.label}"  expected ${s.expect}, got ${actual}`);
    }
  }

  console.log(`\n Summary of changes required:`);
  const needsKeywords = failedScenarios.some((s) => s.knownIssue && s.knownIssue.includes("keyword"));
  const needsThreshold = failedScenarios.some((s) => s.knownIssue && s.knownIssue.includes("threshold"));
  if (needsKeywords)  console.log(`   ${NOTE_SYM} Add missing routing keywords to hybrid.config.example.json`);
  if (needsThreshold) console.log(`   ${NOTE_SYM} Raise genericKeyword token threshold in routing-logic.js (900 → 2500)`);
}

// ─── SECTION 6: TEAM FEATURES — CASCADE + NEW ROUTING FIELDS ─────────────
printSection("SECTION 6 — TEAM FEATURES (cascade guard + advanced routing)");

let teamPasses = 0, teamFailures = 0;

function teamAssert(label, actual, expected, note) {
  const ok = actual === expected;
  const sym = ok ? PASS_SYM : FAIL_SYM;
  console.log(`   ${sym} ${label}${note ? "  (" + note + ")" : ""}`);
  if (ok) teamPasses++;
  else {
    teamFailures++;
    console.log(`       expected: ${JSON.stringify(expected)}  got: ${JSON.stringify(actual)}`);
  }
}

// ── 6a. checkNonStreamingContent ─────────────────────────────────────────
console.log("\n [6a] checkNonStreamingContent — abort phrase detection");
teamAssert(
  "detects \"i'm unable to\"",
  checkNonStreamingContent("I'm unable to access real-time data."),
  "i'm unable to",
);
teamAssert(
  "detects 'as an ai language model'",
  checkNonStreamingContent("As an AI language model I cannot browse the web."),
  "as an ai language model",
);
teamAssert(
  "returns null for normal code response",
  checkNonStreamingContent("Here is the refactored function:\n```js\nfunction foo() {}"),
  null,
);
teamAssert(
  "returns null for short code-only response",
  checkNonStreamingContent("```python\nprint('hello')\n```"),
  null,
);
teamAssert(
  "only scans first SCAN_CHARS*2 chars (phrase beyond window → null)",
  checkNonStreamingContent(
    "A".repeat(SCAN_CHARS * 4) + " I'm unable to help with that.",
    DEFAULT_ABORT_PHRASES,
  ),
  null,
);
teamAssert(
  "custom phrase list",
  checkNonStreamingContent("SYSTEM_OFFLINE — cannot process request.", ["system_offline"]),
  "system_offline",
);

// ── 6b. extractSSEText ───────────────────────────────────────────────────
console.log("\n [6b] extractSSEText — Ollama SSE token extraction");
const sseChunk = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n`;
teamAssert(
  "extracts single token",
  extractSSEText(sseChunk("Hello")),
  "Hello",
);
teamAssert(
  "concatenates tokens from multi-line chunk",
  extractSSEText(sseChunk("foo") + sseChunk("bar")),
  "foobar",
);
teamAssert(
  "ignores [DONE] sentinel",
  extractSSEText(sseChunk("ok") + "data: [DONE]\n"),
  "ok",
);
teamAssert(
  "returns empty string for non-SSE data",
  extractSSEText("just some raw bytes"),
  "",
);

// ── 6c. createStreamGuard — synchronous event checks ─────────────────────
// 'flushing' and 'abort' fire synchronously within upstream.emit("data").
// The buffered-chunk replay happens in process.nextTick; we verify it via
// a synchronous probe after emitting (nextTick fires before any subsequent
// event-loop I/O but we can observe the flag after draining microtasks
// using a trivial synchronous poll — the nextTick will have fired by then
// because EventEmitter.emit is synchronous and nextTick is drained before
// any further I/O).  For the benchmark we just verify the synchronous
// invariants; integration coverage for replay ordering is in the unit tests.
console.log("\n [6c] createStreamGuard — streaming quality gate");

// Test A: good response → 'flushing' fires synchronously
{
  const up = new EventEmitter();
  const g  = createStreamGuard(up, DEFAULT_ABORT_PHRASES);
  let flushed = false, aborted = false;
  g.on("flushing", () => { flushed = true; });
  g.on("abort",    () => { aborted = true; });
  up.emit("data", Buffer.from(sseChunk("x".repeat(SCAN_CHARS + 10))));
  teamAssert("good response: flushing fires synchronously", flushed, true);
  teamAssert("good response: no abort",                     aborted, false);
}

// Test B: abort phrase → 'abort' fires synchronously, no 'flushing'
{
  const up2 = new EventEmitter();
  const g2  = createStreamGuard(up2, DEFAULT_ABORT_PHRASES);
  let flushed2 = false, aborted2 = false, phrase2 = null;
  g2.on("flushing", () => { flushed2 = true; });
  g2.on("abort",    ({ phrase }) => { aborted2 = true; phrase2 = phrase; });
  up2.emit("data", Buffer.from(sseChunk("I'm unable to " + "x".repeat(SCAN_CHARS))));
  teamAssert("abort phrase: abort fires synchronously",  aborted2, true);
  teamAssert("abort phrase: no flushing",                flushed2, false);
  teamAssert("abort phrase: phrase string captured",     typeof phrase2, "string");
}

// Test C: short response (end before SCAN_CHARS) → flushing fires on 'end'
{
  const up3 = new EventEmitter();
  const g3  = createStreamGuard(up3, DEFAULT_ABORT_PHRASES);
  let flushed3 = false, aborted3 = false;
  g3.on("flushing", () => { flushed3 = true; });
  g3.on("abort",    () => { aborted3 = true; });
  up3.emit("data", Buffer.from(sseChunk("Short answer.")));
  up3.emit("end");
  teamAssert("short response: flushing fires on end", flushed3, true);
  teamAssert("short response: no abort",              aborted3, false);
}

// ── 6d. alwaysLocalTerms routing override ────────────────────────────────
console.log("\n [6d] alwaysLocalTerms — force local before all rules");
{
  const cfg = { ...ROUTING, alwaysLocalTerms: ["ProjectFalcon", "internal-api"] };

  // Large message — normally cloud via token threshold, but term overrides
  const bigMsg = {
    messages: [{
      role: "user",
      content: [{ type: "text", text: "ProjectFalcon: " + "x".repeat(cfg.tokenThreshold * 4 + 1) }],
    }],
  };
  const r1 = analyzeMessages(bigMsg, cfg);
  teamAssert("overrides token threshold", r1.dest, "local", r1.reason);

  // Cloud keyword present but alwaysLocal term also present → local wins
  const kwMsg = {
    messages: [{ role: "user", content: [{ type: "text", text: "internal-api security audit" }] }],
  };
  const r2 = analyzeMessages(kwMsg, cfg);
  teamAssert("overrides keyword cloud escalation", r2.dest, "local", r2.reason);

  // Same keyword without alwaysLocal term → cloud (normal routing)
  const normalMsg = {
    messages: [{ role: "user", content: [{ type: "text", text: "security audit of auth module" }] }],
  };
  const r3 = analyzeMessages(normalMsg, cfg);
  teamAssert("absent alwaysLocal term → keyword routing unchanged", r3.dest, "cloud", r3.reason);
}

// ── 6e. forceLocalIfPrivacyTerms ─────────────────────────────────────────
console.log("\n [6e] forceLocalIfPrivacyTerms — privacy-aware routing");
{
  const cfg = {
    ...ROUTING,
    forceLocalIfPrivacyTerms: true,
    privacyCustomTerms: ["ProjectFalcon", "PayrollService"],
  };

  // Keyword + privacy term → stays local (privacy wins)
  const privMsg = {
    messages: [{ role: "user", content: [{ type: "text", text: "design pattern for ProjectFalcon API" }] }],
  };
  const r1 = analyzeMessages(privMsg, cfg);
  teamAssert("privacy term short-circuits keyword escalation", r1.dest, "local", r1.reason);

  // Keyword without privacy term → cloud (feature doesn't interfere)
  const noPrivMsg = {
    messages: [{ role: "user", content: [{ type: "text", text: "design pattern for the API gateway" }] }],
  };
  const r2 = analyzeMessages(noPrivMsg, cfg);
  teamAssert("no privacy term → keyword escalation intact", r2.dest, "cloud", r2.reason);

  // Feature disabled → normal routing
  const cfgOff = { ...ROUTING, forceLocalIfPrivacyTerms: false, privacyCustomTerms: ["ProjectFalcon"] };
  const r3 = analyzeMessages(privMsg, cfgOff);
  teamAssert("forceLocalIfPrivacyTerms=false → normal routing", r3.dest, "cloud", r3.reason);

  // Token threshold beats privacy (hard limit)
  const bigPrivMsg = {
    messages: [{
      role: "user",
      content: [{ type: "text", text: "PayrollService: " + "x".repeat(cfg.tokenThreshold * 4 + 1) }],
    }],
  };
  const r4 = analyzeMessages(bigPrivMsg, cfg);
  teamAssert("token threshold still beats forceLocalIfPrivacyTerms", r4.dest, "cloud", r4.reason);
}

console.log(`\n Passed: ${teamPasses}   Failed: ${teamFailures}`);

// ─── FINAL SCORE ───────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(W));
console.log(` OVERALL SCORE`);
console.log("═".repeat(W));
console.log(` Routing accuracy:         ${pct}%  (${passes}/${total} scenarios)`);
console.log(` Answer quality diminution risk: ${dimRisk}%`);
console.log(` Unnecessary cloud waste:  ${wasteRisk}%`);
console.log(` Privacy coverage:         ${privPct}%  (${privPasses}/${privTotal} categories)`);
console.log(` Cost savings vs cloud-only: ${savingsPct}%`);
console.log("─".repeat(W));

if (failures > 0) {
  const known = failedScenarios.filter((s) => s.knownIssue).length;
  console.log(` ${FAIL_SYM}  ${failures} scenario(s) failing (${known} with known fix) — implement improvements above`);
} else {
  console.log(` ${PASS_SYM}  All scenarios pass — routing is fully validated!`);
}
console.log("═".repeat(W) + "\n");

process.exit(failures > 0 ? 1 : 0);

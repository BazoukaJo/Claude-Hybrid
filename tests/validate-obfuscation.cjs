"use strict";

/**
 * Obfuscation validation.
 *
 * Tests createProjectObfuscator() + StreamDeobfuscator for:
 *   - Auto-detection from realistic Windows file paths
 *   - Component extraction (standalone "DragonQuest", "Dragon" hidden, not just compound)
 *   - Full bidirectional roundtrip integrity
 *   - Tool-call parameter restoration (file_path values)
 *   - Streaming deobfuscation across SSE chunk boundaries
 *   - Explicit project_terms config
 *   - Generic code passes through untouched (no false obfuscation)
 */

const {
  createProjectObfuscator,
  StreamDeobfuscator,
} = require("../router/lib/project-obfuscator");

let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  [PASS] ${label}`);
    if (detail) console.log(`         ${detail}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${label}`);
    if (detail) console.log(`         ${detail}`);
    failed++;
  }
}

// ── Shared config ─────────────────────────────────────────────────────────────

const BASE_CFG = {
  enabled: true,
  auto_detect_filenames: true,
  auto_detect_identifiers: false,
  preserve_extensions: true,
  scan_system_prompt: true,
  scan_tool_results: true,
};

// ── Test body: realistic Claude Code request ──────────────────────────────────

// System prompt with "Primary working directory:" just like Claude Code injects.
const SYSTEM_PROMPT =
  "You are a coding assistant.\n" +
  "Primary working directory: C:\\Users\\Admin\\Bureau\\DragonQuestGame\n" +
  "Project layout: Source\\Characters\\PlayerController.cpp, " +
  "Source\\UI\\HUD_DragonQuest.h, Content\\Blueprints\\BP_DragonHero.uasset, " +
  "Source\\Combat\\DragonCombatSystem.cpp, Source\\Magic\\MagicSpellSystem.h";

const BODY = {
  system: SYSTEM_PROMPT,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Review Source\\Characters\\PlayerController.cpp and " +
            "Source\\UI\\HUD_DragonQuest.h. " +
            "The DragonQuest project has Dragon classes and the DragonHero blueprint.",
        },
      ],
    },
  ],
};

// ── Section 1: Map building ───────────────────────────────────────────────────

console.log("══ OBFUSCATION VALIDATION ═══════════════════════════════════════");
console.log();

const ob = createProjectObfuscator(BASE_CFG, BODY);
check("Obfuscator created (terms detected from paths + system prompt)", ob !== null);

if (!ob) {
  console.log("  FATAL: no obfuscator — aborting remaining tests.");
  console.log(`\n  Result: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\n  Map: ${ob.fwd.size} entries (sample):`);
for (const [orig, alias] of [...ob.fwd.entries()].slice(0, 10)) {
  console.log(`    ${orig.padEnd(42)} → ${alias}`);
}
if (ob.fwd.size > 10) console.log(`    … (+${ob.fwd.size - 10} more)`);
console.log();

// ── Section 2: Individual term hiding ────────────────────────────────────────

// These must all be hidden — both compound names and their components.
const mustHide = [
  ["DragonQuestGame (project dir)",       "DragonQuestGame"],
  ["PlayerController.cpp (file)",         "PlayerController.cpp"],
  ["HUD_DragonQuest.h (file)",            "HUD_DragonQuest.h"],
  ["HUD_DragonQuest (bare name)",         "HUD_DragonQuest"],
  ["DragonQuest (component of HUD file)", "DragonQuest"],
  ["DragonHero (component of BP file)",   "DragonHero"],
  ["DragonCombatSystem.cpp (file)",       "DragonCombatSystem.cpp"],
  ["Dragon (shared component)",           "Dragon"],
];

console.log("  Individual term hiding:");
for (const [label, term] of mustHide) {
  const probe = `Reference to ${term} in the codebase`;
  const obfText = ob.obfuscateString(probe);
  const leaked = obfText.includes(term);
  check(
    label,
    !leaked,
    leaked
      ? `LEAKED: "${term}" still in obfuscated output`
      : `→ "${obfText.replace("Reference to ", "").replace(" in the codebase", "")}"`,
  );
}
console.log();

// ── Section 3: Roundtrip integrity ───────────────────────────────────────────

console.log("  Roundtrip (obfuscate then deobfuscate):");

const originalProse =
  "I examined HUD_DragonQuest.h and the Dragon class hierarchy " +
  "in PlayerController.cpp and DragonCombatSystem.cpp.";

const obfProse = ob.obfuscateString(originalProse);
const restoredProse = ob.deobfuscateString(obfProse);

const proseLeak =
  obfProse.includes("HUD_DragonQuest") ||
  obfProse.includes("DragonQuest") ||
  obfProse.includes("Dragon") ||
  obfProse.includes("PlayerController") ||
  obfProse.includes("DragonCombatSystem");

check(
  "No project names in obfuscated cloud-bound text",
  !proseLeak,
  `obf: "${obfProse.slice(0, 80)}..."`,
);
check(
  "Deobfuscated text equals original",
  restoredProse === originalProse,
  restoredProse !== originalProse
    ? `MISMATCH:\n           original: "${originalProse}"\n           restored: "${restoredProse}"`
    : `restored: "${restoredProse.slice(0, 70)}"`,
);
console.log();

// ── Section 4: Tool-call parameter restoration ───────────────────────────────

console.log("  Tool-call parameter restoration:");

const toolCallResponse =
  '{"type":"text","text":"Please run Read with file_path: ' +
  'Source\\\\Characters\\\\PlayerController.cpp to check the logic."}';

const obfTool = ob.obfuscateString(toolCallResponse);
const restTool = ob.deobfuscateString(obfTool);

check(
  "file_path value restored after roundtrip",
  restTool.includes("PlayerController.cpp"),
  `restored snippet: "${restTool.slice(0, 90)}"`,
);
check(
  "file_path alias present in cloud-bound text",
  !obfTool.includes("PlayerController"),
  `cloud text: "${obfTool.slice(0, 90)}"`,
);
console.log();

// ── Section 5: Streaming deobfuscation (alias split across chunks) ─────────

console.log("  Streaming deobfuscation (split-alias boundary):");

const streamOriginal =
  "The DragonQuestGame project has PlayerController.cpp for character control.";
const streamObf = ob.obfuscateString(streamOriginal);

// Simulate two SSE chunks split at the middle of the obfuscated text
const mid = Math.floor(streamObf.length / 2);
const sd = new StreamDeobfuscator(ob);
const p1 = sd.process(Buffer.from(streamObf.slice(0, mid)));
const p2 = sd.process(Buffer.from(streamObf.slice(mid)));
const pf = sd.flush();
const streamRestored = p1.toString() + p2.toString() + pf.toString();

check(
  "Stream chunks reassembled to original",
  streamRestored === streamOriginal,
  streamRestored !== streamOriginal
    ? `MISMATCH:\n           original: "${streamOriginal}"\n           restored: "${streamRestored}"`
    : `"${streamRestored.slice(0, 70)}"`,
);
console.log();

// ── Section 6: Explicit project_terms ────────────────────────────────────────

console.log("  Explicit project_terms config:");

const cfgWithTerms = {
  ...BASE_CFG,
  project_terms: ["Phantasma", "VoidWeaver", "NightRealm"],
};
const bodyWithTerms = {
  messages: [
    { role: "user", content: "Phantasma uses VoidWeaver to manage NightRealm." },
  ],
};
const obExplicit = createProjectObfuscator(cfgWithTerms, bodyWithTerms);
check("Obfuscator created with explicit terms", obExplicit !== null);
if (obExplicit) {
  const obfExplicit = obExplicit.obfuscateString(
    "Phantasma uses VoidWeaver to manage NightRealm.",
  );
  check(
    "All three explicit terms hidden",
    !obfExplicit.includes("Phantasma") &&
      !obfExplicit.includes("VoidWeaver") &&
      !obfExplicit.includes("NightRealm"),
    `→ "${obfExplicit}"`,
  );
}
console.log();

// ── Section 7: Non-project terms pass through untouched ──────────────────────

console.log("  Non-project content passes through:");

const genericBody = {
  messages: [
    {
      role: "user",
      content: "Use const instead of let for better code style.",
    },
  ],
};
const obGeneric = createProjectObfuscator(BASE_CFG, genericBody);
check(
  "No obfuscator created for purely generic content",
  obGeneric === null,
  obGeneric ? `fwd.size=${obGeneric.fwd.size}` : "correctly null",
);
console.log();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`  Result: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

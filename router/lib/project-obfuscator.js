"use strict";

const { StringDecoder } = require("node:string_decoder");

/**
 * project-obfuscator.js
 *
 * Bidirectional project-term obfuscator for cloud requests.
 *
 * OUTGOING (request to Anthropic):
 *   - Scans the request body for project-specific file names, identifiers,
 *     and explicit custom terms from config.
 *   - Replaces them with neutral aliases: proj_mod_001.cpp, ProjTerm001, etc.
 *   - Preserves file extensions so the AI still understands the language context.
 *
 * INCOMING (response from Anthropic):
 *   - Restores all aliases back to original names so Claude Code tools
 *     (Read, Edit, Bash, Glob, Grep…) work with real file paths and names.
 *   - StreamDeobfuscator handles SSE chunks where an alias may be split
 *     across chunk boundaries using a tail-buffer approach.
 *
 * Config key: privacy.project_obfuscation in hybrid.config.json
 *
 *   project_terms        — explicit terms always obfuscated (highest priority)
 *   auto_detect_filenames — scan content for source file names (.cpp, .js, …)
 *   auto_detect_identifiers — scan for camelCase / PascalCase identifiers
 *   alias_prefix         — lowercase prefix used in generated aliases ("proj")
 *   preserve_extensions  — keep .cpp / .js visible; AI understands language
 *   scan_system_prompt   — include system prompt in the scan + obfuscation pass
 *   scan_tool_results    — include tool_result blocks in the scan + pass
 */

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_PROJECT_OBFUSCATION = {
  enabled: true,   // on by default; returns null fast when nothing detected
  auto_detect_filenames: true,
  auto_detect_identifiers: false,
  project_terms: [],
  alias_prefix: "proj",
  preserve_extensions: true,
  scan_system_prompt: true,
  scan_tool_results: true,
};

// ─── Source-file extensions worth obfuscating ─────────────────────────────────

const CODE_EXTS = new Set([
  // C/C++
  "cpp", "cxx", "cc", "c", "h", "hpp", "hxx", "inl", "ipp",
  // C#/VB/F#
  "cs", "vb", "fs", "fsx", "fsi",
  // JS/TS
  "js", "mjs", "cjs", "ts", "tsx", "jsx",
  // Python
  "py", "pyw", "pyx", "pyi",
  // Go / Rust / Swift / Kotlin
  "go", "rs", "swift", "kt", "kts",
  // Java / Scala / Groovy
  "java", "scala", "groovy",
  // Lua / Ruby / PHP
  "lua", "rb", "php",
  // Shaders
  "shader", "hlsl", "glsl", "vert", "frag", "comp", "geom", "tesc", "tese",
  // Config / data
  "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "config",
  // Markup / style
  "xml", "html", "htm", "css", "scss", "sass", "less",
  // Docs / scripts
  "md", "txt", "sql", "ps1", "sh", "bat", "cmd",
  // Unreal Engine
  "uasset", "uproject", "uplugin", "umap",
  // Unity
  "unity", "prefab", "asset", "mat", "anim",
]);

// ─── Well-known directory names — not worth obfuscating ──────────────────────

const KNOWN_DIRS = new Set([
  "src", "source", "sources", "include", "includes", "inc",
  "lib", "libs", "library", "libraries",
  "bin", "obj", "out", "build", "dist", "output", "release", "debug",
  "test", "tests", "spec", "specs", "unit", "integration",
  "doc", "docs", "documentation",
  "assets", "resources", "res", "data", "static", "media", "raw",
  "scripts", "tools", "tooling", "config", "configs", "configuration",
  "public", "private", "internal", "external",
  "core", "common", "shared", "base", "framework",
  "utils", "utilities", "helpers", "support", "misc",
  "vendor", "third_party", "thirdparty", "extern",
  "node_modules", "packages", "modules",
  "content", "Content",
  "engine", "Engine", "editor", "Editor",
  "plugins", "Plugins", "plugin", "Plugin",
  "platform", "Platform", "platforms", "Platforms",
  "intermediate", "Intermediate", "saved", "Saved",
  "generated", "Generated", "autogen",
  "x64", "x86", "arm", "arm64", "win64", "linux", "macos",
  "release", "debug", "relwithdebinfo", "minsizerel",
  "windows", "osx", "android", "ios",
]);

// ─── OS / user-level path segments — never project-specific ──────────────────
// These appear in every developer's path regardless of project (Windows, Mac, Linux).
// They are filtered out during the auto path-segment scan so only project-specific
// directory names (like the game title or unique module names) get registered.

const SYSTEM_PATH_SEGMENTS = new Set([
  // Windows standard locations
  "users", "user", "admin", "administrator", "public", "default",
  "onedrive", "documents", "desktop", "downloads", "pictures", "music", "videos",
  "appdata", "localappdata", "roaming", "local", "temp", "tmp",
  "programfiles", "programfilesx86", "programdata",
  "windows", "system32", "syswow64", "winsxs",
  // French / localized Windows names
  "bureau", "mes documents", "téléchargements",
  // macOS standard locations
  "applications", "library", "volumes", "private", "system",
  "users",
  // Linux standard locations
  "home", "root", "var", "usr", "etc", "opt", "proc", "run", "boot",
  "srv", "mnt", "media", "snap",
  // Common dev workspace roots (not project-specific)
  "dev", "code", "coding", "develop", "development",
  "projects", "project", "repos", "repository", "repositories",
  "workspace", "workspaces", "work", "sandbox", "lab",
  "src", // also in KNOWN_DIRS but put here for the path-segment pass
  // VCS / tooling
  ".git", ".github", ".svn", ".hg",
  ".vscode", ".idea", ".vs", ".cursor",
  // Numeric-only or single-char
]);

// ─── Common identifier words — skip obfuscating these ────────────────────────

const SKIP_IDENTS = new Set([
  // JS / TS keywords and builtins
  "console", "process", "global", "window", "document", "module", "exports",
  "require", "import", "export", "default", "from", "as",
  "undefined", "typeof", "instanceof", "void", "delete", "new", "this", "super",
  "class", "interface", "extends", "implements",
  "function", "async", "await", "yield", "return", "throw",
  "const", "let", "var", "static", "readonly", "abstract", "override",
  "public", "private", "protected",
  "switch", "default", "break", "continue",
  // Common types
  "string", "number", "boolean", "object", "symbol", "bigint",
  "never", "unknown", "any",
  "int", "float", "double", "char", "byte", "short", "long",
  "bool", "uint", "ulong", "ushort", "uchar", "size_t", "intptr",
  "vector", "list", "map", "set", "queue", "stack", "deque",
  "wstring", "u8string",
  // Common variable/param names
  "id", "key", "val", "value", "data", "info", "meta", "name", "type",
  "size", "count", "index", "length", "width", "height", "depth",
  "min", "max", "avg", "sum", "total", "result",
  "src", "dst", "buf", "ptr", "ref", "tmp", "temp",
  "arr", "obj", "str", "num", "err", "ret", "res",
  "arg", "args", "param", "params", "option", "options",
  // Common method names
  "get", "set", "has", "is", "can", "will", "should",
  "add", "remove", "clear", "reset", "flush",
  "init", "setup", "create", "build", "make",
  "start", "stop", "run", "exec", "execute",
  "read", "write", "open", "close", "load", "save", "push", "pop",
  "update", "tick", "step", "handle", "process", "apply",
  "log", "debug", "warn", "error", "info", "trace",
  "main", "test", "assert", "expect", "mock",
  "find", "filter", "map", "sort", "reduce", "each", "forEach",
  "parse", "stringify", "serialize", "deserialize",
  "encode", "decode", "hash", "sign", "verify",
  // Network / API
  "api", "url", "uri", "http", "https", "json", "xml",
  "request", "response", "body", "header", "query", "fetch", "send",
  "status", "code", "message", "payload", "token", "auth",
  // Anthropic / Claude tool schema (must never be obfuscated)
  "tool_use", "tool_result", "input_schema", "max_tokens",
  "messages", "content", "system", "model", "stream",
  "assistant", "user", "human", "role",
  "file_path", "command", "pattern", "old_string", "new_string",
  // Generic game-engine terms (not project-specific)
  "game", "scene", "world", "level",
  "actor", "entity", "node", "component",
  "renderer", "shader", "material", "texture", "mesh",
  "position", "rotation", "scale", "transform",
  "camera", "light", "shadow",
  "physics", "collision", "rigidbody", "collider",
  "input", "controller", "character",
  "animation", "animator", "bone", "skeleton",
  "audio", "sound", "music",
  "widget", "panel", "button",
  "timer", "clock", "delta", "frame",
  "event", "callback", "delegate", "signal", "slot",
  // Standard library / platform
  "thread", "mutex", "lock", "semaphore", "atomic",
  "memory", "allocator", "buffer", "pool",
  "socket", "server", "client",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeProjectObfuscationConfig(input) {
  const cfg = { ...DEFAULT_PROJECT_OBFUSCATION };
  if (!input || typeof input !== "object") return cfg;
  for (const key of [
    "enabled",
    "auto_detect_filenames",
    "auto_detect_identifiers",
    "preserve_extensions",
    "scan_system_prompt",
    "scan_tool_results",
  ]) {
    if (typeof input[key] === "boolean") cfg[key] = input[key];
  }
  if (typeof input.alias_prefix === "string") {
    const p = input.alias_prefix.trim().replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (p.length >= 1) cfg.alias_prefix = p.slice(0, 10);
  }
  if (Array.isArray(input.project_terms)) {
    cfg.project_terms = input.project_terms
      .map((t) => String(t || "").trim())
      .filter((t) => t.length >= 3);
  }
  return cfg;
}

// ─── ProjectObfuscator ────────────────────────────────────────────────────────

class ProjectObfuscator {
  constructor(cfg) {
    this.cfg = cfg;
    const p = cfg.alias_prefix || "proj";
    this.lp = p.toLowerCase();                                    // e.g. "proj"
    this.up = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); // e.g. "Proj"
    this.fwd = new Map();  // original  → alias
    this.rev = new Map();  // alias     → original
    this.counters = { term: 0, mod: 0, dir: 0, sym: 0 };
    // Sealed sorted arrays — built once via seal()
    this.fwdSorted = [];  // [[original, alias], ...] longest original first
    this.revSorted = [];  // [[alias, original], ...] longest alias first
    this.maxAliasLen = 0;
    this._sealed = false;
  }

  // ── Alias generation ───────────────────────────────────────────────────────

  _nextAlias(category) {
    switch (category) {
      case "term": {
        // ProjTerm001 — PascalCase, blends into prose
        const n = ++this.counters.term;
        return `${this.up}Term${String(n).padStart(3, "0")}`;
      }
      case "mod": {
        // proj_mod_001 — snake_case, looks like a module/file base name
        const n = ++this.counters.mod;
        return `${this.lp}_mod_${String(n).padStart(3, "0")}`;
      }
      case "dir": {
        // proj_dir_001 — snake_case, looks like a directory segment
        const n = ++this.counters.dir;
        return `${this.lp}_dir_${String(n).padStart(3, "0")}`;
      }
      case "sym": {
        // proj_sym_001 — snake_case identifier alias
        const n = ++this.counters.sym;
        return `${this.lp}_sym_${String(n).padStart(3, "0")}`;
      }
      default: {
        const n = ++this.counters.sym;
        return `${this.lp}_x_${String(n).padStart(3, "0")}`;
      }
    }
  }

  // ── Registration helpers ──────────────────────────────────────────────────

  _reg(original, alias) {
    if (!this.fwd.has(original)) {
      this.fwd.set(original, alias);
      this.rev.set(alias, original);
    }
  }

  _shouldSkip(name) {
    if (!name || name.length <= 2) return true;
    const lower = name.toLowerCase();
    return SKIP_IDENTS.has(lower) || SKIP_IDENTS.has(name);
  }

  /** Register an explicit project term (custom, highest priority). */
  _addTerm(term) {
    if (!term || term.length < 3 || this.fwd.has(term)) return;
    this._reg(term, this._nextAlias("term"));
  }

  /**
   * Split a compound identifier into individual meaningful words.
   *
   * Examples:
   *   "HUD_DragonQuest"    → ["HUD", "DragonQuest", "Dragon", "Quest"]
   *   "DragonController"   → ["Dragon"]           ("Controller" is in SKIP_IDENTS)
   *   "BP_DragonHero"      → ["DragonHero", "Dragon", "Hero"]
   *   "MagicSpellSystem"   → ["Magic", "Spell"]   ("System" in SKIP_IDENTS)
   *
   * The original `name` itself is NOT returned (it is already registered by the caller).
   * Filters by SKIP_IDENTS and minimum length 3.
   */
  _extractComponents(name) {
    if (!name || name.length < 4) return [];
    const results = new Set();

    // Step 1: split on underscore / dash → gives compound parts like "DragonQuest"
    const underParts = name.split(/[_\-]+/).filter((p) => p.length >= 3);

    for (const part of underParts) {
      // Register multi-char underscore part if not generic (e.g. "DragonQuest")
      if (part !== name && !this._shouldSkip(part)) results.add(part);

      // Step 2: CamelCase split each part → gives individual words
      // "DragonController" → "Dragon\x00Controller"
      const split = part
        .replace(/([a-z])([A-Z])/g, "$1\x00$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\x00$2")
        .split("\x00")
        .filter((w) => w.length >= 3);

      for (const w of split) {
        if (w !== name && !this._shouldSkip(w)) results.add(w);
      }
    }

    // If name had no underscores, also try a top-level CamelCase split
    if (underParts.length === 1 && underParts[0] === name) {
      const split = name
        .replace(/([a-z])([A-Z])/g, "$1\x00$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\x00$2")
        .split("\x00")
        .filter((w) => w.length >= 3);
      for (const w of split) {
        if (w !== name && !this._shouldSkip(w)) results.add(w);
      }
    }

    return [...results];
  }

  /** Register a source file: basename + extension. */
  _addFile(basename, ext) {
    if (!basename || basename.length < 3) return;
    if (!CODE_EXTS.has((ext || "").toLowerCase())) return;
    if (this._shouldSkip(basename)) return;

    const key = `${basename}.${ext}`;
    if (this.fwd.has(key)) return; // already registered

    const modAlias = this._nextAlias("mod");
    const aliasWithExt = this.cfg.preserve_extensions
      ? `${modAlias}.${ext.toLowerCase()}`
      : modAlias;

    // Register "basename.ext" → alias (with or without ext).
    this._reg(key, aliasWithExt);

    // Also register bare "basename" → "proj_mod_001" so AI responses like
    // "I modified proj_mod_001 to..." are restored to the real basename.
    //
    // When preserve_extensions is false, aliasWithExt === modAlias and the
    // outer _reg above already put modAlias into this.rev — we only need to
    // check fwd to decide whether the basename is still free to register.
    if (!this.fwd.has(basename)) {
      this.fwd.set(basename, modAlias);
      // Only add the reverse mapping if the alias isn't already there,
      // otherwise we'd clobber the "basename.ext" → modAlias reverse entry
      // when preserve_extensions=false.
      if (!this.rev.has(modAlias)) this.rev.set(modAlias, basename);
    }

    // Register individual CamelCase / underscore components
    // so standalone mentions like "Dragon" or "DragonQuest" in AI prose are also hidden.
    for (const comp of this._extractComponents(basename)) {
      if (!this.fwd.has(comp)) this._reg(comp, this._nextAlias("sym"));
    }
  }

  /** Register a directory path segment. */
  _addDir(segment) {
    if (!segment || segment.length < 3) return;
    if (this.fwd.has(segment)) return;
    if (KNOWN_DIRS.has(segment) || KNOWN_DIRS.has(segment.toLowerCase())) return;
    if (this._shouldSkip(segment)) return;
    this._reg(segment, this._nextAlias("dir"));

    // Register individual CamelCase / underscore components of the segment name
    // (e.g. "DragonQuestGame" → "Dragon", "Quest", "DragonQuest")
    for (const comp of this._extractComponents(segment)) {
      if (!this.fwd.has(comp)) this._reg(comp, this._nextAlias("sym"));
    }
  }

  /** Register a code identifier (camelCase, PascalCase). */
  _addIdent(ident) {
    if (this._shouldSkip(ident)) return;
    if (this.fwd.has(ident)) return;
    this._reg(ident, this._nextAlias("sym"));
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  /**
   * Extract project-specific directory segments from any file paths in `text`.
   *
   * Strategy: split each found path on the OS separator, then register every
   * segment that is NOT a well-known system/OS/tooling directory.  The segments
   * that survive are almost certainly project-specific (game title, module dirs…).
   *
   * Called unconditionally from _scanText() — it is cheap (regex + Set lookup)
   * and produces the best automatic project-term detection without any config.
   */
  _scanPathSegments(text) {
    const addSegs = (rawPath) => {
      // Normalise: replace backslashes with forward slashes for uniform splitting
      const norm = rawPath.replace(/\\/g, "/");
      const segs = norm.split("/");
      for (const seg of segs) {
        // Skip empty, too-short, drive letters (C:), dot-dirs
        if (!seg || seg.length < 3 || /^[A-Za-z]:$/.test(seg) || seg.startsWith(".")) continue;
        // Strip trailing separators / quotes that might cling to the segment
        const clean = seg.replace(/['")\s]+$/, "").trim();
        if (!clean || clean.length < 3) continue;
        const lower = clean.toLowerCase();
        // Skip if it's an OS-level or well-known dev root segment
        if (SYSTEM_PATH_SEGMENTS.has(lower)) continue;
        // Skip if it's a generic known project sub-directory
        if (KNOWN_DIRS.has(clean) || KNOWN_DIRS.has(lower)) continue;
        // Skip if it contains dots (file names handled by _scanFilenames)
        if (clean.includes(".")) continue;
        // Skip pure numbers / hex / UUIDs
        if (/^[0-9a-f\-]{6,}$/i.test(clean)) continue;
        this._addDir(clean);
      }
    };

    // Windows absolute paths:  C:\Users\Admin\GameTitle\Source\...
    const winRe = /\b([A-Za-z]):\\((?:[^\s"'<>|\r\n\\]+\\)*[^\s"'<>|\r\n\\]*)/g;
    let m;
    while ((m = winRe.exec(text)) !== null) {
      addSegs(m[2]);
    }

    // Unix/Mac absolute paths:  /home/user/GameTitle/Source/...
    const unixRe = /(?:^|[\s"'`(,=])(\/[A-Za-z][^\s"'`)\r\n]*)/gm;
    while ((m = unixRe.exec(text)) !== null) {
      addSegs(m[1]);
    }

    // Relative paths with at least two segments:  GameTitle/Source/Player.cpp
    const relRe = /(?:^|[\s"'`(,=])([A-Za-z][A-Za-z0-9_\-]+(?:[/\\][A-Za-z0-9_\-\.]+){2,})/gm;
    while ((m = relRe.exec(text)) !== null) {
      addSegs(m[1]);
    }
  }

  _scanText(text) {
    if (!text || typeof text !== "string") return;

    // Always scan for project-specific path segments (directory names, project root, etc.)
    // This is the primary mechanism for zero-config auto-detection.
    this._scanPathSegments(text);

    if (this.cfg.auto_detect_filenames) {
      // Match "Basename.ext" where ext is a known code extension
      const fileRe = /\b([A-Za-z][A-Za-z0-9_\-]{1,})\.([A-Za-z0-9]{1,8})\b/g;
      let m;
      while ((m = fileRe.exec(text)) !== null) {
        const [, base, ext] = m;
        if (CODE_EXTS.has(ext.toLowerCase())) {
          this._addFile(base, ext);
        }
      }
    }

    if (this.cfg.auto_detect_identifiers) {
      // Match camelCase and PascalCase identifiers of meaningful length
      const identRe = /\b(?:[A-Z][a-z][A-Za-z0-9]{3,}|[a-z]{2,}[A-Z][A-Za-z0-9]{2,})\b/g;
      let m;
      while ((m = identRe.exec(text)) !== null) {
        this._addIdent(m[0]);
      }
    }
  }

  _scanBlock(block) {
    if (!block || typeof block !== "object") return;
    if (typeof block.text === "string") this._scanText(block.text);
    if (block.type === "tool_result" && this.cfg.scan_tool_results) {
      this._scanDeep(block.content);
    }
  }

  _scanDeep(value, depth = 0) {
    if (depth > 12) return;
    if (typeof value === "string") {
      this._scanText(value);
    } else if (Array.isArray(value)) {
      for (const item of value) this._scanDeep(item, depth + 1);
    } else if (value && typeof value === "object") {
      // Prefer scanning named "text" fields directly
      if (typeof value.text === "string") this._scanText(value.text);
      else {
        for (const v of Object.values(value)) {
          if (typeof v === "string" || Array.isArray(v) || (v && typeof v === "object")) {
            this._scanDeep(v, depth + 1);
          }
        }
      }
    }
  }

  /**
   * Extract and register the project working directory from Claude Code's
   * injected environment block in the system prompt.
   *
   * Claude Code prepends something like:
   *   "Primary working directory: C:\Users\Admin\Dev\MyGame"
   *   "- Primary working directory: /home/user/mygame"
   *
   * Detecting this line gives us the project root path for free — no file reads
   * required, no config needed from the user.
   */
  _extractWorkingDirectory(text) {
    if (!text || typeof text !== "string") return;
    // Match lines produced by Claude Code's environment injection
    const re = /(?:primary\s+working\s+directory|working\s+directory|project\s+(?:root|directory|path)|cwd)[:\s]+([^\r\n]+)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const dirPath = m[1].trim().replace(/['"]+/g, "");
      if (dirPath.length > 3) this._scanPathSegments(dirPath);
    }
  }

  /**
   * Pre-scan the request body to build the obfuscation map.
   *
   * Detection order (highest priority first):
   *   1. Explicit project_terms from config
   *   2. Working-directory path from Claude Code's system-prompt header
   *   3. All file paths in the system prompt (segments + filenames)
   *   4. All file paths in messages and tool results
   *
   * Must be called before seal() and obfuscateBody().
   */
  buildMapFromBody(body) {
    // 1. Explicit project_terms — always registered, highest priority
    for (const term of this.cfg.project_terms || []) {
      this._addTerm(term);
    }

    if (!body || typeof body !== "object") return;

    // 2. System prompt — scan for working directory first (gives the project root),
    //    then full text scan for any other paths / file names.
    if (this.cfg.scan_system_prompt) {
      const sysText =
        typeof body.system === "string"
          ? body.system
          : Array.isArray(body.system)
          ? body.system.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
      if (sysText) {
        this._extractWorkingDirectory(sysText);
        this._scanText(sysText);
      }
    }

    // 3. Messages (user turns + assistant turns + tool results)
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg) continue;
        if (typeof msg.content === "string") {
          this._scanText(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) this._scanBlock(block);
        }
      }
    }
  }

  /**
   * Freeze the maps into sorted arrays for efficient string replacement.
   * Call once after buildMapFromBody(), before obfuscateBody().
   */
  seal() {
    // Longest original first — prevents a short key matching inside a long one
    this.fwdSorted = [...this.fwd.entries()].sort((a, b) => b[0].length - a[0].length);
    // Longest alias first — same reason for deobfuscation
    this.revSorted = [...this.rev.entries()].sort((a, b) => b[0].length - a[0].length);
    this.maxAliasLen = this.revSorted.reduce((m, [k]) => Math.max(m, k.length), 0);
    this._sealed = true;
  }

  get hasTerms() {
    return this.fwd.size > 0;
  }

  // ── Forward obfuscation (outgoing to Anthropic) ───────────────────────────

  /**
   * Replace all registered originals with their aliases.
   * Uses split+join for literal string replacement (no regex escaping concerns).
   */
  obfuscateString(text) {
    if (!this._sealed || !text || typeof text !== "string" || !this.fwd.size) return text;
    let out = text;
    for (const [orig, alias] of this.fwdSorted) {
      if (out.includes(orig)) out = out.split(orig).join(alias);
    }
    return out;
  }

  // ── Reverse deobfuscation (incoming from Anthropic) ──────────────────────

  /**
   * Replace all aliases with their original names.
   * Sorted longest-first so "proj_mod_001.cpp" is restored before "proj_mod_001".
   */
  deobfuscateString(text) {
    if (!this._sealed || !text || typeof text !== "string" || !this.rev.size) return text;
    let out = text;
    for (const [alias, orig] of this.revSorted) {
      if (out.includes(alias)) out = out.split(alias).join(orig);
    }
    return out;
  }

  // ── Deep obfuscation for request body ────────────────────────────────────

  _obfVal(v, depth = 0) {
    if (depth > 20) return v;
    if (typeof v === "string") return this.obfuscateString(v);
    if (Array.isArray(v)) return v.map((x) => this._obfVal(x, depth + 1));
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const [k, inner] of Object.entries(v)) out[k] = this._obfVal(inner, depth + 1);
    return out;
  }

  _obfBlock(block) {
    if (!block || typeof block !== "object") return block;
    const next = { ...block };
    if (typeof next.text === "string") {
      next.text = this.obfuscateString(next.text);
    }
    if (next.type === "tool_result" && this.cfg.scan_tool_results) {
      next.content = this._obfVal(next.content);
    }
    return next;
  }

  /**
   * Obfuscate an entire Anthropic request body.
   * Returns { body, changed } — use body only if changed is true.
   */
  obfuscateBody(body) {
    if (!this._sealed || !body || typeof body !== "object" || !this.fwd.size) {
      return { body, changed: false };
    }
    let changed = false;
    const next = { ...body };

    // System prompt
    if (this.cfg.scan_system_prompt) {
      if (typeof next.system === "string") {
        const s = this.obfuscateString(next.system);
        if (s !== next.system) { next.system = s; changed = true; }
      } else if (Array.isArray(next.system)) {
        next.system = next.system.map((block) => {
          if (!block || typeof block !== "object") return block;
          const copy = { ...block };
          if (typeof copy.text === "string") {
            const s = this.obfuscateString(copy.text);
            if (s !== copy.text) { copy.text = s; changed = true; }
          }
          return copy;
        });
      }
    }

    // Messages
    if (Array.isArray(next.messages)) {
      next.messages = next.messages.map((msg) => {
        if (!msg) return msg;
        if (typeof msg.content === "string") {
          const s = this.obfuscateString(msg.content);
          if (s !== msg.content) { changed = true; return { ...msg, content: s }; }
          return msg;
        }
        if (Array.isArray(msg.content)) {
          let blockChanged = false;
          const newContent = msg.content.map((block) => {
            const obf = this._obfBlock(block);
            if (obf !== block) blockChanged = true;
            return obf;
          });
          if (blockChanged) { changed = true; return { ...msg, content: newContent }; }
        }
        return msg;
      });
    }

    return { body: next, changed };
  }
}

// ─── StreamDeobfuscator ───────────────────────────────────────────────────────

/**
 * Deobfuscates SSE chunk streams from Anthropic.
 *
 * Problem: an alias like "proj_mod_001" (12 chars) can be split across two
 * consecutive SSE chunks. Naively replacing in each chunk independently would
 * miss splits.
 *
 * Solution: keep a "carry" buffer of (maxAliasLen - 1) bytes from the tail of
 * each chunk. Prepend it to the next chunk before deobfuscating, then emit
 * only the portion beyond the tail as safe output.
 *
 * The carry is flushed (with deobfuscation) when the stream ends.
 */
class StreamDeobfuscator {
  constructor(obfuscator) {
    this.ob = obfuscator;
    this.carry = "";
    // We need to hold back (maxAliasLen - 1) chars to catch any split alias
    this.tailLen = Math.max(0, obfuscator.maxAliasLen - 1);
    // StringDecoder buffers incomplete UTF-8 sequences across chunk boundaries
    // so a codepoint split mid-bytes never surfaces as U+FFFD (replacement char).
    this._decoder = new StringDecoder("utf8");
  }

  /**
   * Process one raw SSE chunk (Buffer or string).
   * Returns a Buffer safe to write to the client response.
   */
  process(chunk) {
    const incoming = Buffer.isBuffer(chunk)
      ? this._decoder.write(chunk)
      : String(chunk);
    const str = this.carry + incoming;
    const replaced = this.ob.deobfuscateString(str);
    if (this.tailLen === 0) {
      this.carry = "";
      return Buffer.from(replaced, "utf8");
    }
    const safeLen = Math.max(0, replaced.length - this.tailLen);
    this.carry = replaced.slice(safeLen);
    return Buffer.from(replaced.slice(0, safeLen), "utf8");
  }

  /**
   * Flush the carry buffer at stream end.
   * Returns a Buffer (may be empty).
   */
  flush() {
    // Drain any trailing bytes still held by the decoder before final replace.
    const remainder = this._decoder.end();
    const tail = this.carry + remainder;
    this.carry = "";
    return Buffer.from(this.ob.deobfuscateString(tail), "utf8");
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a sealed ProjectObfuscator for one cloud request.
 *
 * Returns null when:
 *   - cfg.enabled is false, OR
 *   - no terms were detected / configured (nothing to obfuscate).
 *
 * @param {object} cfgInput  privacy.project_obfuscation from hybrid config
 * @param {object} body      The (possibly already privacy-redacted) request body
 */
function createProjectObfuscator(cfgInput, body) {
  const cfg = normalizeProjectObfuscationConfig(cfgInput);
  if (!cfg.enabled) return null;

  const ob = new ProjectObfuscator(cfg);
  ob.buildMapFromBody(body);
  ob.seal();

  return ob.hasTerms ? ob : null;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_PROJECT_OBFUSCATION,
  normalizeProjectObfuscationConfig,
  ProjectObfuscator,
  StreamDeobfuscator,
  createProjectObfuscator,
};

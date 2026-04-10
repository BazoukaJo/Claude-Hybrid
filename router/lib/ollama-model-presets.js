'use strict';

/**
 * Community-leaning Ollama sampling defaults per model family (instruction / coding bias).
 * Not official vendor guidance — synthesised from Ollama Modelfile docs, model cards, and
 * threads such as r/LocalLLaMA / r/ollama. Tune in `.claude/model-params.json` (sparse overrides).
 *
 * Matching uses the full Ollama tag (e.g. llama3.2:3b) and picks the longest registered prefix.
 */

const PRESETS = [
  {
    prefixes: ['llama3.3', 'llama-3.3'],
    params: { temperature: 0.55, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['llama3.2', 'llama-3.2'],
    params: { temperature: 0.55, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['llama3.1', 'llama-3.1'],
    params: { temperature: 0.55, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['llama4', 'llama-4'],
    params: { temperature: 0.55, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['llama3', 'llama-3'],
    params: { temperature: 0.6, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['gemma4', 'gemma-4'],
    params: { temperature: 0.42, top_p: 0.92, top_k: 48, num_ctx: 8192 },
  },
  {
    prefixes: ['gemma3', 'gemma-3'],
    params: { temperature: 0.4, top_p: 0.95, top_k: 64, num_ctx: 8192 },
  },
  {
    prefixes: ['gemma2', 'gemma-2'],
    params: { temperature: 0.45, top_p: 0.95, top_k: 64, num_ctx: 8192 },
  },
  {
    prefixes: ['gemma'],
    params: { temperature: 0.45, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['qwen3', 'qwen-3'],
    params: { temperature: 0.6, top_p: 0.95, top_k: 40, num_ctx: 16384 },
  },
  {
    prefixes: ['qwen2.5-coder', 'qwen2_5-coder', 'qwen2.5-coder'],
    params: { temperature: 0.35, top_p: 0.95, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['qwen2.5', 'qwen2_5', 'qwen-2.5'],
    params: { temperature: 0.55, top_p: 0.95, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['qwen2', 'qwen-2'],
    params: { temperature: 0.5, top_p: 0.95, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['qwen'],
    params: { temperature: 0.55, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['mistral-small', 'mistral_small'],
    params: { temperature: 0.2, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['mixtral', 'mistral-nemo', 'mistral-large', 'mistral_large', 'pixtral'],
    params: { temperature: 0.25, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['mistral', 'ministral'],
    params: { temperature: 0.25, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['deepseek-r1', 'deepseek_r1', 'deepseek-reasoner'],
    params: { temperature: 0.55, top_p: 0.95, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['deepseek'],
    params: { temperature: 0.4, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['codestral', 'codellama', 'starcoder2', 'starcoder', 'stable-code'],
    params: { temperature: 0.2, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['phi4', 'phi-4'],
    params: { temperature: 0.65, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['phi3', 'phi-3', 'microsoft/phi-3', 'microsoft/phi-4'],
    params: { temperature: 0.7, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['command-r-plus', 'command-r7b', 'command-r', 'command_r', 'c4ai-command'],
    params: { temperature: 0.3, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['granite', 'ibm-granite'],
    params: { temperature: 0.4, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['solar', 'upstage/solar'],
    params: { temperature: 0.5, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['yi', '01-ai/yi'],
    params: { temperature: 0.5, top_p: 0.9, top_k: 40, num_ctx: 8192 },
  },
  {
    prefixes: ['vicuna', 'openchat', 'zephyr', 'starling', 'nous-hermes', 'dolphin', 'openhermes', 'neural-chat'],
    params: { temperature: 0.65, top_p: 0.9, top_k: 40, num_ctx: 4096 },
  },
  {
    prefixes: ['tinyllama'],
    params: { temperature: 0.65, top_p: 0.9, top_k: 40, num_ctx: 2048 },
  },
];

function norm(n) {
  return String(n || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/');
}

/** True if `tag` starts with `prefix` at a tag boundary (not gemma vs gemma2). */
function tagStartsWithPrefix(tag, prefix) {
  if (!tag.startsWith(prefix)) return false;
  if (tag.length === prefix.length) return true;
  const next = tag[prefix.length];
  return ':@/_'.includes(next) || !/[a-z0-9]/.test(next);
}

/**
 * @param {string} modelName Ollama model tag from `ollama list` / /api/tags
 * @returns {Record<string, number>} subset of generation keys; {} if unknown family
 */
function matchPresetPatch(modelName) {
  const n = norm(modelName);
  if (!n) return {};
  const segments = n.split('/').filter(Boolean);
  const tags = [n, ...segments];
  let best = null;
  let bestLen = -1;
  for (const tag of tags) {
    for (const rule of PRESETS) {
      for (const pfx of rule.prefixes) {
        const pl = norm(pfx);
        if (!pl) continue;
        if (tagStartsWithPrefix(tag, pl) && pl.length > bestLen) {
          bestLen = pl.length;
          best = rule.params;
        }
      }
    }
  }
  return best ? { ...best } : {};
}

module.exports = { PRESETS, matchPresetPatch, norm, tagStartsWithPrefix };

'use strict';

const OLLAMA_CONTEXT_ENRICH_CAP = 20;

/**
 * When the library is larger than `cap`, only the first `cap` names (alphabetical) are enriched;
 * others keep `context_max: null` so /api/ollama-models stays responsive.
 */
function selectEnrichmentHead(models, cap = OLLAMA_CONTEXT_ENRICH_CAP) {
  if (!Array.isArray(models) || models.length === 0) return [];
  if (models.length <= cap) return models;
  return [...models].sort((a, b) => String(a.name).localeCompare(String(b.name))).slice(0, cap);
}

function mergeEnrichedModels(originalList, enrichedHead) {
  const byName = new Map(enrichedHead.map((m) => [m.name, m]));
  return originalList.map((m) => (byName.has(m.name) ? byName.get(m.name) : { ...m, context_max: null }));
}

module.exports = {
  OLLAMA_CONTEXT_ENRICH_CAP,
  selectEnrichmentHead,
  mergeEnrichedModels,
};

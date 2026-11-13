/**
 * CommandCode model discovery.
 *
 * CommandCode publishes the same catalog its own CLI polls — a public endpoint
 * (no auth, ETag = catalogVersion, refreshAfterSeconds: 900) that the CLI keeps
 * in ~/.commandcode/cache/model-catalog. The registry's static `models` array is
 * only an offline fallback: it lags every vendor release, so both the dashboard
 * provider page and GET /v1/models resolve the catalog live.
 */

import commandcodeProvider from "../providers/registry/commandcode.js";

export const COMMANDCODE_MODELS_URL = "https://api.commandcode.ai/provider/v1/models?view=client";

/**
 * Catalog rows carry display copy plus capability flags. `hidden` entries are
 * the free/stealth aliases the vendor CLI keeps out of its own picker.
 */
export function parseCommandCodeModels(data) {
  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .filter((model) => model?.id && !model.hidden)
    .map((model) => {
      const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : [];
      const efforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
      return {
        id: model.id,
        name: model.display?.label || model.name || model.id,
        description: model.display?.description || null,
        contextLength: model.context_length,
        maxOutputTokens: model.maxOutputTokens ?? undefined,
        isVL: modalities.includes("image"),
        isReasoning: efforts.length > 0
      };
    });
}

// The vendor advertises refreshAfterSeconds: 900. GET /v1/models is reachable
// by any API-key holder, so without a cache every listing call fanned out to
// the vendor; without a timeout a slow vendor stalled the listing.
const CATALOG_TTL_MS = 15 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 8000;
let catalogCache = null; // { value, expiresAt } — default-fetch results only
let catalogInflight = null;

async function fetchCommandCodeModels(fetchImpl) {
  try {
    const response = await fetchImpl(COMMANDCODE_MODELS_URL, {
      method: "GET",
      headers: { ...commandcodeProvider.transport.headers },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    });
    if (!response?.ok) return null;
    const models = parseCommandCodeModels(await response.json());
    return models.length > 0 ? { models } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the live catalog. Returns null when the vendor endpoint is unreachable
 * or answers non-2xx so callers can fall back to their static list. Successful
 * lookups through the default fetch are cached for the vendor's refresh window
 * and concurrent callers share one request; an injected fetchImpl (tests)
 * always goes live.
 */
export async function resolveCommandCodeModels(fetchImpl = fetch) {
  if (fetchImpl !== fetch) return fetchCommandCodeModels(fetchImpl);
  if (catalogCache && Date.now() < catalogCache.expiresAt) return catalogCache.value;
  if (!catalogInflight) {
    catalogInflight = fetchCommandCodeModels(fetchImpl)
      .then((value) => {
        if (value) catalogCache = { value, expiresAt: Date.now() + CATALOG_TTL_MS };
        return value ?? catalogCache?.value ?? null;
      })
      .finally(() => { catalogInflight = null; });
  }
  return catalogInflight;
}

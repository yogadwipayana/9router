export function formatApiKeyAccessError(state, options = {}) {
  const fallback = options.fallback || "Invalid API key";

  if (state?.reason === "owner_budget_exhausted") {
    const user = state.owner?.email || "This user";
    const budget = Number(state.owner?.budgetUsd || 0).toFixed(2);
    return `${user} has reached the $${budget} budget limit`;
  }

  if (state?.reason === "owner_disabled") return "This API key user is disabled";
  if (state?.reason === "key_paused") return "This API key is paused";

  return fallback;
}

export function getApiKeyAccessStatus(state) {
  if (state?.reason === "owner_budget_exhausted") return 403;
  return 401;
}

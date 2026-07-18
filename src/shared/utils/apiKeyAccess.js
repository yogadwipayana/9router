export function formatApiKeyAccessError(state, options = {}) {
  const fallback = options.fallback || "Invalid API key";

  if (state?.reason === "owner_budget_exhausted") {
    const user = state.owner?.email || "This user";
    const budget = Number(state.owner?.budgetUsd || 0).toFixed(2);
    return `${user} has reached the $${budget} budget limit`;
  }

  if (state?.reason === "owner_disabled") return "This API key user is disabled";
  if (state?.reason === "key_paused") return "This API key is paused";

  if (state?.reason === "temp_exhausted") {
    const budget = Number(state.temp?.budgetUsd || 0).toFixed(2);
    return `This temporary API key has reached its $${budget} limit`;
  }
  if (state?.reason === "temp_expired") return "This temporary API key has expired";
  if (state?.reason === "temp_disabled") return "This temporary API key is disabled";

  return fallback;
}

export function getApiKeyAccessStatus(state) {
  if (state?.reason === "owner_budget_exhausted") return 403;
  if (state?.reason === "temp_exhausted" || state?.reason === "temp_expired") return 403;
  return 401;
}

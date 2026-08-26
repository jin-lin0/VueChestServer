const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const FALLBACK_COOLDOWN_MS = 2 * 60 * 1000;
const UPSTREAM_COOLDOWN_MS = 60 * 1000;

const modelHealth = new Map();

function getOrCreate(modelId) {
  if (!modelHealth.has(modelId)) {
    modelHealth.set(modelId, {
      attempts: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastFailureCode: null,
      cooldownUntil: 0,
    });
  }
  return modelHealth.get(modelId);
}

function recordModelSuccess(modelId, now = Date.now()) {
  if (!modelId) return;
  const state = getOrCreate(modelId);
  state.attempts += 1;
  state.successes += 1;
  state.consecutiveFailures = 0;
  state.lastSuccessAt = now;
  state.cooldownUntil = 0;
}

function recordModelFailure(
  modelId,
  code = "UPSTREAM_ERROR",
  now = Date.now(),
) {
  if (!modelId) return;
  const state = getOrCreate(modelId);
  state.attempts += 1;
  state.failures += 1;
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  state.lastFailureCode = code;

  const cooldown =
    code === "RATE_LIMIT"
      ? RATE_LIMIT_COOLDOWN_MS
      : code === "MODEL_FALLBACK"
        ? FALLBACK_COOLDOWN_MS
        : UPSTREAM_COOLDOWN_MS;
  state.cooldownUntil = Math.max(state.cooldownUntil, now + cooldown);
}

function recordModelResolution(requestedModel, actualModel, now = Date.now()) {
  if (!actualModel) return;
  if (requestedModel && requestedModel !== actualModel) {
    recordModelFailure(requestedModel, "MODEL_FALLBACK", now);
  }
  recordModelSuccess(actualModel, now);
}

function rankModelsByHealth(models, now = Date.now()) {
  return [...models]
    .map((model, index) => {
      const state = modelHealth.get(model.id);
      return {
        model,
        index,
        coolingDown: Boolean(state && state.cooldownUntil > now),
        consecutiveFailures: state?.consecutiveFailures || 0,
      };
    })
    .sort((a, b) => {
      if (a.coolingDown !== b.coolingDown) return a.coolingDown ? 1 : -1;
      if (a.consecutiveFailures !== b.consecutiveFailures) {
        return a.consecutiveFailures - b.consecutiveFailures;
      }
      return a.index - b.index;
    })
    .map(({ model }) => model);
}

function getModelHealth(modelId, now = Date.now()) {
  const state = modelHealth.get(modelId);
  if (!state) return null;
  return {
    ...state,
    coolingDown: state.cooldownUntil > now,
  };
}

function resetModelHealth() {
  modelHealth.clear();
}

module.exports = {
  recordModelSuccess,
  recordModelFailure,
  recordModelResolution,
  rankModelsByHealth,
  getModelHealth,
  resetModelHealth,
};

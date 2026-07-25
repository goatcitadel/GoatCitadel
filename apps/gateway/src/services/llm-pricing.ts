import { createHash } from "node:crypto";
import type { ChatCompletionResponse } from "@goatcitadel/contracts";

interface TextModelPricing {
  modelId: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  aliases?: string[];
}

interface EstimateUsageCostInput {
  providerId?: string;
  model?: string;
  usage?: Record<string, unknown>;
}

interface CanonicalUsageObserver {
  observe(usage: unknown): void;
  observeNormalized(usage: {
    costUsd?: number;
    costSource?: "gateway_estimate";
    pricingSource?: "gateway_estimate";
  }): void;
}

const ZERO_COST_PROVIDER_IDS = new Set(["genie-ir20", "llamacpp", "lmstudio", "localai", "ollama"]);
export const MODEL_PRICING_CATALOG_VERSION = "2026-07-13";

// Pricing snapshot as of 2026-07-13.
// Sources:
// - OpenAI model pages for GPT-5.4, GPT-5.4 mini, and GPT-4.1 mini.
// - Z.AI pricing page for GLM-5.
// - OpenRouter model pages for routed OpenRouter model ids.
// - Moonshot native Kimi K2.6 is inferred from OpenRouter's no-markup policy plus
//   the OpenRouter Kimi K2.6 model page because Moonshot's public docs did not expose
//   a machine-readable pricing table for that model.
// - Google Vertex AI pricing for Gemini 2.5 Flash. Cached input deliberately uses
//   the regular input rate here because this catalog has no verified cache-rate row.
// - Fireworks model documentation for Kimi K2.6 (kimi-k2p6).
const PRICING_BY_PROVIDER: Record<string, TextModelPricing[]> = {
  fireworks: [
    {
      modelId: "accounts/fireworks/models/kimi-k2p6",
      inputUsdPerMillion: 0.95,
      cachedInputUsdPerMillion: 0.16,
      outputUsdPerMillion: 4,
    },
  ],
  glm: [
    {
      modelId: "glm-5",
      inputUsdPerMillion: 1,
      cachedInputUsdPerMillion: 0.2,
      outputUsdPerMillion: 3.2,
    },
  ],
  moonshot: [
    {
      modelId: "kimi-k2.6",
      aliases: ["kimi-k2.5"],
      inputUsdPerMillion: 0.42,
      outputUsdPerMillion: 2.2,
    },
  ],
  openai: [
    {
      modelId: "gpt-5.4",
      aliases: ["gpt-5.4-2026-03-05"],
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    },
    {
      modelId: "gpt-5.4-mini",
      inputUsdPerMillion: 0.75,
      cachedInputUsdPerMillion: 0.075,
      outputUsdPerMillion: 4.5,
    },
    {
      modelId: "gpt-4.1-mini",
      aliases: ["gpt-4.1-mini-2025-04-14"],
      inputUsdPerMillion: 0.4,
      cachedInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 1.6,
    },
  ],
  openrouter: [
    {
      modelId: "openai/gpt-4.1-mini",
      aliases: ["openai/gpt-4.1-mini-2025-04-14"],
      inputUsdPerMillion: 0.4,
      outputUsdPerMillion: 1.6,
    },
    {
      modelId: "openai/gpt-5.4-mini",
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 4.5,
    },
    {
      modelId: "moonshotai/kimi-k2.6",
      aliases: ["moonshotai/kimi-k2.5"],
      inputUsdPerMillion: 0.42,
      outputUsdPerMillion: 2.2,
    },
    {
      modelId: "z-ai/glm-5",
      aliases: ["google/glm-5"],
      inputUsdPerMillion: 0.72,
      outputUsdPerMillion: 2.3,
    },
  ],
  vercel: [
    {
      modelId: "openai/gpt-4.1-mini",
      aliases: ["openai/gpt-4.1-mini-2025-04-14"],
      inputUsdPerMillion: 0.4,
      outputUsdPerMillion: 1.6,
    },
    {
      modelId: "openai/gpt-5.4-mini",
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 4.5,
    },
  ],
  vertex: [
    {
      modelId: "google/gemini-2.5-flash",
      aliases: ["gemini-2.5-flash"],
      inputUsdPerMillion: 0.3,
      outputUsdPerMillion: 2.5,
    },
  ],
};

const MODEL_PRICING_CATALOG_HASH = createHash("sha256")
  .update(
    JSON.stringify({
      version: MODEL_PRICING_CATALOG_VERSION,
      zeroCostProviderIds: [...ZERO_COST_PROVIDER_IDS].sort(),
      pricingByProvider: PRICING_BY_PROVIDER,
    }),
  )
  .digest("hex");

export interface ModelPricingLineage {
  catalogVersion: string;
  catalogHash: string;
  inputRateUsdPerMillion: number;
  outputRateUsdPerMillion: number;
  cachedInputRateUsdPerMillion: number;
}

/** Frozen, secret-free pricing evidence captured before provider dispatch. */
export function resolveModelPricingLineage(
  providerId: string | undefined,
  model: string | undefined,
): ModelPricingLineage | undefined {
  const normalizedProviderId = normalizeId(providerId);
  if (!normalizedProviderId) return undefined;
  if (ZERO_COST_PROVIDER_IDS.has(normalizedProviderId)) {
    return {
      catalogVersion: MODEL_PRICING_CATALOG_VERSION,
      catalogHash: MODEL_PRICING_CATALOG_HASH,
      inputRateUsdPerMillion: 0,
      outputRateUsdPerMillion: 0,
      cachedInputRateUsdPerMillion: 0,
    };
  }
  const pricing = findPricing(normalizedProviderId, model);
  if (!pricing) return undefined;
  return {
    catalogVersion: MODEL_PRICING_CATALOG_VERSION,
    catalogHash: MODEL_PRICING_CATALOG_HASH,
    inputRateUsdPerMillion: pricing.inputUsdPerMillion,
    outputRateUsdPerMillion: pricing.outputUsdPerMillion,
    cachedInputRateUsdPerMillion: pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion,
  };
}

export function estimateUsageCostUsd(input: EstimateUsageCostInput): number | undefined {
  const usage = input.usage;
  if (!usage) {
    return undefined;
  }

  const existingCostUsd = readUsageNumber(usage.cost_usd) ?? readUsageNumber(usage.total_cost_usd);
  if (existingCostUsd !== undefined) {
    return existingCostUsd;
  }

  const providerId = normalizeId(input.providerId);
  if (!providerId) {
    return undefined;
  }

  if (ZERO_COST_PROVIDER_IDS.has(providerId)) {
    return 0;
  }

  const pricing = findPricing(providerId, input.model);
  if (!pricing) {
    return undefined;
  }

  const totalInputTokens = readUsageNumber(usage.prompt_tokens) ?? readUsageNumber(usage.input_tokens);
  const totalOutputTokens = readUsageNumber(usage.completion_tokens) ?? readUsageNumber(usage.output_tokens);
  if (totalInputTokens === undefined || totalOutputTokens === undefined) {
    return undefined;
  }
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const observedCachedInputTokens =
    readUsageNumber(usage.cached_prompt_tokens) ??
    readUsageNumber(usage.cached_input_tokens) ??
    (promptDetails ? readUsageNumber(promptDetails.cached_tokens) : undefined) ??
    (inputDetails ? readUsageNumber(inputDetails.cached_tokens) : undefined) ??
    readUsageNumber(usage.cache_read_input_tokens);
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  if (observedCachedInputTokens === undefined && totalInputTokens > 0 && cachedRate !== pricing.inputUsdPerMillion) {
    return undefined;
  }
  const cachedInputTokens = observedCachedInputTokens ?? 0;
  if (cachedInputTokens > totalInputTokens) {
    return undefined;
  }
  const billableInputTokens = Math.max(0, totalInputTokens - cachedInputTokens);
  const totalCostUsd =
    (billableInputTokens * pricing.inputUsdPerMillion +
      cachedInputTokens * cachedRate +
      totalOutputTokens * pricing.outputUsdPerMillion) /
    1_000_000;

  return Number(totalCostUsd.toFixed(8));
}

export function applyEstimatedCostToChatResponse(
  response: ChatCompletionResponse,
  input: Omit<EstimateUsageCostInput, "usage">,
): ChatCompletionResponse {
  if (!response.usage || typeof response.usage !== "object") {
    return response;
  }
  if (!canUseDispatchedModelPricing(input.providerId, input.model, response.model)) {
    return response;
  }
  const costUsd = estimateUsageCostUsd({
    ...input,
    usage: response.usage,
  });
  if (costUsd === undefined) {
    return response;
  }
  return {
    ...response,
    usage: {
      ...response.usage,
      cost_usd: costUsd,
    },
  };
}

export function applyEstimatedCostToStreamChunk(
  chunk: Record<string, unknown>,
  input: Omit<EstimateUsageCostInput, "usage">,
): Record<string, unknown> {
  if (!isRecord(chunk.usage)) {
    return chunk;
  }
  if (
    !canUseDispatchedModelPricing(
      input.providerId,
      input.model,
      typeof chunk.model === "string" ? chunk.model : undefined,
    )
  ) {
    return chunk;
  }
  const costUsd = estimateUsageCostUsd({
    ...input,
    usage: chunk.usage,
  });
  if (costUsd === undefined) {
    return chunk;
  }
  return {
    ...chunk,
    usage: {
      ...chunk.usage,
      cost_usd: costUsd,
    },
  };
}

export function applyEstimatedCostToChatResponseWithSource(
  response: ChatCompletionResponse,
  input: { providerId?: string; model?: string },
): ChatCompletionResponse {
  const providerReportedCost = hasUsageCost(response.usage);
  return annotateChatResponseUsageCostSource(
    applyEstimatedCostToChatResponse(response, input),
    providerReportedCost ? "provider_reported" : "estimated",
  );
}

export function applyEstimatedCostToStreamChunkWithSource(
  chunk: Record<string, unknown>,
  input: { providerId?: string; model?: string },
): Record<string, unknown> {
  const providerReportedCost = hasUsageCost(chunk.usage);
  return annotateStreamChunkUsageCostSource(
    applyEstimatedCostToStreamChunk(chunk, input),
    providerReportedCost ? "provider_reported" : "estimated",
  );
}

/**
 * Preserve the provider payload as untrusted/raw usage, then attach only the
 * estimate that GoatCitadel itself computed as trusted gateway provenance.
 * Provider-supplied `cost_source` is never authoritative.
 */
export function observeProviderUsageWithTrustedEstimate(
  observer: CanonicalUsageObserver | undefined,
  providerUsage: unknown,
  pricedUsage: unknown,
): void {
  if (!observer) return;
  observer.observe(providerUsage);
  if (!isRecord(pricedUsage) || pricedUsage.cost_source !== "estimated") return;
  const costUsd = readUsageNumber(pricedUsage.cost_usd) ?? readUsageNumber(pricedUsage.total_cost_usd);
  if (costUsd === undefined || costUsd < 0) return;
  observer.observeNormalized({
    costUsd,
    costSource: "gateway_estimate",
    pricingSource: "gateway_estimate",
  });
}

function annotateChatResponseUsageCostSource(
  response: ChatCompletionResponse,
  source: "provider_reported" | "estimated",
): ChatCompletionResponse {
  if (!isRecord(response.usage) || !hasUsageCost(response.usage)) {
    return response;
  }
  return {
    ...response,
    usage: {
      ...response.usage,
      cost_source: source,
    },
  };
}

function annotateStreamChunkUsageCostSource(
  chunk: Record<string, unknown>,
  source: "provider_reported" | "estimated",
): Record<string, unknown> {
  if (!isRecord(chunk.usage) || !hasUsageCost(chunk.usage)) {
    return chunk;
  }
  return {
    ...chunk,
    usage: {
      ...chunk.usage,
      cost_source: source,
    },
  };
}

function hasUsageCost(usage: unknown): boolean {
  if (!isRecord(usage)) {
    return false;
  }
  return readUsageNumber(usage.cost_usd) !== undefined || readUsageNumber(usage.total_cost_usd) !== undefined;
}

function findPricing(providerId: string, model: string | undefined): TextModelPricing | undefined {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) {
    return undefined;
  }

  const entries = PRICING_BY_PROVIDER[providerId] ?? [];
  return entries.find((entry) => {
    if (entry.modelId === normalizedModel) {
      return true;
    }
    return (entry.aliases ?? []).some((alias) => normalizeModelId(alias) === normalizedModel);
  });
}

function canUseDispatchedModelPricing(
  providerId: string | undefined,
  dispatchedModel: string | undefined,
  reportedModel: string | undefined,
): boolean {
  const dispatched = normalizeModelId(dispatchedModel);
  const reported = normalizeModelId(reportedModel);
  if (!reported || !dispatched || reported === dispatched) return true;
  const provider = normalizeId(providerId);
  if (!provider) return false;
  const dispatchedPricing = findPricing(provider, dispatched);
  const reportedPricing = findPricing(provider, reported);
  return Boolean(
    dispatchedPricing &&
    reportedPricing &&
    dispatchedPricing.inputUsdPerMillion === reportedPricing.inputUsdPerMillion &&
    dispatchedPricing.outputUsdPerMillion === reportedPricing.outputUsdPerMillion &&
    (dispatchedPricing.cachedInputUsdPerMillion ?? dispatchedPricing.inputUsdPerMillion) ===
      (reportedPricing.cachedInputUsdPerMillion ?? reportedPricing.inputUsdPerMillion),
  );
}

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function normalizeModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function readUsageNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

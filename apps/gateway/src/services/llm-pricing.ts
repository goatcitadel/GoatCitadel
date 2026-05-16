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

const ZERO_COST_PROVIDER_IDS = new Set(["genie-ir20", "lmstudio", "localai", "npu-local", "ollama"]);

// Pricing snapshot as of 2026-03-29.
// Sources:
// - OpenAI model pages for GPT-5.4, GPT-5.4 mini, and GPT-4.1 mini.
// - Z.AI pricing page for GLM-5.
// - OpenRouter model pages for routed OpenRouter model ids.
// - Moonshot native Kimi K2.6 is inferred from OpenRouter's no-markup policy plus
//   the OpenRouter Kimi K2.6 model page because Moonshot's public docs did not expose
//   a machine-readable pricing table for that model.
const PRICING_BY_PROVIDER: Record<string, TextModelPricing[]> = {
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
};

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

  const totalInputTokens = readUsageNumber(usage.prompt_tokens) ?? readUsageNumber(usage.input_tokens) ?? 0;
  const totalOutputTokens = readUsageNumber(usage.completion_tokens) ?? readUsageNumber(usage.output_tokens) ?? 0;
  const cachedInputTokens =
    readUsageNumber(usage.cached_prompt_tokens) ?? readUsageNumber(usage.cached_input_tokens) ?? 0;
  const billableInputTokens = Math.max(0, totalInputTokens - cachedInputTokens);
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
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

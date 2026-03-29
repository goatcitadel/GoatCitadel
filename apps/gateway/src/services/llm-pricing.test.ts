import { describe, expect, it } from "vitest";
import { applyEstimatedCostToChatResponse, estimateUsageCostUsd } from "./llm-pricing.js";

describe("llm-pricing", () => {
  it("estimates cost with cached-input pricing for versioned OpenAI aliases", () => {
    expect(estimateUsageCostUsd({
      providerId: "openai",
      model: "gpt-4.1-mini-2025-04-14",
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 500,
        cached_prompt_tokens: 200,
      },
    })).toBe(0.00114);
  });

  it("returns zero for local zero-cost providers", () => {
    expect(estimateUsageCostUsd({
      providerId: "ollama",
      model: "qwen3.5:9b",
      usage: {
        input_tokens: 12_000,
        output_tokens: 1_500,
      },
    })).toBe(0);
  });

  it("leaves unknown models unpriced instead of inventing spend", () => {
    expect(estimateUsageCostUsd({
      providerId: "minimax",
      model: "MiniMax-M2.7",
      usage: {
        prompt_tokens: 4_000,
        completion_tokens: 500,
      },
    })).toBeUndefined();
  });

  it("preserves provider-reported cost when it already exists", () => {
    const response = applyEstimatedCostToChatResponse({
      id: "cmpl_existing_cost",
      choices: [],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 1_000,
        cost_usd: 0.123456,
      },
    }, {
      providerId: "openai",
      model: "gpt-5.4",
    });

    expect(response.usage?.cost_usd).toBe(0.123456);
  });
});

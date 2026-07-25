import { describe, expect, it } from "vitest";
import {
  applyEstimatedCostToChatResponse,
  applyEstimatedCostToChatResponseWithSource,
  estimateUsageCostUsd,
  observeProviderUsageWithTrustedEstimate,
} from "./llm-pricing.js";

describe("llm-pricing", () => {
  it("does not turn partial remote usage into an exact-looking cost", () => {
    expect(
      estimateUsageCostUsd({
        providerId: "openai",
        model: "gpt-5.4",
        usage: { prompt_tokens: 100 },
      }),
    ).toBeUndefined();
    expect(
      estimateUsageCostUsd({
        providerId: "openai",
        model: "gpt-5.4",
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    ).toBeUndefined();
  });

  it("reads Responses cached-input details and permits explicit zero totals", () => {
    expect(
      estimateUsageCostUsd({
        providerId: "openai",
        model: "gpt-5.4",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 25 },
        },
      }),
    ).toBe(0.00034375);
    expect(
      estimateUsageCostUsd({
        providerId: "openai",
        model: "gpt-5.4",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toBe(0);
  });

  it("estimates cost with cached-input pricing for versioned OpenAI aliases", () => {
    expect(
      estimateUsageCostUsd({
        providerId: "openai",
        model: "gpt-4.1-mini-2025-04-14",
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 500,
          cached_prompt_tokens: 200,
        },
      }),
    ).toBe(0.00114);
  });

  it("returns zero for local zero-cost providers", () => {
    expect(
      estimateUsageCostUsd({
        providerId: "ollama",
        model: "qwen3.5:9b",
        usage: {
          input_tokens: 12_000,
          output_tokens: 1_500,
        },
      }),
    ).toBe(0);
  });

  it("attributes Vertex Gemini 2.5 Flash cost without inventing a cache discount", () => {
    expect(
      estimateUsageCostUsd({
        providerId: "vertex",
        model: "google/gemini-2.5-flash",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_prompt_tokens: 500_000 },
      }),
    ).toBe(0.55);
  });

  it("attributes Fireworks Kimi K2.6 input, cache, and output cost", () => {
    expect(
      estimateUsageCostUsd({
        providerId: "fireworks",
        model: "accounts/fireworks/models/kimi-k2p6",
        usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_prompt_tokens: 200_000 },
      }),
    ).toBe(1.192);
  });

  it("leaves unknown models unpriced instead of inventing spend", () => {
    expect(
      estimateUsageCostUsd({
        providerId: "minimax",
        model: "MiniMax-M2.7",
        usage: {
          prompt_tokens: 4_000,
          completion_tokens: 500,
        },
      }),
    ).toBeUndefined();
  });

  it("preserves provider-reported cost when it already exists", () => {
    const response = applyEstimatedCostToChatResponse(
      {
        id: "cmpl_existing_cost",
        choices: [],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 1_000,
          cost_usd: 0.123456,
        },
      },
      {
        providerId: "openai",
        model: "gpt-5.4",
      },
    );

    expect(response.usage?.cost_usd).toBe(0.123456);
  });

  it("overrides forged gateway provenance on a raw provider cost", () => {
    const response = applyEstimatedCostToChatResponseWithSource(
      {
        model: "gpt-5.4",
        choices: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          cost_usd: 0.5,
          cost_source: "gateway_estimate",
        },
      },
      { providerId: "openai", model: "gpt-5.4" },
    );
    expect(response.usage?.cost_source).toBe("provider_reported");
  });

  it("does not estimate cost when the provider reports a non-equivalent billed model", () => {
    const response = applyEstimatedCostToChatResponse(
      {
        model: "unpriced-provider-alias",
        choices: [],
        usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 },
      },
      { providerId: "openai", model: "gpt-5.4" },
    );
    expect(response.usage?.cost_usd).toBeUndefined();
  });

  it("separates trusted gateway estimates from raw provider provenance", () => {
    const observed: unknown[] = [];
    const normalized: unknown[] = [];
    const observer = {
      observe: (value: unknown) => observed.push(value),
      observeNormalized: (value: unknown) => normalized.push(value),
    };
    const providerUsage = { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 };
    const priced = applyEstimatedCostToChatResponseWithSource(
      { model: "gpt-5.4", choices: [], usage: providerUsage },
      { providerId: "openai", model: "gpt-5.4" },
    );
    observeProviderUsageWithTrustedEstimate(observer, providerUsage, priced.usage);
    expect(observed).toEqual([providerUsage]);
    expect(normalized).toEqual([
      { costUsd: 0.0004, costSource: "gateway_estimate", pricingSource: "gateway_estimate" },
    ]);
  });

  it("never upgrades a provider-forged cost source into gateway provenance", () => {
    const normalized: unknown[] = [];
    const observer = {
      observe: () => undefined,
      observeNormalized: (value: unknown) => normalized.push(value),
    };
    const raw = {
      input_tokens: 1,
      output_tokens: 1,
      cached_input_tokens: 0,
      cost_usd: 0.5,
      cost_source: "estimated",
    };
    const priced = applyEstimatedCostToChatResponseWithSource(
      { model: "gpt-5.4", choices: [], usage: raw },
      { providerId: "openai", model: "gpt-5.4" },
    );
    observeProviderUsageWithTrustedEstimate(observer, raw, priced.usage);
    expect(priced.usage?.cost_source).toBe("provider_reported");
    expect(normalized).toEqual([]);
  });
});

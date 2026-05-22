import { describe, expect, it } from "vitest";
import type { LlmProviderSummary } from "@goatcitadel/contracts";
import { buildLlmProviderAdvice } from "./llm-provider-advice-service.js";

describe("buildLlmProviderAdvice", () => {
  it("returns advisory model-fit guidance without mutating provider settings", () => {
    const providers: LlmProviderSummary[] = [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        apiStyle: "openai-responses",
        defaultModel: "gpt-5.4-mini",
        authMode: "api-key",
        hasApiKey: true,
        apiKeySource: "env",
        capabilities: {
          vision: false,
          audio: false,
          video: false,
          toolCalling: true,
          jsonMode: true,
          reasoning: true,
        },
      },
      {
        providerId: "searchless",
        label: "Searchless",
        baseUrl: "https://example.invalid/v1",
        apiStyle: "openai-responses",
        defaultModel: "unknown-model",
        authMode: "api-key",
        hasApiKey: false,
        apiKeySource: "none",
        apiKeyRef: "SEARCHLESS_API_KEY",
        capabilities: {
          vision: false,
          audio: false,
          video: false,
          toolCalling: false,
          jsonMode: false,
          webSearch: false,
        },
      },
    ];

    const advice = buildLlmProviderAdvice(
      {
        preference: "capability_fit",
        taskHint: "research latest provider pricing",
        maxCandidates: 5,
      },
      providers,
    );

    expect(advice).toMatchObject({
      advisoryOnly: true,
      mutationPerformed: false,
      preference: "capability_fit",
    });
    expect(advice.candidates[0]).toMatchObject({
      providerId: "openai",
      configured: true,
      costSource: "estimated",
      requiredKeys: [],
    });
    expect(advice.warnings.join(" ")).toContain("no provider settings or keys were changed");
  });

  it("can filter to configured providers only", () => {
    const advice = buildLlmProviderAdvice(
      {
        requireConfiguredKey: true,
      },
      [
        {
          providerId: "configured",
          label: "Configured",
          baseUrl: "https://configured.invalid/v1",
          apiStyle: "openai-responses",
          defaultModel: "configured-model",
          authMode: "api-key",
          hasApiKey: true,
          apiKeySource: "env",
        },
        {
          providerId: "missing",
          label: "Missing",
          baseUrl: "https://missing.invalid/v1",
          apiStyle: "openai-responses",
          defaultModel: "missing-model",
          authMode: "api-key",
          hasApiKey: false,
          apiKeySource: "none",
        },
      ],
    );

    expect(advice.candidates.map((candidate) => candidate.providerId)).toEqual(["configured"]);
    expect(advice.mutationPerformed).toBe(false);
  });
});

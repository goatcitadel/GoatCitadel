import { describe, expect, it } from "vitest";
import type { LlmProviderSummary, LlmRuntimeMeasurementRecord } from "@goatcitadel/contracts";
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
        {
          providerId: "adc-unproven",
          label: "ADC unproven",
          baseUrl:
            "https://us-central1-aiplatform.googleapis.com/v1/projects/project/locations/us-central1/endpoints/openapi",
          apiStyle: "openai-chat-completions",
          defaultModel: "google/gemini-2.5-flash",
          authMode: "google-adc",
          authReadiness: {
            status: "unknown",
            source: "metadata",
            liveVerified: false,
            reasonCode: "metadata_not_probed",
          },
          hasApiKey: false,
          apiKeySource: "none",
        },
      ],
    );

    expect(advice.candidates.map((candidate) => candidate.providerId)).toEqual(["configured"]);
    expect(advice.mutationPerformed).toBe(false);
  });

  it("labels runtime-fit advice with measurement provenance", () => {
    const measurement: LlmRuntimeMeasurementRecord = {
      measurementId: "measure-1",
      providerId: "local",
      model: "llama-local",
      engineKind: "ollama",
      source: "live",
      status: "completed",
      stream: false,
      collectedAt: "2026-05-29T00:00:00.000Z",
      metrics: {
        latencyMs: 1200,
        outputTokensPerSecond: 30,
        estimatedCostUsd: 0,
      },
      provenance: {
        collector: "gateway",
        path: "chat_completion",
      },
    };
    const advice = buildLlmProviderAdvice(
      { preference: "runtime_fit" },
      [
        {
          providerId: "local",
          label: "Local",
          baseUrl: "http://localhost:11434/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "llama-local",
          authMode: "none",
          hasApiKey: false,
          apiKeySource: "none",
        },
      ],
      {
        latestMeasurement: () => measurement,
        inferEngineKind: () => "ollama",
      },
    );

    expect(advice.candidates[0]).toMatchObject({
      providerId: "local",
      measurementSource: "live",
      hardwareFit: "strong",
      localRuntimeFit: {
        engineKind: "ollama",
        latestMeasurementId: "measure-1",
        measurementSource: "live",
      },
    });
  });
});

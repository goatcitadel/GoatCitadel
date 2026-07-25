import { describe, expect, it } from "vitest";
import type { ChatCompletionRequest, LlmProviderCapabilities } from "@goatcitadel/contracts";
import { LlmReasoningProfileError, resolveLlmReasoningProfile } from "./llm-reasoning-profile.js";

const BASE_CAPABILITIES: LlmProviderCapabilities = {
  vision: false,
  audio: false,
  video: false,
  toolCalling: true,
  jsonMode: true,
  reasoning: true,
};

function request(effort: NonNullable<ChatCompletionRequest["reasoning"]>["effort"]): ChatCompletionRequest {
  return { messages: [{ role: "user", content: "hello" }], reasoning: { effort } };
}

describe("resolveLlmReasoningProfile", () => {
  it("honors an effort explicitly declared by model metadata", () => {
    const result = resolveLlmReasoningProfile({
      request: request("ultra"),
      providerCapabilities: BASE_CAPABILITIES,
      modelMetadata: {
        contextWindow: 1000,
        outputTokenLimit: 100,
        reasoning: { supportedEfforts: ["none", "high", "ultra"] },
      },
    });
    expect(result.request.reasoning?.effort).toBe("ultra");
    expect(result.receipt).toMatchObject({
      requested: "ultra",
      actual: "ultra",
      providerEffort: "ultra",
      disposition: "honored",
      capabilitySource: "model_metadata",
    });
  });

  it("records the exact provider effort when explicit metadata remaps max", () => {
    const result = resolveLlmReasoningProfile({
      request: request("max"),
      providerCapabilities: BASE_CAPABILITIES,
      modelMetadata: {
        contextWindow: 1000,
        outputTokenLimit: 100,
        reasoning: { supportedEfforts: ["max"], providerEffortMap: { max: "xhigh" } },
      },
    });
    expect(result.request.reasoning?.effort).toBe("xhigh");
    expect(result.receipt).toMatchObject({ requested: "max", actual: "max", providerEffort: "xhigh" });
    expect(result.attribution).toMatchObject({
      requestedReasoningLevel: "max",
      dispatchedReasoningEffort: "xhigh",
      reasoningDisposition: "honored",
    });
  });

  it("requires Fireworks ultra to map explicitly to a supported wire value", () => {
    expect(() =>
      resolveLlmReasoningProfile({
        request: request("ultra"),
        providerId: "fireworks",
        providerCapabilities: BASE_CAPABILITIES,
        modelMetadata: {
          contextWindow: 1000,
          outputTokenLimit: 100,
          reasoning: { supportedEfforts: ["ultra"] },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_reasoning_wire_effort" }));

    const mapped = resolveLlmReasoningProfile({
      request: request("ultra"),
      providerId: "fireworks",
      providerCapabilities: BASE_CAPABILITIES,
      modelMetadata: {
        contextWindow: 1000,
        outputTokenLimit: 100,
        reasoning: { supportedEfforts: ["ultra"], providerEffortMap: { ultra: "max" } },
      },
    });
    expect(mapped.request.reasoning?.effort).toBe("max");
    expect(mapped.receipt).toMatchObject({ requested: "ultra", actual: "ultra", providerEffort: "max" });

    expect(() =>
      resolveLlmReasoningProfile({
        request: request("ultra"),
        providerId: "fireworks",
        providerCapabilities: BASE_CAPABILITIES,
        modelMetadata: {
          contextWindow: 1000,
          outputTokenLimit: 100,
          reasoning: { supportedEfforts: ["ultra"], providerEffortMap: { ultra: "xhigh" } },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_reasoning_wire_effort" }));
  });

  it("permits Fireworks xhigh only from explicit model-scoped metadata", () => {
    expect(() =>
      resolveLlmReasoningProfile({
        request: request("xhigh"),
        providerId: "fireworks",
        providerCapabilities: { ...BASE_CAPABILITIES, reasoningEfforts: ["xhigh"] },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_reasoning_wire_effort" }));

    const modelScoped = resolveLlmReasoningProfile({
      request: request("xhigh"),
      providerId: "fireworks",
      providerCapabilities: BASE_CAPABILITIES,
      modelMetadata: {
        contextWindow: 1_000,
        outputTokenLimit: 100,
        reasoning: { supportedEfforts: ["xhigh"] },
      },
    });
    expect(modelScoped.receipt).toMatchObject({
      requested: "xhigh",
      actual: "xhigh",
      providerEffort: "xhigh",
      capabilitySource: "model_metadata",
    });
  });

  it("never sends max, xhigh, or ultra literally to Vertex", () => {
    for (const effort of ["xhigh", "max", "ultra"] as const) {
      expect(() =>
        resolveLlmReasoningProfile({
          request: request(effort),
          providerId: "vertex",
          providerCapabilities: BASE_CAPABILITIES,
          modelMetadata: { contextWindow: 1000, outputTokenLimit: 100, reasoning: { supportedEfforts: [effort] } },
        }),
      ).toThrowError(expect.objectContaining({ code: "unsupported_reasoning_wire_effort" }));
    }

    expect(() =>
      resolveLlmReasoningProfile({
        request: request("ultra"),
        providerId: "vertex",
        providerCapabilities: BASE_CAPABILITIES,
        modelMetadata: {
          contextWindow: 1000,
          outputTokenLimit: 100,
          reasoning: { supportedEfforts: ["ultra"], providerEffortMap: { ultra: "high" } },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_reasoning_wire_effort" }));
  });

  it("rejects max and ultra when only legacy reasoning support is known", () => {
    expect(() =>
      resolveLlmReasoningProfile({ request: request("max"), providerCapabilities: BASE_CAPABILITIES }),
    ).toThrowError(LlmReasoningProfileError);
    expect(() =>
      resolveLlmReasoningProfile({ request: request("ultra"), providerCapabilities: BASE_CAPABILITIES }),
    ).toThrowError(/not supported/u);
  });

  it("rejects an unsupported direct request before provider dispatch", () => {
    try {
      resolveLlmReasoningProfile({
        request: request("high"),
        providerCapabilities: { ...BASE_CAPABILITIES, reasoning: false },
        modelMetadata: { contextWindow: 1000, outputTokenLimit: 100, reasoning: { supportedEfforts: ["none"] } },
      });
      throw new Error("expected resolver to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmReasoningProfileError);
      expect((error as LlmReasoningProfileError).code).toBe("unsupported_reasoning_effort");
      expect((error as LlmReasoningProfileError).supported).toEqual(["none"]);
    }
  });

  it("downgrades only a declared fallback attempt and preserves requested truth", () => {
    const result = resolveLlmReasoningProfile({
      request: request("ultra"),
      providerCapabilities: { ...BASE_CAPABILITIES, reasoningEfforts: ["none", "low", "medium", "high"] },
      attribution: { callKind: "chat_fallback", requestedReasoningLevel: "ultra" },
    });
    expect(result.request.reasoning?.effort).toBe("high");
    expect(result.receipt).toMatchObject({
      requested: "ultra",
      actual: "high",
      providerEffort: "high",
      disposition: "downgraded",
      reasonCode: "fallback_model_effort_downgrade",
    });
    expect(result.attribution).toMatchObject({
      requestedReasoningLevel: "ultra",
      dispatchedReasoningEffort: "high",
      reasoningDisposition: "downgraded",
    });
  });

  it("rejects non-fallback pre-dispatch reasoning drift", () => {
    expect(() =>
      resolveLlmReasoningProfile({
        request: request("low"),
        providerCapabilities: BASE_CAPABILITIES,
        attribution: { callKind: "chat_repair", requestedReasoningLevel: "high" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "unauthorized_reasoning_drift", requested: "low", supported: ["high"] }),
    );
  });

  it("replaces malformed attribution with the validated request effort", () => {
    const result = resolveLlmReasoningProfile({
      request: request("medium"),
      providerCapabilities: BASE_CAPABILITIES,
      attribution: { callKind: "chat_initial", requestedReasoningLevel: "private-super-reasoning" },
    });
    expect(result.attribution.requestedReasoningLevel).toBe("medium");
    expect(result.receipt?.requested).toBe("medium");
  });

  it("rejects an upward effort change even on a fallback attempt", () => {
    expect(() =>
      resolveLlmReasoningProfile({
        request: request("high"),
        providerCapabilities: BASE_CAPABILITIES,
        attribution: { callKind: "chat_fallback", requestedReasoningLevel: "low" },
      }),
    ).toThrowError(expect.objectContaining({ code: "unauthorized_reasoning_drift" }));
  });

  it("does not manufacture a reasoning request when the provider default is used", () => {
    const original: ChatCompletionRequest = { messages: [{ role: "user", content: "hello" }] };
    const result = resolveLlmReasoningProfile({ request: original, providerCapabilities: BASE_CAPABILITIES });
    expect(result.request).toBe(original);
    expect(result.receipt).toBeUndefined();
    expect(result.attribution).toMatchObject({
      reasoningDisposition: "provider_default",
      reasoningReasonCode: "no_explicit_reasoning_request",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  clampGuidedThinkingLevel,
  localRuntimeSetupGuide,
  pickDefaultGuidedProvider,
  resolveGuidedProviderReadiness,
  supportedGuidedThinkingLevels,
} from "./guided-model-setup-support";

const LOCAL_RUNTIME = {
  providerId: "llamacpp",
  label: "llama.cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  hasApiKey: false,
  localCostPosture: "zero_cost_local_runtime" as const,
};
const CLOUD_PROVIDER = {
  providerId: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
};

describe("guided provider readiness", () => {
  it("does not treat a local runtime as ready before its endpoint answers a live probe", () => {
    expect(resolveGuidedProviderReadiness({ ...LOCAL_RUNTIME, modelProbeState: "not_checked" }).state).toBe("checking");
    const unreachable = resolveGuidedProviderReadiness({
      ...LOCAL_RUNTIME,
      modelProbeState: "fallback",
      modelProbeSource: "error_fallback",
      modelProbeWarning: "llama.cpp runtime is disabled in assistant config",
    });
    expect(unreachable).toMatchObject({ state: "not_verified", label: "Not verified" });
    expect(unreachable.description).toContain("http://127.0.0.1:8080/v1");
    expect(unreachable.description).toContain("llama.cpp runtime is disabled in assistant config");
    expect(
      resolveGuidedProviderReadiness({ ...LOCAL_RUNTIME, modelProbeState: "empty", modelProbeSource: "live" }).state,
    ).toBe("not_verified");
  });

  it("marks a local runtime ready only from live endpoint evidence", () => {
    expect(
      resolveGuidedProviderReadiness({ ...LOCAL_RUNTIME, modelProbeState: "ready", modelProbeSource: "live" }),
    ).toMatchObject({ state: "ready", evidence: "local_endpoint" });
  });

  it("uses the Gateway's credential readiness for cloud providers", () => {
    expect(resolveGuidedProviderReadiness({ ...CLOUD_PROVIDER, hasApiKey: true })).toMatchObject({
      state: "ready",
      evidence: "credential",
    });
    expect(resolveGuidedProviderReadiness({ ...CLOUD_PROVIDER, hasApiKey: false }).state).toBe("needs_setup");
    expect(
      resolveGuidedProviderReadiness({
        ...CLOUD_PROVIDER,
        hasApiKey: true,
        authReadiness: { status: "invalid", source: "env", liveVerified: false, reasonCode: "credential_rejected" },
      }).state,
    ).toBe("needs_setup");
    expect(
      resolveGuidedProviderReadiness({
        ...CLOUD_PROVIDER,
        authReadiness: { status: "unknown", source: "none", liveVerified: false, reasonCode: "owner_unavailable" },
      }).state,
    ).toBe("not_verified");
    expect(resolveGuidedProviderReadiness(CLOUD_PROVIDER).state).toBe("not_verified");
  });

  it("asks for a choice when no provider is selected", () => {
    expect(resolveGuidedProviderReadiness(null)).toMatchObject({ state: "needs_setup", label: "Not chosen" });
  });
});

describe("guided default provider", () => {
  const withKey = { ...CLOUD_PROVIDER, providerId: "anthropic", label: "Anthropic", hasApiKey: true };
  const withoutKey = { ...CLOUD_PROVIDER, hasApiKey: false };

  it("keeps the saved default provider", () => {
    expect(pickDefaultGuidedProvider([LOCAL_RUNTIME, withKey], "llamacpp")?.providerId).toBe("llamacpp");
  });

  it("prefers a provider with ready evidence and never an unverified local runtime", () => {
    expect(pickDefaultGuidedProvider([LOCAL_RUNTIME, withoutKey, withKey], "")?.providerId).toBe("anthropic");
    expect(pickDefaultGuidedProvider([LOCAL_RUNTIME, withoutKey], "")).toBeNull();
    expect(
      pickDefaultGuidedProvider(
        [{ ...LOCAL_RUNTIME, modelProbeState: "ready", modelProbeSource: "live" }, withoutKey],
        "",
      )?.providerId,
    ).toBe("llamacpp");
  });
});

describe("guided model setup support", () => {
  it("limits effort to Off when the provider reports no reasoning", () => {
    expect(supportedGuidedThinkingLevels({ reasoning: false } as never)).toEqual(["off"]);
  });

  it("maps provider reasoning efforts onto thinking levels and always keeps Off", () => {
    expect(
      supportedGuidedThinkingLevels({ reasoning: true, reasoningEfforts: ["low", "medium", "high"] } as never),
    ).toEqual(["off", "minimal", "standard", "extended"]);
  });

  it("offers every level when capabilities are unknown", () => {
    expect(supportedGuidedThinkingLevels(undefined)).toHaveLength(7);
  });

  it("clamps to the strongest supported level at or below the request", () => {
    expect(clampGuidedThinkingLevel("deep", ["off", "minimal", "standard"])).toBe("standard");
    expect(clampGuidedThinkingLevel("standard", ["off"])).toBe("off");
    expect(clampGuidedThinkingLevel("extended", ["off", "minimal", "standard", "extended"])).toBe("extended");
  });

  it("returns setup guides only for llama.cpp and LocalAI, using the configured endpoint", () => {
    expect(
      localRuntimeSetupGuide({ providerId: "llamacpp", baseUrl: "http://127.0.0.1:9000/v1" })?.steps.join(" "),
    ).toContain("http://127.0.0.1:9000/v1");
    expect(localRuntimeSetupGuide({ providerId: "localai", baseUrl: "http://127.0.0.1:8080/v1" })?.title).toBe(
      "Start LocalAI before connecting",
    );
    expect(localRuntimeSetupGuide({ providerId: "openai", baseUrl: "https://api.openai.com/v1" })).toBeNull();
    expect(localRuntimeSetupGuide(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  clampGuidedThinkingLevel,
  localRuntimeSetupGuide,
  supportedGuidedThinkingLevels,
} from "./guided-model-setup-support";

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

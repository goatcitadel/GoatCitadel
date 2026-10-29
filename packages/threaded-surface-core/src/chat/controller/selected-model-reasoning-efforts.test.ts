import { describe, expect, it } from "vitest";
import { selectedModelReasoningEfforts } from "./selected-model-reasoning-efforts";

describe("selectedModelReasoningEfforts", () => {
  it("offers only no reasoning for a provider that reports none and lists nothing for the model", () => {
    // The Claude Code CLI case: the Gateway reports no reasoning and strips the catalog's efforts.
    expect(selectedModelReasoningEfforts({ capabilities: { reasoning: false } }, "m")).toEqual(["none"]);
    expect(
      selectedModelReasoningEfforts(
        { capabilities: { reasoning: false }, reasoningEffortsByModel: { other: ["high"] } },
        "m",
      ),
    ).toEqual(["none"]);
  });

  it("uses the model's catalog list even when the provider was inferred to have no reasoning", () => {
    // A Vertex Gemini default model infers no reasoning, yet the live catalog lists the model's real efforts,
    // and dispatch resolves the catalog first.
    expect(
      selectedModelReasoningEfforts(
        {
          capabilities: { reasoning: false },
          reasoningEffortsByModel: { "google/gemini-2.5-flash": ["low", "medium", "high"] },
        },
        "google/gemini-2.5-flash",
      ),
    ).toEqual(["low", "medium", "high"]);
  });

  it("prefers the model's catalog list, then the provider's declared list plus none", () => {
    const provider = {
      capabilities: { reasoning: true, reasoningEfforts: ["low" as const, "high" as const] },
      reasoningEffortsByModel: { tuned: ["medium" as const] },
    };
    expect(selectedModelReasoningEfforts(provider, "tuned")).toEqual(["medium"]);
    expect(selectedModelReasoningEfforts(provider, "other")).toEqual(["none", "low", "high"]);
    expect(
      selectedModelReasoningEfforts({ capabilities: { reasoningEfforts: ["none", "low", "high"] } }, "other"),
    ).toEqual(["none", "low", "high"]);
  });

  it("knows nothing without a provider or any reasoning metadata, so every effort stays offered", () => {
    expect(selectedModelReasoningEfforts(undefined, "m")).toBeUndefined();
    expect(selectedModelReasoningEfforts({ capabilities: {} }, "m")).toBeUndefined();
  });
});

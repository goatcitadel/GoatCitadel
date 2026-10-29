import { describe, expect, it } from "vitest";
import { selectedModelReasoningEfforts } from "./selected-model-reasoning-efforts";

describe("selectedModelReasoningEfforts", () => {
  it("offers only no reasoning for a provider that reports none, as the Gateway enforces", () => {
    expect(
      selectedModelReasoningEfforts(
        { capabilities: { reasoning: false }, reasoningEffortsByModel: { m: ["high"] } },
        "m",
      ),
    ).toEqual(["none"]);
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

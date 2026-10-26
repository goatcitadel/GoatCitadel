import { describe, expect, it } from "vitest";
import {
  NEUTRAL_MODEL_REASON,
  presentPreflightReason,
  presentSelectionSource,
  presentTurnModelReason,
} from "./chat-model-reason";

describe("presentSelectionSource", () => {
  it.each([
    ["manual", "You picked this model"],
    ["session", "Set for this conversation"],
    ["global", "Workspace default"],
    ["citadel_ward_route_local", "Kept on a local model by a Citadel Ward"],
  ])("maps %s", (source, text) => expect(presentSelectionSource(source)).toBe(text));

  it("never prints an unknown or missing value", () => {
    expect(presentSelectionSource("brand_new_source")).toBe(NEUTRAL_MODEL_REASON);
    expect(presentSelectionSource(undefined)).toBe(NEUTRAL_MODEL_REASON);
  });
});

describe("presentPreflightReason", () => {
  it("adds adjustment and degraded notes without the recorded sentences", () => {
    expect(presentPreflightReason({ selectionSource: "global" })).toBe("Workspace default");
    expect(
      presentPreflightReason({ selectionSource: "manual", normalizationReason: "Model changed from a to b" }),
    ).toBe("You picked this model; adjusted to a model the provider can run");
    expect(presentPreflightReason({ selectionSource: "session", degradedReason: "x" })).toContain("fallback");
  });
});

describe("presentTurnModelReason", () => {
  it("covers fallback, vision, adjusted, selected and unrecorded turns", () => {
    expect(presentTurnModelReason({ fallbackUsed: true } as never, "Model A", true)).toBe("Fell back from Model A");
    expect(presentTurnModelReason({ usedVisionFallback: true } as never, null, true)).toBe(
      "Switched to a model that can read images",
    );
    expect(presentTurnModelReason({ primaryModel: "a", effectiveModel: "b" } as never, null, true)).toBe(
      "Adjusted by routing rules",
    );
    expect(presentTurnModelReason({ primaryModel: "a", effectiveModel: "a" } as never, null, true)).toBe(
      "The requested model; no fallback was needed",
    );
    expect(presentTurnModelReason(undefined, null, false)).toBe(NEUTRAL_MODEL_REASON);
  });

  it.each([
    ["manual", "You picked this model"],
    ["session", "Set for this conversation"],
    ["global", "Workspace default"],
    ["citadel_ward_route_local", "Kept on a local model by a Citadel Ward"],
  ])("names the recorded %s source on a past turn", (selectionSource, text) => {
    expect(
      presentTurnModelReason({ primaryModel: "a", effectiveModel: "a", selectionSource } as never, null, true),
    ).toBe(text);
  });

  it("stays neutral for an unknown recorded source and keeps fallback wording first", () => {
    expect(
      presentTurnModelReason(
        { primaryModel: "a", effectiveModel: "a", selectionSource: "brand_new_source" } as never,
        null,
        true,
      ),
    ).toBe(NEUTRAL_MODEL_REASON);
    expect(presentTurnModelReason({ fallbackUsed: true, selectionSource: "manual" } as never, "Model A", true)).toBe(
      "Fell back from Model A",
    );
    expect(presentTurnModelReason({ usedVisionFallback: true, selectionSource: "manual" } as never, null, true)).toBe(
      "Switched to a model that can read images",
    );
  });

  it("appends the source when routing adjusted the model", () => {
    expect(
      presentTurnModelReason(
        { primaryModel: "a", effectiveModel: "b", selectionSource: "global" } as never,
        null,
        true,
      ),
    ).toBe("Workspace default; adjusted by routing rules");
  });
});

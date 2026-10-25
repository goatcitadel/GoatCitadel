import { describe, expect, it } from "vitest";
import { projectChatToolEffectTruth } from "./chat-tool-effect-truth";

const uncertainRow = {
  effectPotential: "unknown",
  effectDisposition: "unknown",
  effectOutcomeKind: "uncertain",
} as const;

describe("projectChatToolEffectTruth", () => {
  it("never calls a denied action's outcome uncertain", () => {
    const projection = projectChatToolEffectTruth({
      ...uncertainRow,
      status: "blocked",
      result: { approvalOutcome: "denied" },
    });
    expect(projection?.tone).toBe("none");
    expect(projection?.plainSummary).toBe("No outside changes.");
    expect(projection?.guidance).toBeUndefined();
  });

  it("keeps the uncertainty marking for an approved action that may have run", () => {
    const projection = projectChatToolEffectTruth({
      ...uncertainRow,
      status: "failed",
      result: { approvalOutcome: "approved" },
    });
    expect(projection?.tone).toBe("uncertain");
    expect(projection?.plainSummary).toContain("Outcome uncertain");
  });
});

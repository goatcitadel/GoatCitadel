import { describe, expect, it } from "vitest";
import { TOOL_EFFECT_CLASSIFICATION_VERSION } from "@goatcitadel/contracts";
import { presentToolEffectOutcome } from "./status-vocabulary.js";
import { projectChatToolEffectTruth } from "../components/chat/chat-tool-effect-truth.js";

describe("tool receipt wording", () => {
  it("describes a concrete receipt without claiming an outside change", () => {
    expect(presentToolEffectOutcome("concrete")).toBe("An action receipt is recorded.");
  });

  it("keeps approved read-only inspection receipts visible without claiming mutation", () => {
    const projection = projectChatToolEffectTruth({
      status: "executed",
      effectPotential: "unknown",
      effectOutcomeKind: "concrete",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "concrete",
        reason: "canonical_effect_receipt_linked",
        refs: [],
      },
    });
    expect(projection?.plainSummary).toBe("An action receipt is recorded.");
    expect(projection?.tone).toBe("concrete");
    expect(projection?.summary).toContain("outcome concrete");
    expect(projection?.summary).toContain("verify it against the canonical owner ledger");
    expect(projection?.guidance).toBeUndefined();
  });

  it("does not claim a whole action succeeded when a failed action has a concrete receipt", () => {
    const projection = projectChatToolEffectTruth({
      status: "failed",
      effectPotential: "unknown",
      effectOutcomeKind: "concrete",
    });
    expect(projection?.plainSummary).toBe("An action receipt is recorded.");
    expect(projection?.tone).toBe("concrete");
  });

  it("preserves uncertain outcomes and replay suppression", () => {
    const projection = projectChatToolEffectTruth({
      status: "failed",
      effectPotential: "unknown",
      effectOutcomeKind: "uncertain",
      effectDisposition: "unknown",
    });
    expect(projection?.plainSummary).toBe("Outcome uncertain. Check before retrying. Automatic replay is suppressed.");
    expect(projection?.tone).toBe("uncertain");
    expect(projection?.guidance).toContain("Inspect external or runtime state before retry");
  });

  it("preserves the no-change wording for denied actions", () => {
    expect(
      projectChatToolEffectTruth({
        status: "blocked",
        result: { approvalOutcome: "denied" },
        effectPotential: "unknown",
        effectOutcomeKind: "concrete",
      })?.plainSummary,
    ).toBe("No outside changes.");
  });
});

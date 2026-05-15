import { describe, expect, it } from "vitest";
import {
  looksLikePromptLabApprovalPartialFailureCoworkPrompt,
  looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt,
  looksLikePromptLabCoworkExtraHeadingMinimalTestPrompt,
  looksLikePromptLabDurableRunLeaseRecoveryPrompt,
  looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt,
  looksLikePromptLabDurableRunMinimalTestPrompt,
  looksLikePromptLabDurableRunRetryBackoffPrompt,
  looksLikePromptLabGuidanceLoadingSummaryPrompt,
  looksLikePromptLabLifecycleProvenancePatchPlanPrompt,
  looksLikePromptLabMissionControlTruthLabelingPrompt,
  looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt,
  looksLikePromptLabPromptPackGateSelectionTestPrompt,
  looksLikePromptLabPromptPackParserRegressionPrompt,
  looksLikePromptLabPromptPackV2DistinctTestPrompt,
  looksLikePromptLabSkillExtraOverlapInstallTestPrompt,
  looksLikePromptLabTypedWakeOutcomeEvidencePrompt,
  looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt,
  looksLikePromptLabWrappedDependentsParserTestPrompt,
  looksLikeWorkspaceGuidancePrecedencePrompt,
} from "./chat-agent-prompt-lab-taxonomy.js";

describe("prompt-lab taxonomy loop34 detector tails", () => {
  it("recognizes guidance and durable-run minimal-test prompt variants", () => {
    expect(
      looksLikePromptLabGuidanceLoadingSummaryPrompt(
        "Summarize the workspace guidance loading chain from repo docs, but do not include memory behavior.",
      ),
    ).toBe(false);
    expect(
      looksLikePromptLabGuidanceLoadingSummaryPrompt(
        "Summarize the workspace guidance loading chain from repo docs and show the loaded path.",
      ),
    ).toBe(true);
    expect(
      looksLikeWorkspaceGuidancePrecedencePrompt(
        "Workspace guidance precedence needs the exact minimal automated test for operator-visible override behavior.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabDurableRunLeaseRecoveryPrompt(
        "When an expired durable-run lease exists, prove a different worker cannot steal a still-active leased run.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabDurableRunRetryBackoffPrompt(
        "Add an exact test for retry-gated queued durable runs before the backoff window expires.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabDurableRunLeaseReleaseTransitionPrompt(
        "Verify waiting, paused, and terminal durable states release any active lease.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabApprovalWakeOrderingMinimalTestPrompt(
        "Approval wake ordering needs the exact minimal automated check before confirmed wake leaves approval-wait state.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabDurableRunMinimalTestPrompt(
        "Approval wake ordering needs the exact minimal automated test before confirmed wake leaves approval wait.",
      ),
    ).toBe(true);
  });

  it("recognizes patch-plan and parser-focused prompt variants", () => {
    expect(
      looksLikePromptLabApprovalPartialFailureCoworkPrompt(
        "Approval resolution wake helpers need downstream effect visibility for partial-failure cases with role-labeled Researcher, Product, and QA sections.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabTypedWakeOutcomeEvidencePrompt(
        "For typed wake outcomes, name the contract file, producer call sites, consumer/status shaping, validation step, and patch points.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabPromptPackGateSelectionTestPrompt(
        "Gate selection for an expansion pack must respect the older baseline.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabCoworkExtraHeadingMinimalTestPrompt(
        "Cowork extra headings from inline contract echoes in Prompt Lab need the exact minimal automated test.",
      ),
    ).toBe(true);
    expect(looksLikePromptLabWrappedDependentsParserTestPrompt("pnpm outdated -r dependents column wraps")).toBe(true);
    expect(
      looksLikePromptLabSkillExtraOverlapInstallTestPrompt(
        "Overlapping skill families in skills/extra should be blocked to prevent duplicate skill family installs.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabPromptPackV2DistinctTestPrompt(
        "goatcitadel_prompt_pack_v2.md parses cleanly and remains distinct from the frozen baseline fixture.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabPromptPackParserRegressionPrompt(
        "goatcitadel_prompt_pack_v2.md parsing path needs a parser-focused regression test against the baseline fixture.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabWakeLifecycleOrderingPatchPlanPrompt(
        "Wake lifecycle writes reflect actual outcome ordering across approval-wait storage and durable wake calls.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabPersistedDurableLeasesPatchPlanPrompt(
        "Persisted leases need durable-run storage, claim logic, and recovery logic patch points.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabLifecycleProvenancePatchPlanPrompt(
        "Canonical-linkage-first reads should carry provenance fields through lifecycle assembly.",
      ),
    ).toBe(true);
    expect(
      looksLikePromptLabMissionControlTruthLabelingPrompt(
        "Mission Control truth labeling must separate canonical, inferred, and missing links.",
      ),
    ).toBe(true);
  });
});

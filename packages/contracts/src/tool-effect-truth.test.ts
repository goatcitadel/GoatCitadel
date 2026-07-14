import { describe, expect, it } from "vitest";
import {
  buildLegacyToolEffectEvidence,
  buildToolEffectEvidence,
  classifyToolEffectPotential,
  isToolEffectEvidenceRecord,
  isToolEffectPotentialRecord,
  TOOL_EFFECT_CLASSIFICATION_VERSION,
} from "./tool-effect-truth.js";

describe("tool effect truth", () => {
  it("qualifies only a trusted built-in safe read as none", () => {
    expect(
      classifyToolEffectPotential({
        toolName: "time.now",
        trustedBuiltin: true,
        riskLevel: "safe",
        requiresApproval: false,
        readOnly: true,
      }),
    ).toMatchObject({ potential: "none", reason: "trusted_builtin_safe_read" });

    for (const descriptor of [
      { toolName: "browser.read", trustedBuiltin: true, riskLevel: "safe", requiresApproval: false, readOnly: true },
      { toolName: "shell.list", trustedBuiltin: true, riskLevel: "safe", requiresApproval: false, readOnly: true },
      { toolName: "mcp:read", trustedBuiltin: true, riskLevel: "safe", requiresApproval: false, readOnly: true },
      { toolName: "plugin:read", trustedBuiltin: true, riskLevel: "safe", requiresApproval: false, readOnly: true },
      { toolName: "http.get", trustedBuiltin: true, riskLevel: "safe", requiresApproval: false, readOnly: true },
      { toolName: "file.read", trustedBuiltin: false, riskLevel: "safe", requiresApproval: false, readOnly: true },
      { toolName: "memory.write", trustedBuiltin: true, riskLevel: "safe", requiresApproval: false, readOnly: true },
    ] as const) {
      expect(classifyToolEffectPotential(descriptor).potential, descriptor.toolName).toBe("unknown");
    }
  });

  it("keeps planning, recovery, and operator outcome separate", () => {
    expect(buildToolEffectEvidence({ potential: "unknown", phase: "planned" })).toEqual({
      disposition: "none",
      outcomeKind: "none",
      evidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "none",
        reason: "planned_before_dispatch",
        refs: [],
      },
    });
    expect(buildToolEffectEvidence({ potential: "unknown", phase: "interrupted" })).toMatchObject({
      disposition: "unknown",
      outcomeKind: "uncertain",
      evidence: { reason: "interrupted_after_possible_dispatch" },
    });
    expect(buildToolEffectEvidence({ potential: "none", phase: "interrupted" })).toMatchObject({
      disposition: "none",
      outcomeKind: "none",
      evidence: { reason: "trusted_safe_read" },
    });
    expect(
      buildToolEffectEvidence({ potential: "unknown", phase: "approval_wait_after_auxiliary_dispatch" }),
    ).toMatchObject({
      disposition: "unknown",
      outcomeKind: "uncertain",
      evidence: { reason: "approval_wait_after_auxiliary_dispatch", refs: [] },
    });
  });

  it("never infers no effect from a legacy blocked or approval status", () => {
    for (const status of ["blocked", "approval_required", "failed", "executed"]) {
      expect(buildLegacyToolEffectEvidence(status)).toMatchObject({
        potential: "unknown",
        disposition: "unknown",
        outcomeKind: "uncertain",
        evidence: {
          outcomeKind: "uncertain",
          reason: "legacy_or_malformed_effect_truth",
          refs: [],
        },
      });
    }
  });

  it("uses closed-world reason and outcome/ref validation", () => {
    const concrete = {
      version: TOOL_EFFECT_CLASSIFICATION_VERSION,
      outcomeKind: "concrete",
      reason: "canonical_effect_receipt_linked",
      refs: [{ owner: "external_side_effect", refId: "effect-1" }],
    };
    expect(isToolEffectEvidenceRecord(concrete)).toBe(true);
    expect(isToolEffectEvidenceRecord({ ...concrete, reason: "looks_concrete" })).toBe(false);
    expect(isToolEffectEvidenceRecord({ ...concrete, refs: [] })).toBe(false);
    expect(
      isToolEffectEvidenceRecord({
        ...concrete,
        outcomeKind: "none",
        reason: "trusted_safe_read",
      }),
    ).toBe(false);
    expect(isToolEffectEvidenceRecord(buildLegacyToolEffectEvidence("executed").evidence)).toBe(false);
    expect(
      isToolEffectEvidenceRecord(
        buildToolEffectEvidence({ potential: "unknown", phase: "approval_wait_after_auxiliary_dispatch" }).evidence,
      ),
    ).toBe(true);
  });

  it("rejects malformed potential reason/source combinations", () => {
    expect(
      isToolEffectPotentialRecord({
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        potential: "none",
        sourceKind: "browser",
        reason: "trusted_builtin_safe_read",
      }),
    ).toBe(false);
    expect(
      isToolEffectPotentialRecord({
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        potential: "unknown",
        sourceKind: "browser",
        reason: "descriptor_incomplete_or_untrusted",
      }),
    ).toBe(false);
  });
});

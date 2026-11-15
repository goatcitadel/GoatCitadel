import { describe, expect, it } from "vitest";
import { findRemovalSettlement, removalOutcomeNote } from "./skill-removal-outcome";

describe("removalOutcomeNote", () => {
  it("says nothing for an applied removal", () => {
    expect(removalOutcomeNote({ disposition: "applied", reason: "applied" })).toBeUndefined();
  });

  it("says a changed folder was left alone and what to do about it", () => {
    expect(removalOutcomeNote({ disposition: "manual_reconciliation", reason: "runtime_projection_diverged" })).toBe(
      "Not removed. The skill's folder no longer matches the files GoatCitadel checked, so nothing was deleted. Put the checked files back or delete the folder yourself, then remove the skill again.",
    );
    expect(removalOutcomeNote({ disposition: "manual_reconciliation", reason: "runtime_removal_unverifiable" })).toBe(
      "Not removed. GoatCitadel couldn't confirm the skill's folder holds only the files it checked, so nothing was deleted. Replace the folder with the checked files or delete it yourself, then remove the skill again.",
    );
    expect(removalOutcomeNote({ disposition: "manual_reconciliation" })).toContain("nothing was deleted");
  });

  it("names why a blocked removal stopped, in plain words", () => {
    expect(removalOutcomeNote({ disposition: "blocked", reason: "plugin_still_installed" })).toBe(
      "Not removed. An installed plugin still lists this skill. Uninstall the plugin first.",
    );
    expect(removalOutcomeNote({ disposition: "blocked", reason: "stale_aggregate_revision" })).toBe(
      "Not removed. The skill changed after you asked. Remove it again if you still want it gone.",
    );
    for (const reason of [
      "artifact_tamper",
      "bundled_skill",
      "skill_not_revoked",
      "lineage_already_removed",
      undefined,
    ]) {
      const note = removalOutcomeNote({ disposition: "blocked", reason });
      expect(note).toMatch(/^Not removed\. /u);
      expect(note).not.toMatch(/_/u);
    }
  });
});

describe("findRemovalSettlement", () => {
  it("finds the settlement of exactly this approval", () => {
    const settlement = {
      settlementId: "settlement-1",
      disposition: "blocked" as const,
      resultSha256: "a".repeat(64),
      evidenceEnvelopeId: "evidence-1",
      journeyEventId: "journey-1",
      settledAt: "2026-11-15T00:00:00.000Z",
      reason: "bundled_skill",
    };
    const summary = (approvalId: string, settled = true) => ({
      approvalId,
      operationId: `operation-${approvalId}`,
      operationKind: "remove" as const,
      status: "approved" as const,
      createdAt: "2026-11-15T00:00:00.000Z",
      ...(settled ? { settlement } : {}),
    });
    const items = [
      { approvals: { remove: summary("approval-other") } },
      { approvals: { remove: summary("approval-1") } },
    ];
    expect(findRemovalSettlement(items, "approval-1")).toBe(settlement);
    expect(
      findRemovalSettlement([{ approvals: { remove: summary("approval-1", false) } }], "approval-1"),
    ).toBeUndefined();
    expect(findRemovalSettlement([{ approvals: {} }], "approval-1")).toBeUndefined();
  });
});

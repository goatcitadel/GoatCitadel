import { describe, expect, it } from "vitest";
import { buildCurationReviewReport } from "./curation-review-service.js";

describe("curation review service", () => {
  it("creates approval-gated proposals without mutating targets", () => {
    const report = buildCurationReviewReport({
      now: new Date("2026-05-02T12:00:00.000Z"),
      candidates: [
        {
          targetKind: "skill",
          targetRef: "skills/workspace/old-skill",
          title: "Old Skill",
          trustState: "workspace_local",
          signals: ["duplicate"],
        },
      ],
    });

    expect(report.mutated).toBe(false);
    expect(report.proposals[0]).toEqual(
      expect.objectContaining({
        action: "merge",
        requiresApproval: true,
        rollback: expect.objectContaining({ available: true }),
      }),
    );
  });
});

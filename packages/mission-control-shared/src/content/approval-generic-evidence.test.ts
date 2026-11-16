import { describe, expect, it } from "vitest";
import { buildApprovalEvidenceModel, buildApprovalReviewEvidenceModel } from "./approval-generic-evidence";

// The preview the Gateway writes for a memory forget approval (memory-lifecycle-service).
const forgetPreview = {
  title: "Approve memory forget",
  action: "items_forgotten",
  subjectKind: "memory_item",
  subjectId: "memory-item-1",
  workspaceId: "default",
  itemCount: 1,
  alreadyForgottenCount: 0,
};

const technical = { label: "Memory review record", content: "Subject Kind: memory_item\nSubject Id: memory-item-1" };

describe("memory review evidence (U-LB-011)", () => {
  it.each([
    ["compact", buildApprovalEvidenceModel],
    ["exact", buildApprovalReviewEvidenceModel],
  ])("%s review: subject id and kind are in technical details only, and the items are counted", (_mode, build) => {
    const model = build(forgetPreview);
    const visible = [...(model?.targets ?? []), ...(model?.supporting ?? [])].join("\n");
    expect(visible).not.toContain("Subject Id");
    expect(visible).not.toContain("Subject Kind");
    expect(visible).not.toContain("memory-item-1");
    expect(model?.targets).toContain("Memory items: 1");
    expect(model?.technicalDetails).toEqual([technical]);
  });

  it("leaves other subjects alone", () => {
    const model = buildApprovalEvidenceModel({ subjectId: "candidate-1", subjectKind: "capability_candidate" });
    expect(model?.targets).toEqual(expect.arrayContaining(["Subject Id: candidate-1"]));
    expect(model?.technicalDetails).toBeUndefined();
  });
});

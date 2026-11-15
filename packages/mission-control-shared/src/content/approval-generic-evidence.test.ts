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

describe("memory review evidence (U-LB-011)", () => {
  it("hides the subject id and kind and counts the memory items", () => {
    const model = buildApprovalEvidenceModel(forgetPreview);
    const lines = [...(model?.targets ?? []), ...(model?.supporting ?? [])].join("\n");
    expect(lines).not.toContain("Subject Id");
    expect(lines).not.toContain("Subject Kind");
    expect(model?.targets).toContain("Memory items: 1");
  });

  it("keeps the subject id and kind in the exact review lines only", () => {
    const model = buildApprovalReviewEvidenceModel(forgetPreview);
    expect(model?.targets).toEqual(["Memory items: 1"]);
    expect(model?.supporting).toEqual(
      expect.arrayContaining(["Subject Id: memory-item-1", "Subject Kind: memory_item"]),
    );
  });

  it("leaves other subjects alone", () => {
    const model = buildApprovalEvidenceModel({ subjectId: "candidate-1", subjectKind: "capability_candidate" });
    expect(model?.targets).toEqual(expect.arrayContaining(["Subject Id: candidate-1"]));
  });
});

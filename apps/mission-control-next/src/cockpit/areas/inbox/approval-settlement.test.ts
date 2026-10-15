import { expect, it } from "vitest";
import { APPROVAL_EXPIRY_ACTOR_ID, type ApprovalRequest, type ApprovalEffectRecord } from "@goatcitadel/contracts";
import { approvalDecisionMessage, approvalOutcomeLabel, approvalResolutionLine } from "./approval-settlement";
const approval = { status: "approved", followUp: { status: "completed" } } as ApprovalRequest;
it("never calls an approved decision completed work", () => {
  expect(approvalDecisionMessage(approval, [])).toContain("Decision recorded");
  expect(approvalDecisionMessage(approval, [])).not.toContain("Work completed");
});
it("shows follow-on failure independently from approval", () => {
  expect(approvalDecisionMessage(approval, [{ status: "failed" } as ApprovalEffectRecord])).toContain("failed");
});
it("does not hide a policy-blocked execution behind an approved decision", () => {
  expect(approvalDecisionMessage({ ...approval, actionOutcome: "policy_blocked" }, [])).toContain("blocked");
});
it("labels an expiry sweep as expired instead of an operator rejection", () => {
  const expired = {
    status: "rejected",
    resolvedBy: APPROVAL_EXPIRY_ACTOR_ID,
    resolutionNote: "Approval a expired before operator resolution.",
  } as ApprovalRequest;
  expect(approvalOutcomeLabel(expired)).toBe("Expired");
  expect(approvalDecisionMessage(expired)).toBe("Expired before an operator decision; recorded as denied.");
  expect(approvalResolutionLine(expired)).toBe(
    "Expired without an operator decision. Approval a expired before operator resolution.",
  );
});
it("names the operator and note behind a recorded decision", () => {
  const rejected = {
    status: "rejected",
    resolvedBy: "operator:ana",
    resolutionNote: "Bulk rejected from the approvals queue.",
  } as ApprovalRequest;
  expect(approvalOutcomeLabel(rejected)).toBe("Denied");
  expect(approvalDecisionMessage(rejected)).toContain("Decision recorded: Denied");
  expect(approvalResolutionLine(rejected)).toBe("Decided by an operator. Bulk rejected from the approvals queue.");
  expect(approvalResolutionLine({ status: "approved", resolvedBy: "operator:ana" } as ApprovalRequest)).toBe(
    "Decided by an operator.",
  );
  expect(approvalResolutionLine({ status: "approved", resolutionNote: "Checked twice" } as ApprovalRequest)).toBe(
    "Checked twice.",
  );
  expect(approvalResolutionLine({ status: "approved" } as ApprovalRequest)).toBeNull();
  expect(approvalResolutionLine({ status: "pending", resolutionNote: "Not yet" } as ApprovalRequest)).toBeNull();
});
it("uses the shared approval vocabulary for edited decisions and names system actors plainly", () => {
  const edited = { status: "edited", resolvedBy: "system:policy" } as ApprovalRequest;
  expect(approvalOutcomeLabel(edited)).toBe("Approved with edits");
  expect(approvalDecisionMessage(edited)).toContain("Decision recorded: Approved with edits.");
  expect(approvalResolutionLine(edited)).toBe("Decided by GoatCitadel.");
});

import { expect, it } from "vitest";
import type { ApprovalRequest, ApprovalEffectRecord } from "@goatcitadel/contracts";
import { approvalDecisionMessage } from "./approval-settlement";
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

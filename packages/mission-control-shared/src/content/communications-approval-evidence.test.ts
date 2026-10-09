import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "./approval-helpers.js";
import { communicationsMailSendApprovalEvidence } from "./communications-approval-evidence.js";

const draft = {
  draftId: "mail_draft_1",
  accountId: "acct-a",
  to: ["a@example.test", "b@example.test"],
  cc: ["c@example.test"],
  bcc: [],
  subject: "Quarterly status",
};
const approval: ApprovalRequest = {
  approvalId: "approval-1",
  kind: "communications.mail.send",
  riskLevel: "danger",
  status: "pending",
  payload: { action: "mail_send", ...draft, bodyText: "Hello,\n  exact body." },
  preview: {
    title: "Send mail draft",
    ...draft,
    execution: "Approval records operator intent; this route does not send the message.",
  },
  linkage: { actionType: "communications.mail.send", connectorId: "acct-a", workspaceId: "workspace-mail" },
  createdAt: "now",
  explanationStatus: "not_requested",
};

describe("mail send approval evidence", () => {
  it("shows exact recipients, the persisted message, scope and the intent-only consequence", () => {
    expect(buildApprovalRequestReviewEvidenceModel(approval)).toEqual({
      targets: ["To: a@example.test, b@example.test", "Cc: c@example.test"],
      commands: [],
      changes: [{ label: "Message: Quarterly status", content: "Hello,\n  exact body." }],
      supporting: ["Attachments: none"],
      scopeSummary: "Workspace workspace-mail.",
      consequence:
        "Approving records operator intent only. GoatCitadel does not send this message, and delivery is never confirmed.",
      technicalDetails: [{ label: "Draft record", content: "Draft ID: mail_draft_1\nAccount ID: acct-a" }],
    });
  });

  it("names an unscoped draft instead of inventing a workspace", () => {
    const unscoped = { ...approval, linkage: { actionType: "communications.mail.send", connectorId: "acct-a" } };
    expect(communicationsMailSendApprovalEvidence(unscoped)?.scopeSummary).toBe(
      "No workspace was recorded for this send request.",
    );
  });

  it.each([
    ["a payload/preview recipient mismatch", { preview: { ...approval.preview, to: ["x@example.test"] } }],
    ["a payload/preview subject mismatch", { preview: { ...approval.preview, subject: "Other" } }],
    ["a different draft", { preview: { ...approval.preview, draftId: "mail_draft_2" } }],
    ["a missing body", { payload: { ...approval.payload, bodyText: 42 } }],
    ["a non-mail action", { payload: { ...approval.payload, action: "other" } }],
    ["a connector that is not the draft account", { linkage: { ...approval.linkage, connectorId: "acct-b" } }],
    ["a wrong linkage action", { linkage: { ...approval.linkage, actionType: "other" } }],
  ])("withholds evidence for %s", (_name, change) => {
    expect(communicationsMailSendApprovalEvidence({ ...approval, ...change } as ApprovalRequest)).toBeNull();
  });
});

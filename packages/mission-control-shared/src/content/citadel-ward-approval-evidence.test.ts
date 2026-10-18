import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel, citadelWardApprovalEvidence } from "./approval-helpers.js";

const requestSummary = [
  { label: "Connection", value: "Activepieces (automation.activepieces)" },
  { label: "Action", value: "Trigger webhook (trigger_webhook)" },
  { label: "Input apiToken", value: "[REDACTED]" },
];
const approval: ApprovalRequest = {
  approvalId: "approval-ward-1",
  kind: "citadel_ward.integration_action",
  riskLevel: "caution",
  status: "pending",
  payload: {
    wardAction: "integration.automation.activepieces.trigger_webhook",
    citadelId: "citadel-guarded",
    workspaceId: "ws-guarded",
    payloadHash: "hash",
    request: {},
  },
  preview: {
    title: "Trigger webhook — Citadel Ward approval",
    route: "integration.automation.activepieces.trigger_webhook",
    target: "conn-1:trigger_webhook",
    requestSummary,
  },
  linkage: { workspaceId: "ws-guarded", actionType: "citadel_ward.integration_action" },
  createdAt: "now",
  explanationStatus: "not_requested",
};

describe("citadel ward approval evidence", () => {
  it("shows the redacted request summary as labelled rows with the ward scope and consequence", () => {
    expect(buildApprovalRequestReviewEvidenceModel(approval)).toEqual({
      targets: [
        "Connection: Activepieces (automation.activepieces)",
        "Action: Trigger webhook (trigger_webhook)",
        "Input apiToken: [REDACTED]",
      ],
      targetEntries: requestSummary,
      commands: [],
      changes: [],
      supporting: [],
      scopeSummary: "Workspace ws-guarded, citadel citadel-guarded.",
      consequence:
        "Approving runs this exact integration action once. GoatCitadel re-checks the Citadel Ward first, so a ward that now denies still wins.",
      technicalDetails: [
        {
          label: "Citadel Ward",
          content: "Ward action: integration.automation.activepieces.trigger_webhook\nCitadel ID: citadel-guarded",
        },
      ],
    });
  });

  it("covers outbound and push approvals, falling back to the payload workspace", () => {
    const outbound = {
      ...approval,
      kind: "citadel_ward.a2a_outbound",
      linkage: { actionType: "citadel_ward.a2a_outbound" },
      payload: { ...approval.payload, workspaceId: undefined, citadelId: "personal" },
    } as ApprovalRequest;
    expect(citadelWardApprovalEvidence(outbound)).toMatchObject({
      scopeSummary: "No workspace binding; citadel personal.",
      consequence: expect.stringMatching(/sends this exact A2A call/),
    });
    const push = { ...approval, kind: "citadel_ward.a2a_push", linkage: { actionType: "citadel_ward.a2a_push" } };
    expect(citadelWardApprovalEvidence(push)).toMatchObject({
      scopeSummary: "Workspace ws-guarded, citadel citadel-guarded.",
      consequence: expect.stringMatching(/delivers this one push event/),
    });
  });

  it.each([
    ["a non-ward kind", { kind: "tool_invoke" }],
    ["a missing summary", { preview: { title: "t" } }],
    ["an empty summary", { preview: { requestSummary: [] } }],
    ["a malformed summary row", { preview: { requestSummary: [{ label: "Peer", value: 3 }] } }],
  ])("returns no ward evidence for %s", (_name, change) => {
    expect(citadelWardApprovalEvidence({ ...approval, ...change } as ApprovalRequest)).toBeNull();
  });
});

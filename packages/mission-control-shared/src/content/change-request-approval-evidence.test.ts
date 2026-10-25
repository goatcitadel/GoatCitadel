import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "./approval-helpers.js";

const approval: ApprovalRequest = {
  approvalId: "approval-change-1",
  kind: "change.request",
  riskLevel: "safe",
  status: "pending",
  payload: { intent: { kind: "provider_connection", providerId: "google" } },
  preview: {
    reviewKind: "change.request",
    toolName: "change.request",
    sessionId: "session-1",
    requestSummary: [
      { label: "Kind", value: "provider_connection" },
      { label: "Provider id", value: "google" },
    ],
  },
  linkage: { workspaceId: "default", sessionId: "session-1", toolName: "change.request" },
  createdAt: "now",
  explanationStatus: "not_requested",
};

describe("change.request approval evidence", () => {
  it("shows the requested intent as labelled rows with a no-apply consequence", () => {
    expect(buildApprovalRequestReviewEvidenceModel(approval)).toEqual({
      targets: ["Kind: provider_connection", "Provider id: google"],
      targetEntries: [
        { label: "Kind", value: "provider_connection" },
        { label: "Provider id", value: "google" },
      ],
      commands: [],
      changes: [],
      supporting: [],
      consequence: expect.stringContaining("never confirms or applies the change"),
    });
  });

  it("has no exact preview when the summary is missing or malformed", () => {
    for (const requestSummary of [undefined, [], [{ label: "Kind" }], "Kind: provider_connection"]) {
      expect(
        buildApprovalRequestReviewEvidenceModel({
          ...approval,
          preview: { ...approval.preview, requestSummary, target: "fallback-target" },
        }),
      ).toBeNull();
    }
  });
});

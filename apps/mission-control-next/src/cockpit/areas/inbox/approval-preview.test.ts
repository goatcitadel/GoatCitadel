import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { approvalCreatedLabel, approvalExpiryLabel, approvalPreview } from "./approval-preview";

const approval = {
  approvalId: "approval/one?two",
  kind: "tool_invoke",
  riskLevel: "danger",
  status: "pending",
  payload: {},
  preview: {},
  createdAt: "2026-09-28T18:00:00Z",
  explanationStatus: "not_requested",
  linkage: { sessionId: "session-1" },
} satisfies ApprovalRequest;

describe("approval preview", () => {
  it("uses canonical linkage and a focused classic decision link", () => {
    expect(approvalPreview(approval)).toEqual({
      title: "Tool invoke",
      summary: "Review the exact request and its effects before deciding.",
      source: "Conversation",
      href: "/ops/approvals?approvalId=approval%2Fone%3Ftwo&shell=classic",
    });
  });

  it("uses a generated explanation when available, without making a decision", () => {
    expect(approvalPreview({
      ...approval,
      explanation: { summary: "Run a command", riskExplanation: "Changes files", generatedAt: approval.createdAt },
    }).summary).toBe("Run a command");
  });

  it("makes expired and unknown expiry states explicit", () => {
    const now = Date.parse("2026-09-28T18:00:00Z");
    expect(approvalExpiryLabel("2026-09-28T18:02:00Z", now)).toBe("Expires in 2 minutes");
    expect(approvalExpiryLabel("2026-09-28T17:59:00Z", now)).toBe("Expiry passed; verify its current status");
    expect(approvalExpiryLabel("invalid", now)).toBeNull();
    expect(approvalCreatedLabel("invalid")).toBe("Time unavailable");
  });
});

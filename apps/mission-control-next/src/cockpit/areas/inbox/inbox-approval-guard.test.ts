import { describe, expect, it } from "vitest";
import type { ApprovalRequest, OperatorInboxItem } from "@goatcitadel/contracts";
import { canResolveInboxApproval, matchesInboxApprovalDecision } from "./inbox-approval-guard";

const reviewed: ApprovalRequest = {
  approvalId: "approval-a",
  kind: "file.write",
  riskLevel: "caution",
  status: "pending",
  payload: {},
  preview: { path: "note.txt" },
  createdAt: "2026-09-28T00:00:00Z",
  explanationStatus: "pending",
  linkage: { workspaceId: "workspace-a" },
};
const item: OperatorInboxItem = {
  id: "approval:approval-a",
  kind: "approval",
  group: "needs_decision",
  title: "Review file write",
  summary: "Review",
  createdAt: reviewed.createdAt,
  source: { workspaceId: "workspace-a", approvalId: "approval-a" },
  href: "/ops/approvals",
};

describe("inbox approval guard", () => {
  it("accepts an unchanged pending record in the selected workspace", () => {
    expect(canResolveInboxApproval(item, reviewed, reviewed, "workspace-a")).toBe(true);
  });

  it("blocks a changed action, scope, risk, expired record, or missing page", () => {
    expect(
      canResolveInboxApproval(item, reviewed, { ...reviewed, preview: { path: "other.txt" } }, "workspace-a"),
    ).toBe(false);
    expect(
      canResolveInboxApproval(item, reviewed, { ...reviewed, payload: { path: "other.txt" } }, "workspace-a"),
    ).toBe(false);
    expect(canResolveInboxApproval(item, reviewed, { ...reviewed, riskLevel: "nuclear" }, "workspace-a")).toBe(false);
    expect(
      canResolveInboxApproval(item, reviewed, { ...reviewed, linkage: { workspaceId: "workspace-b" } }, "workspace-a"),
    ).toBe(false);
    expect(
      canResolveInboxApproval(
        item,
        reviewed,
        { ...reviewed, expiresAt: "2026-09-28T00:00:00Z" },
        "workspace-a",
        Date.parse("2026-09-28T00:00:01Z"),
      ),
    ).toBe(false);
    expect(canResolveInboxApproval(item, reviewed, undefined, "workspace-a")).toBe(false);
    expect(canResolveInboxApproval(item, reviewed, reviewed, "workspace-b")).toBe(false);
  });

  it("blocks changed linkage and review evidence even when the approval ID is unchanged", () => {
    expect(
      canResolveInboxApproval(
        item,
        reviewed,
        { ...reviewed, linkage: { ...reviewed.linkage, turnId: "other-turn" } },
        "workspace-a",
      ),
    ).toBe(false);
    expect(
      canResolveInboxApproval(item, reviewed, { ...reviewed, explanationStatus: "completed" }, "workspace-a"),
    ).toBe(false);
    expect(
      canResolveInboxApproval(item, reviewed, { ...reviewed, rollbackNote: "Cannot restore" }, "workspace-a"),
    ).toBe(false);
    expect(canResolveInboxApproval(item, { ...reviewed, status: "approved" }, reviewed, "workspace-a")).toBe(false);
  });

  it("compares canonical contents independent of JSON object key order", () => {
    const first = { ...reviewed, payload: { a: 1, b: 2 } };
    const second = { ...reviewed, payload: { b: 2, a: 1 } };
    expect(canResolveInboxApproval(item, first, second, "workspace-a")).toBe(true);
  });

  it("blocks specialized requests and unavailable expiry evidence", () => {
    for (const kind of ["remote_worker.native_runtime", "code_mode.run"]) {
      const record = { ...reviewed, kind };
      expect(canResolveInboxApproval(item, record, record, "workspace-a")).toBe(false);
    }
    const record = { ...reviewed, expiresAt: "unavailable" };
    expect(canResolveInboxApproval(item, record, record, "workspace-a")).toBe(false);
  });

  it("accepts resolution and follow-on progress only for the same bound action and decision", () => {
    const resolved: ApprovalRequest = {
      ...reviewed,
      status: "approved",
      resolvedAt: "2026-09-30T00:00:00Z",
      resolvedBy: "operator",
      resolutionOutcome: "approved",
      followUp: { status: "completed" },
      explanationStatus: "completed",
    };
    expect(matchesInboxApprovalDecision(item, reviewed, resolved, "workspace-a", "approve")).toBe(true);
    expect(matchesInboxApprovalDecision(item, reviewed, resolved, "workspace-a", "reject")).toBe(false);
    expect(
      matchesInboxApprovalDecision(
        item,
        reviewed,
        { ...resolved, linkage: { ...resolved.linkage, sessionId: "other" } },
        "workspace-a",
        "approve",
      ),
    ).toBe(false);
    expect(matchesInboxApprovalDecision(item, reviewed, undefined, "workspace-a", "approve")).toBe(false);
  });
});

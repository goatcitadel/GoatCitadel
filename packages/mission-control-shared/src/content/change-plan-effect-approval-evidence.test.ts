import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "./approval-helpers.js";

const HASH = "a".repeat(64);

/** A danger Change Plan's approval as the Gateway creates it: hash-bound payload, plain-words preview. */
const approval: ApprovalRequest = {
  approvalId: "approval-install-1",
  kind: "change_plan_effect",
  riskLevel: "danger",
  status: "pending",
  payload: {
    planId: "plan-1",
    kind: "connector_install",
    scope: "capability",
    targetOwnerId: "capability_connector_install",
    targetResourceId: "mcp_template:aws-knowledge",
    actionSnapshotHash: HASH,
  },
  preview: {
    title: "Install AWS Knowledge",
    summary: "Allow knowledge-mcp.global.api.aws. Save AWS Knowledge, switched off, set to Reading is free.",
    impact:
      "Any tool can reach an allowed host, not only this connector. After you approve, AWS Knowledge is saved " +
      "switched off, then Capabilities switches it on and connects it, unless you stop it.",
    risk: "danger",
  },
  linkage: { workspaceId: "default", actionType: "change_plan_effect" },
  createdAt: "2026-10-27T00:00:00.000Z",
  explanationStatus: "not_requested",
};

describe("change plan approval evidence (R91)", () => {
  it("lists a hash-bound plan's own lines as labelled targets with a once-only consequence", () => {
    const preview = approval.preview as Record<string, string>;
    expect(buildApprovalRequestReviewEvidenceModel(approval)).toEqual({
      targets: [`Change: ${preview.title}`, `What it does: ${preview.summary}`, `Impact: ${preview.impact}`],
      targetEntries: [
        { label: "Change", value: preview.title },
        { label: "What it does", value: preview.summary },
        { label: "Impact", value: preview.impact },
      ],
      commands: [],
      changes: [],
      supporting: [],
      consequence: "Approving applies this one change once, exactly as planned. Denying cancels it.",
    });
  });

  it("works for every plan kind, and leaves out an impact the plan doesn't have", () => {
    const settingsSave: ApprovalRequest = {
      ...approval,
      payload: { planId: "plan-2", kind: "runtime_configuration", actionSnapshotHash: HASH },
      preview: {
        title: "Turn on Apply my Settings and Capabilities changes without an Inbox approval",
        summary: "Saves you approving your own Settings changes in Inbox.",
        impact: "  ",
        risk: "danger",
      },
    };

    const model = buildApprovalRequestReviewEvidenceModel(settingsSave);

    expect(model?.targetEntries).toEqual([
      { label: "Change", value: "Turn on Apply my Settings and Capabilities changes without an Inbox approval" },
      { label: "What it does", value: "Saves you approving your own Settings changes in Inbox." },
    ]);
  });

  it.each([
    ["no plan id", { ...approval.payload, planId: undefined }, approval.preview],
    ["an empty plan id", { ...approval.payload, planId: " " }, approval.preview],
    ["no action hash", { ...approval.payload, actionSnapshotHash: undefined }, approval.preview],
    ["no title", approval.payload, { ...approval.preview, title: "" }],
    ["no summary", approval.payload, { ...approval.preview, summary: undefined }],
  ])("keeps today's refusal for a plan with %s", (_label, payload, preview) => {
    const model = buildApprovalRequestReviewEvidenceModel({ ...approval, payload, preview } as ApprovalRequest);

    // Today's generic model: nothing a reviewer could approve as an exact action.
    expect(model?.targets ?? []).toEqual([]);
    expect(model?.targetEntries ?? []).toEqual([]);
    expect(model?.consequence).toBeUndefined();
  });
});

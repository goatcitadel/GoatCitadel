import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "./approval-helpers.js";

/** The hash of the plan's request, as the Gateway stores it on the approval's payload (64 lowercase hex characters). */
const INTENT_HASH = "02b5bc0b0b2f9c55a65ec4328f8ba346706eb6273d0d8a227f121b35576d4e20";

/**
 * A danger Change Plan's approval as the Gateway really creates it: the payload carries the plan id and the hash of the
 * plan's request (intentHash) but never an action snapshot hash, and the preview is the plan's own plain words.
 */
const approval: ApprovalRequest = {
  approvalId: "approval-install-1",
  kind: "change_plan_effect",
  riskLevel: "danger",
  status: "pending",
  payload: {
    planId: "064ca5c1-eb4a-42e9-ae98-88ef5b9a367c",
    kind: "connector_install",
    scope: "capability",
    intentHash: INTENT_HASH,
    targetOwnerId: "capability_connector_install",
    targetResourceId: "mcp_template:aws-knowledge",
    adapterId: "connector-install",
    adapterVersion: 1,
    evidenceRefs: ["mcp_template:aws-knowledge"],
    rollbackRefs: [],
    rollbackNote: "Remove AWS Knowledge from Capabilities to undo this.",
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
  it("lists a plan's own lines as labelled targets, from the payload a real approval carries", () => {
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
      consequence: "Approving lets this one change apply once, exactly as planned. Denying cancels it.",
    });
  });

  it("lists the evidence for the payload captured from a real approval, which has no action snapshot hash", () => {
    const captured = JSON.parse(
      '{"planId":"064ca5c1-eb4a-42e9-ae98-88ef5b9a367c","kind":"connector_install","scope":"capability",' +
        '"intentHash":"02b5bc0b0b2f9c55a65ec4328f8ba346706eb6273d0d8a227f121b35576d4e20",' +
        '"targetOwnerId":"capability_connector_install","targetResourceId":"mcp_template:aws-knowledge",' +
        '"adapterId":"connector-install","adapterVersion":1,"evidenceRefs":["mcp_template:aws-knowledge"],' +
        '"rollbackRefs":[],"rollbackNote":"Remove it again from Capabilities."}',
    ) as Record<string, unknown>;
    expect(captured).not.toHaveProperty("actionSnapshotHash");

    const model = buildApprovalRequestReviewEvidenceModel({ ...approval, payload: captured });

    expect(model?.targetEntries?.map((entry) => entry.label)).toEqual(["Change", "What it does", "Impact"]);
    expect(model?.consequence).toBe(
      "Approving lets this one change apply once, exactly as planned. Denying cancels it.",
    );
  });

  it("works for every plan kind, and leaves out an impact the plan doesn't have", () => {
    const settingsSave: ApprovalRequest = {
      ...approval,
      payload: { planId: "plan-2", kind: "runtime_configuration", intentHash: INTENT_HASH },
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
    ["no request hash", { ...approval.payload, intentHash: undefined }, approval.preview],
    ["a request hash of 63 characters", { ...approval.payload, intentHash: "a".repeat(63) }, approval.preview],
    ["an upper-case request hash", { ...approval.payload, intentHash: "A".repeat(64) }, approval.preview],
    ["a request hash that isn't hex", { ...approval.payload, intentHash: "g".repeat(64) }, approval.preview],
    ["a request hash that isn't text", { ...approval.payload, intentHash: 12 }, approval.preview],
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

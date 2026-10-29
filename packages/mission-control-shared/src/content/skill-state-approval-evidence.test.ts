import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { buildApprovalRequestReviewEvidenceModel } from "./approval-helpers.js";

/**
 * A skill switch change as the Gateway really creates it (skill-state-service.ts): danger, linked to no workspace, the
 * binding and the stored request in the payload, and the preview the Gateway writes beside them.
 */
const approval: ApprovalRequest = {
  approvalId: "5f0b6d2e-6c1a-4d3e-9b7a-2f1e0c9d8b7a",
  kind: "skill.lifecycle",
  riskLevel: "danger",
  status: "pending",
  payload: {
    skillLifecycle: {
      schemaVersion: "goatcitadel.skill-lifecycle-approval.v1",
      scopeKind: "global",
      subjectKind: "skill",
      subjectId: "planner",
      action: "skill_state_set",
      requestSha256: "a".repeat(64),
      expectedStateSha256: "b".repeat(64),
    },
    request: {
      schemaVersion: "goatcitadel.skill-lifecycle-request.v1",
      requesterId: "operator",
      mutation: { skillId: "planner", state: "enabled", note: null },
    },
  },
  preview: {
    title: "Approve skill state change",
    action: "skill_state_set",
    skillId: "planner",
    state: "enabled",
    currentState: "disabled",
  },
  createdAt: "2026-10-29T10:00:00.000Z",
  explanationStatus: "not_requested",
};

const CONSEQUENCE =
  "Approving switches this one skill once, as listed, for every workspace. Denying leaves it as it is.";

interface StoredPayload {
  skillLifecycle: Record<string, unknown>;
  request?: { mutation: Record<string, unknown> };
}

/** The approval with a copy of its payload changed by `change`. */
function withPayload(change: (payload: StoredPayload) => void): ApprovalRequest {
  const payload = structuredClone(approval.payload) as unknown as StoredPayload;
  change(payload);
  return { ...approval, payload: payload as unknown as ApprovalRequest["payload"] };
}

describe("skill switch approval evidence", () => {
  it("lists the skill and its change from the request the approval stores, for the whole install", () => {
    expect(buildApprovalRequestReviewEvidenceModel(approval)).toEqual({
      targets: ["Skill: planner", "Now: Off", "Switch to: On"],
      targetEntries: [
        { label: "Skill", value: "planner" },
        { label: "Now", value: "Off" },
        { label: "Switch to", value: "On" },
      ],
      commands: [],
      changes: [],
      supporting: [],
      scopeSummary: "Every workspace on this install.",
      consequence: CONSEQUENCE,
    });
  });

  it("says Paused for a pause, and lists a note the change sets", () => {
    const pause = withPayload((payload) => {
      payload.request = { mutation: { skillId: "planner", state: "sleep", note: "Quiet for a week." } };
    });
    const model = buildApprovalRequestReviewEvidenceModel({
      ...pause,
      preview: { ...(approval.preview as object), state: "sleep", currentState: "enabled", note: "Quiet for a week." },
    });
    expect(model?.targetEntries).toEqual([
      { label: "Skill", value: "planner" },
      { label: "Now", value: "On" },
      { label: "Switch to", value: "Paused" },
      { label: "Note", value: "Quiet for a week." },
    ]);
  });

  it("leaves out a starting state the preview doesn't name", () => {
    const { currentState: _ignored, ...preview } = approval.preview as Record<string, unknown>;
    expect(buildApprovalRequestReviewEvidenceModel({ ...approval, preview })?.targets).toEqual([
      "Skill: planner",
      "Switch to: On",
    ]);
  });

  // Anything that doesn't agree, or isn't one skill's switch, offers nothing exact to approve.
  it.each<[string, ApprovalRequest]>([
    ["a binding for another skill", withPayload((payload) => (payload.skillLifecycle.subjectId = "writer"))],
    ["a bulk change", withPayload((payload) => (payload.skillLifecycle.action = "skill_state_bulk_set"))],
    ["a binding that isn't the install's", withPayload((payload) => (payload.skillLifecycle.scopeKind = "workspace"))],
    [
      "a state the switch doesn't have",
      {
        ...withPayload((payload) => (payload.request = { mutation: { skillId: "planner", state: "constructor" } })),
        preview: { ...(approval.preview as object), state: "constructor" },
      },
    ],
    ["no stored request", withPayload((payload) => delete payload.request)],
    ["a preview for another skill", { ...approval, preview: { ...(approval.preview as object), skillId: "writer" } }],
    ["a preview for another state", { ...approval, preview: { ...(approval.preview as object), state: "disabled" } }],
  ])("lists nothing exact for %s", (_what, record) => {
    const model = buildApprovalRequestReviewEvidenceModel(record);
    expect(model?.targets ?? []).toEqual([]);
    expect(model?.consequence).not.toBe(CONSEQUENCE);
  });

  it("leaves another kind's approval to its own model", () => {
    const model = buildApprovalRequestReviewEvidenceModel({ ...approval, kind: "file.write" });
    expect(model?.consequence).not.toBe(CONSEQUENCE);
  });
});

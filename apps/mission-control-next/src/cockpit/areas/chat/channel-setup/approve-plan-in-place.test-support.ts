import type { ApprovalRequest, ChangePlanRecord, ChangePlanRequiredAction } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

// Change, approval and error fixtures shared by the tests of the code that approves a change in place.

/** `satisfies` keeps each action its own kind, so a test may spread one and add what only that kind has. */
export const confirmation = {
  kind: "confirmation",
  actionId: "act-c",
  actionNonce: "nonce-c",
  title: "Confirm",
  confirmationText: "Go ahead",
} satisfies ChangePlanRequiredAction;
export const approvalAction = {
  kind: "approval",
  actionId: "act-a",
  actionNonce: "nonce-a",
  title: "Approve",
  risk: "caution",
  approvalId: "ap-1",
} satisfies ChangePlanRequiredAction;

export function plan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "p-1",
    origin: { surface: "settings", workspaceId: "w-1" },
    adapter: { adapterId: "channel_connection", version: 1 },
    kind: "channel_connection",
    scope: "channel",
    status: "awaiting_confirmation",
    phase: "confirmation",
    revision: 1,
    request: { kind: "channel_connection", channelKind: "channel.telegram", draftId: "d-1" },
    intentHash: "hash",
    target: { ownerId: "channel_setup_draft", resourceId: "d-1", expectedRevision: 4 },
    title: "Connect Telegram",
    summary: "Connect Telegram.",
    impact: "Turns on Telegram.",
    risk: "caution",
    approvalRefs: [],
    evidenceRefs: [],
    rollbackRefs: [],
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
    ...overrides,
  };
}

export function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "ap-1",
    kind: "change_plan_effect",
    riskLevel: "caution",
    status: "pending",
    payload: { planId: "p-1" },
    preview: {},
    createdAt: "2026-10-26T10:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}

export function httpError(status: number): ApiRequestError {
  return new ApiRequestError(`API error ${status}: {}`, { kind: "http", method: "POST", path: "/x", status });
}

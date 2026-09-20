import { describe, expect, it, vi } from "vitest";
import { buildApprovalEffectIdempotencyKey, type AsyncStorage } from "@goatcitadel/storage";
import type { ApprovalReplayEvent, ApprovalRequest } from "@goatcitadel/contracts";
import {
  hasApprovedToolCompletionEvidence,
  hasApprovedToolPreDispatchEvidence,
} from "./approved-tool-boundary-evidence.js";

const input = { approvalId: "approval-1", toolName: "mcp.invoke", auditEventId: "audit-1" };
const event: ApprovalReplayEvent = {
  eventId: "event-1",
  approvalId: input.approvalId,
  eventType: "approved_action_executed",
  actorId: "system",
  timestamp: "2026-09-09T00:00:00.000Z",
  payload: {
    toolName: input.toolName,
    auditEventId: input.auditEventId,
    sideEffectManaged: true,
    toolDispatchStarted: false,
    outcome: "blocked",
    externalRuntime: false,
    externalBoundaryState: "not_required",
  },
};
const storageWith = (events: ApprovalReplayEvent[]) =>
  ({
    approvalEvents: { listByApprovalId: vi.fn(async () => events) },
  }) as unknown as Pick<AsyncStorage, "approvalEvents">;

describe("approved tool boundary evidence", () => {
  it("accepts the exact durable pre-dispatch failure receipt", async () => {
    const storage = storageWith([event]);
    expect(await hasApprovedToolPreDispatchEvidence(storage, input)).toBe(true);
    expect(storage.approvalEvents.listByApprovalId).toHaveBeenCalledWith(input.approvalId);
  });

  it.each([
    [],
    [{ ...event, approvalId: "different-approval" }],
    [{ ...event, actorId: "operator" }],
    [{ ...event, payload: { ...event.payload, toolName: "shell.exec" } }],
    [{ ...event, payload: { ...event.payload, auditEventId: "different-attempt" } }],
    [{ ...event, payload: { ...event.payload, sideEffectManaged: false } }],
    [{ ...event, payload: { ...event.payload, toolDispatchStarted: true } }],
    [{ ...event, payload: { ...event.payload, toolDispatchStarted: undefined } }],
    [{ ...event, payload: { ...event.payload, outcome: "executed" } }],
    [{ ...event, payload: { ...event.payload, externalBoundaryState: "crossed" } }],
    [event, { ...event, eventId: "conflicting-event", payload: { ...event.payload, externalRuntime: true } }],
  ])("keeps missing, mismatched, and conflicting evidence uncertain: %j", async (...events) => {
    expect(await hasApprovedToolPreDispatchEvidence(storageWith(events), input)).toBe(false);
  });

  it("keeps an unavailable owner uncertain", async () => {
    const storage = storageWith([]);
    vi.mocked(storage.approvalEvents.listByApprovalId).mockRejectedValueOnce(new Error("unavailable"));
    expect(await hasApprovedToolPreDispatchEvidence(storage, input)).toBe(false);
  });
});

type CompletionInput = Parameters<typeof hasApprovedToolCompletionEvidence>[1];
function completionFixture() {
  const timestamp = "2026-09-09T00:00:00.000Z";
  const effect: CompletionInput["effect"] = {
    effectId: "effect-1",
    approvalId: input.approvalId,
    effectKind: "pending_action_execute",
    targetKind: "pending_action",
    targetId: input.approvalId,
    idempotencyKey: "",
    status: "running",
    attemptCount: 1,
    payload: {},
    result: {},
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  effect.idempotencyKey = buildApprovalEffectIdempotencyKey(effect);
  const actionRecord = {
    outcome: "executed",
    auditEventId: input.auditEventId,
    policyReason: "approved",
    result: { ok: true },
  };
  const pendingAction: CompletionInput["pendingAction"] = {
    approvalId: input.approvalId,
    actionType: "tool.invoke",
    createdAt: timestamp,
    request: {
      toolRunId: "tool-1",
      toolName: input.toolName,
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      args: { query: "fixture" },
    },
    resolutionStatus: "executed",
    resolvedAt: timestamp,
    result: structuredClone(actionRecord),
  };
  const approval: ApprovalRequest = {
    approvalId: input.approvalId,
    kind: "tool.invoke",
    status: "approved",
    riskLevel: "danger",
    payload: {},
    preview: {},
    createdAt: timestamp,
    explanationStatus: "not_requested",
    linkage: {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      toolName: input.toolName,
    },
  };
  const completion: CompletionInput = {
    effect,
    pendingAction,
    actionRecord,
    toolRun: {
      toolRunId: "tool-1",
      approvalId: input.approvalId,
      toolName: input.toolName,
      sessionId: "session-1",
      turnId: "turn-1",
      status: "approval_required",
      startedAt: timestamp,
    },
    inlineApproval: {
      approvalId: input.approvalId,
      toolName: input.toolName,
      sessionId: "session-1",
      turnId: "turn-1",
    },
  };
  const persisted = structuredClone(pendingAction);
  const completedEvent: ApprovalReplayEvent = {
    ...structuredClone(event),
    payload: { ...event.payload, outcome: "executed", externalRuntime: true, externalBoundaryState: "crossed" },
  };
  const events = [completedEvent];
  const storage = {
    pendingApprovalActions: { find: vi.fn(async () => persisted) },
    approvals: { get: vi.fn(async () => approval) },
    approvalEvents: { listByApprovalId: vi.fn(async () => events) },
  } as unknown as Parameters<typeof hasApprovedToolCompletionEvidence>[0];
  return { storage, completion, persisted, approval, events, completedEvent };
}

describe("approved tool completion evidence", () => {
  it.each(["not_required", "local_mutation", "crossed"])(
    "accepts matching canonical %s completion",
    async (boundary) => {
      const f = completionFixture();
      f.completedEvent.payload.externalBoundaryState = boundary;
      f.completedEvent.payload.externalRuntime = boundary === "crossed";
      expect(await hasApprovedToolCompletionEvidence(f.storage, f.completion)).toBe(true);
    },
  );

  it("accepts an already materialized result only when its result and finish time match", async () => {
    const f = completionFixture();
    Object.assign(f.completion.toolRun, {
      status: "executed",
      finishedAt: f.persisted.resolvedAt,
      result: { ok: true },
    });
    expect(await hasApprovedToolCompletionEvidence(f.storage, f.completion)).toBe(true);
    f.completion.toolRun.result = { ok: false };
    expect(await hasApprovedToolCompletionEvidence(f.storage, f.completion)).toBe(false);
  });

  const corruptions: Array<[string, (f: ReturnType<typeof completionFixture>) => void]> = [
    [
      "unclaimed effect",
      (f) => {
        f.completion.effect.status = "pending";
      },
    ],
    [
      "wrong effect idempotency",
      (f) => {
        f.completion.effect.idempotencyKey = "different";
      },
    ],
    [
      "different inline turn",
      (f) => {
        f.completion.inlineApproval.turnId = "different";
      },
    ],
    [
      "unresolved action",
      (f) => {
        f.persisted.resolutionStatus = "pending";
      },
    ],
    [
      "changed stored arguments",
      (f) => {
        f.persisted.request.args = { query: "different" };
      },
    ],
    [
      "changed stored result",
      (f) => {
        f.persisted.result = { ...f.persisted.result, result: { ok: false } };
      },
    ],
    [
      "revoked approval",
      (f) => {
        f.approval.status = "rejected";
      },
    ],
    [
      "different approval workspace",
      (f) => {
        f.approval.linkage!.workspaceId = "different";
      },
    ],
    [
      "missing owner event",
      (f) => {
        f.events.length = 0;
      },
    ],
    [
      "wrong event actor",
      (f) => {
        f.completedEvent.actorId = "operator";
      },
    ],
    [
      "different attempt receipt",
      (f) => {
        f.completedEvent.payload.auditEventId = "different";
      },
    ],
    [
      "unmanaged side effect",
      (f) => {
        f.completedEvent.payload.sideEffectManaged = false;
      },
    ],
    [
      "inconsistent boundary",
      (f) => {
        f.completedEvent.payload.externalRuntime = false;
      },
    ],
    [
      "ambiguous completion receipts",
      (f) => {
        f.events.push({ ...structuredClone(f.completedEvent), eventId: "duplicate" });
      },
    ],
    [
      "conflicting same-attempt receipt",
      (f) => {
        f.events.push({
          ...structuredClone(f.completedEvent),
          eventId: "conflict",
          payload: { ...f.completedEvent.payload, outcome: "blocked" },
        });
      },
    ],
  ];
  it.each(corruptions)("rejects %s", async (_label, corrupt) => {
    const f = completionFixture();
    corrupt(f);
    expect(await hasApprovedToolCompletionEvidence(f.storage, f.completion)).toBe(false);
  });

  it("does not turn a failed canonical read into completion", async () => {
    const f = completionFixture();
    vi.mocked(f.storage.approvalEvents.listByApprovalId).mockRejectedValueOnce(new Error("owner unavailable"));
    await expect(hasApprovedToolCompletionEvidence(f.storage, f.completion)).rejects.toThrow("owner unavailable");
  });
});

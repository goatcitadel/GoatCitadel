import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ApprovalReplayEvent } from "@goatcitadel/contracts";
import { hasApprovedToolPreDispatchEvidence } from "./approved-tool-boundary-evidence.js";

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

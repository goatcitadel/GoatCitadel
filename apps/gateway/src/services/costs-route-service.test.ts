import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { createCostsRoutePort } from "./costs-route-service.js";

function usageRecord(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "usage-1",
    workspaceId: "workspace-a",
    transportStatus: "dispatch_unknown",
    ...overrides,
  };
}

function createHarness(record = usageRecord()) {
  const modelUsageEvents = {
    list: vi.fn(() => ({ items: [], summary: { attemptCount: 0 } })),
    findByEventId: vi.fn(() => record),
    reconcileDispatchUnknown: vi.fn((_eventId, input) =>
      usageRecord({
        dispatchReconciliation: input.reconciliation,
        dispatchReconciliationEvidence: input.evidence,
        dispatchReconciledBy: input.reconciledBy,
        dispatchReconciledAt: input.reconciledAt,
      }),
    ),
  };
  const audit = { append: vi.fn(async () => undefined) };
  const port = createCostsRoutePort({ storage: { modelUsageEvents, audit } as unknown as Storage });
  return { port, modelUsageEvents, audit };
}

describe("costs route service model-usage authority", () => {
  it("forces the path workspace into canonical list queries", async () => {
    const { port, modelUsageEvents } = createHarness();
    await port.listModelUsageEvents("workspace-a", { sessionId: "session-a", limit: 20 });
    expect(modelUsageEvents.list).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      limit: 20,
    });
  });

  it("hides events owned by another workspace", async () => {
    const { port } = createHarness(usageRecord({ workspaceId: "workspace-b" }));
    await expect(port.getModelUsageEvent("workspace-a", "usage-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("persists actor/evidence and appends idempotent durable audit evidence", async () => {
    const { port, modelUsageEvents, audit } = createHarness();
    const result = await port.reconcileModelUsageDispatch({
      workspaceId: "workspace-a",
      eventId: "usage-1",
      reconciliation: "confirmed_not_dispatched",
      evidence: "Provider request log confirms no transport dispatch.",
      actorId: "operator-test",
    });

    expect(modelUsageEvents.reconcileDispatchUnknown).toHaveBeenCalledWith(
      "usage-1",
      expect.objectContaining({
        reconciliation: "confirmed_not_dispatched",
        evidence: "Provider request log confirms no transport dispatch.",
        reconciledBy: "operator-test",
        reconciledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      "approvals",
      expect.objectContaining({
        event: "model_usage.dispatch_unknown.reconciled",
        workspaceId: "workspace-a",
        eventId: "usage-1",
        reconciledBy: "operator-test",
      }),
      { deliveryId: "model-usage-reconciliation:usage-1" },
    );
    expect(result.dispatchReconciliation).toBe("confirmed_not_dispatched");
  });

  it("rejects secret-bearing reconciliation evidence before storage", async () => {
    const { port, modelUsageEvents } = createHarness();
    await expect(
      port.reconcileModelUsageDispatch({
        workspaceId: "workspace-a",
        eventId: "usage-1",
        reconciliation: "confirmed_not_dispatched",
        evidence: "Authorization: Bearer sk-test_abcdefghijklmnopqrstuvwxyz",
        actorId: "operator-test",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(modelUsageEvents.reconcileDispatchUnknown).not.toHaveBeenCalled();
  });

  it("rejects reconciliation of accepted attempts", async () => {
    const { port, modelUsageEvents } = createHarness(usageRecord({ transportStatus: "accepted" }));
    await expect(
      port.reconcileModelUsageDispatch({
        workspaceId: "workspace-a",
        eventId: "usage-1",
        reconciliation: "confirmed_not_dispatched",
        evidence: "Provider request log confirms no transport dispatch.",
        actorId: "operator-test",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(modelUsageEvents.reconcileDispatchUnknown).not.toHaveBeenCalled();
  });
});

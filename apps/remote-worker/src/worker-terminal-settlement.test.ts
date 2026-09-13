import { describe, expect, it, vi } from "vitest";
import { canonicalJsonString, remoteWorkerAssignmentSettlementReplayMaterial } from "@goatcitadel/contracts";
import { WorkerTerminalSettlement, type WorkerTerminalIntent } from "./worker-terminal-settlement.js";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import { WorkerSettlementGuard } from "./worker-settlement-guard.js";
import { sha256Utf8, type RouteContext, type settleAssignment } from "./connected-worker-routes.js";

const context = {} as RouteContext;
const intent: WorkerTerminalIntent = {
  lease: {
    registryWorkspaceId: "default",
    assignmentId: "assignment-one",
    assignmentGeneration: 1,
    leaseRevision: 2,
    leaseToken: "a".repeat(43),
  },
  finalEventSequence: 3,
  finalEventSha256: "b".repeat(64),
  settlement: { outcome: "completed", resultSha256: "c".repeat(64), outputManifestSha256: "d".repeat(64) },
  usageEventIds: ["canonical-provider-attempt"],
};
function sender() {
  return vi.fn<typeof settleAssignment>(async (_, lease, input) => ({
    status: 200,
    headers: {},
    body: {
      disposition: "settled",
      settlement: {
        registryWorkspaceId: lease.registryWorkspaceId,
        assignmentId: lease.assignmentId,
        assignmentGeneration: lease.assignmentGeneration,
        outcome: input.settlement.outcome,
        settledAt: "2026-09-09T12:00:00.000Z",
        requestSha256: sha256Utf8(
          canonicalJsonString(
            remoteWorkerAssignmentSettlementReplayMaterial({
              registryWorkspaceId: lease.registryWorkspaceId,
              assignmentId: lease.assignmentId,
              expectedAssignmentGeneration: lease.assignmentGeneration,
              expectedLeaseRevision: lease.leaseRevision,
              leaseTokenSha256: sha256Utf8(lease.leaseToken),
              ...(input.renewalLeaseToken === undefined
                ? {}
                : {
                    renewalLeaseTokenSha256: sha256Utf8(input.renewalLeaseToken),
                  }),
              origin: "worker",
              finalEventSequence: input.finalEventSequence,
              finalEventSha256: input.finalEventSha256,
              ...input.settlement,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
      },
    },
  }));
}

describe("worker terminal settlement recovery", () => {
  it("persists before sending and replays an uncertain response exactly across restart", async () => {
    const state = createInMemoryWorkerDurableState(),
      send = sender();
    send.mockImplementationOnce(async (_context, _lease, input) => {
      const pending = JSON.parse((await state.read("terminal-settlement-pending"))!);
      expect(pending.schemaVersion).toBe("goatcitadel.worker-terminal-settlement.v2");
      expect(input.renewalLeaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(pending.intent.renewalLeaseToken).toBe(input.renewalLeaseToken);
      throw new Error("lost response");
    });
    await expect(new WorkerTerminalSettlement(state, context, send).settle(intent)).rejects.toThrow("lost response");
    const receipt = await new WorkerTerminalSettlement(state, context, send).recover();
    expect(receipt).toMatchObject({ outcome: "completed", usageEventIds: intent.usageEventIds });
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect((await WorkerSettlementGuard.open(state)).getReceipt(intent.lease.assignmentId)).toEqual(receipt);
  });
  it("reuses the proposed renewal when settle is called again after an uncertain send", async () => {
    const state = createInMemoryWorkerDurableState(),
      send = sender();
    send.mockRejectedValueOnce(new Error("lost response"));
    const owner = new WorkerTerminalSettlement(state, context, send);
    await expect(owner.settle(intent)).rejects.toThrow("lost response");
    await owner.settle(intent);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });
  it("replays a retained v1 request without changing its authority bytes", async () => {
    const state = createInMemoryWorkerDurableState(),
      send = sender();
    await state.write(
      "terminal-settlement-pending",
      canonicalJsonString({
        schemaVersion: "goatcitadel.worker-terminal-settlement.v1",
        intent,
      }),
    );
    await new WorkerTerminalSettlement(state, context, send).recover();
    expect(send.mock.calls[0]?.[2]).not.toHaveProperty("renewalLeaseToken");
  });
  it("refuses a v2 intent without its retained renewal before dispatch", async () => {
    const state = createInMemoryWorkerDurableState(),
      send = sender();
    await state.write(
      "terminal-settlement-pending",
      canonicalJsonString({
        schemaVersion: "goatcitadel.worker-terminal-settlement.v2",
        intent,
      }),
    );
    await expect(new WorkerTerminalSettlement(state, context, send).recover()).rejects.toThrow("renewal is invalid");
    expect(send).not.toHaveBeenCalled();
  });
  it("closes cancellation without proposing another execution lease", async () => {
    const state = createInMemoryWorkerDurableState(),
      send = sender();
    const owner = new WorkerTerminalSettlement(state, context, send);
    await owner.settle({ ...intent, settlement: { outcome: "cancelled" }, usageEventIds: [] });
    expect(send.mock.calls[0]?.[2]).not.toHaveProperty("renewalLeaseToken");
    await new WorkerTerminalSettlement(state, context, send).recover();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch when saving the terminal intent fails", async () => {
    const state = createInMemoryWorkerDurableState(),
      send = sender();
    await expect(
      new WorkerTerminalSettlement(
        {
          ...state,
          write: async () => {
            throw new Error("disk full");
          },
        },
        context,
        send,
      ).settle(intent),
    ).rejects.toThrow("disk full");
    expect(send).not.toHaveBeenCalled();
  });
  it("replays after receipt persistence fails, but never sends again after the receipt is durable", async () => {
    const base = createInMemoryWorkerDurableState(),
      send = sender();
    const state = {
      ...base,
      write: vi.fn(async (key: string, value: string) => {
        if (key === "settlement-receipts") throw new Error("disk full");
        await base.write(key, value);
      }),
    };
    await expect(new WorkerTerminalSettlement(state, context, send).settle(intent)).rejects.toThrow("disk full");
    const owner = new WorkerTerminalSettlement(base, context, send);
    await owner.recover();
    expect(send).toHaveBeenCalledTimes(2);
    await new WorkerTerminalSettlement(base, context, send).recover();
    expect(send).toHaveBeenCalledTimes(2);
    await owner.acknowledge();
    expect(await owner.recover()).toBeUndefined();
  });
  it("rejects a conflicting pending result and an unrelated Gateway receipt", async () => {
    const state = createInMemoryWorkerDurableState(),
      send = sender();
    send.mockImplementationOnce(async () => {
      throw new Error("lost");
    });
    const owner = new WorkerTerminalSettlement(state, context, send);
    await expect(owner.settle(intent)).rejects.toThrow("lost");
    await expect(owner.settle({ ...intent, settlement: { outcome: "cancelled" } })).rejects.toThrow("conflicts");
    send.mockImplementationOnce(async () => ({
      status: 200,
      headers: {},
      body: { disposition: "settled", settlement: { requestSha256: "0".repeat(64) } },
    }));
    await expect(owner.recover()).rejects.toThrow("does not bind");
    expect((await WorkerSettlementGuard.open(state)).isSettled(intent.lease.assignmentId)).toBe(false);
  });
});

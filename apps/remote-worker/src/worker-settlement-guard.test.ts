import { describe, expect, it } from "vitest";
import { createInMemoryWorkerDurableState } from "./worker-durable-state.js";
import {
  WorkerSettlementConflictError,
  WorkerSettlementGuard,
  WorkerSettlementGuardError,
  type WorkerSettlementReceipt,
} from "./worker-settlement-guard.js";

function receipt(overrides: Partial<WorkerSettlementReceipt> = {}): WorkerSettlementReceipt {
  return {
    assignmentId: "assign-1",
    assignmentGeneration: 1,
    outcome: "completed",
    settlementSha256: "a".repeat(64),
    usageEventIds: ["usage-1", "usage-2"],
    settledAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("worker settlement guard", () => {
  it("records a terminal settlement once and is idempotent on byte-identical repeats", async () => {
    const state = createInMemoryWorkerDurableState();
    const guard = await WorkerSettlementGuard.open(state);
    expect(guard.isSettled("assign-1")).toBe(false);
    const first = await guard.recordSettlement(receipt());
    expect(first.firstTime).toBe(true);
    const second = await guard.recordSettlement(receipt());
    expect(second.firstTime).toBe(false);
    expect(second.receipt.usageEventIds).toEqual(["usage-1", "usage-2"]);
    expect(guard.isSettled("assign-1")).toBe(true);
  });

  it("rejects a conflicting second settlement (no duplicate accounting)", async () => {
    const guard = await WorkerSettlementGuard.open(createInMemoryWorkerDurableState());
    await guard.recordSettlement(receipt());
    await expect(guard.recordSettlement(receipt({ outcome: "failed" }))).rejects.toBeInstanceOf(
      WorkerSettlementConflictError,
    );
    await expect(
      guard.recordSettlement(receipt({ usageEventIds: ["usage-1", "usage-2", "usage-3"] })),
    ).rejects.toBeInstanceOf(WorkerSettlementConflictError);
  });

  it("does not re-settle after a restart", async () => {
    const state = createInMemoryWorkerDurableState();
    const first = await WorkerSettlementGuard.open(state);
    await first.recordSettlement(receipt());

    const restarted = await WorkerSettlementGuard.open(state);
    expect(restarted.isSettled("assign-1")).toBe(true);
    const repeat = await restarted.recordSettlement(receipt());
    expect(repeat.firstTime).toBe(false);
    expect(restarted.getReceipt("assign-1")?.settlementSha256).toBe("a".repeat(64));
  });

  it("rejects malformed receipts", async () => {
    const guard = await WorkerSettlementGuard.open(createInMemoryWorkerDurableState());
    await expect(
      guard.recordSettlement(receipt({ outcome: "weird" as WorkerSettlementReceipt["outcome"] })),
    ).rejects.toBeInstanceOf(WorkerSettlementGuardError);
    await expect(guard.recordSettlement(receipt({ usageEventIds: [] as unknown as string[] }))).resolves.toBeDefined();
    await expect(
      guard.recordSettlement(receipt({ assignmentId: "assign-2", settlementSha256: "nope" })),
    ).rejects.toBeInstanceOf(WorkerSettlementGuardError);
  });
});

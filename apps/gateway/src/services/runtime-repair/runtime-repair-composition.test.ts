import { describe, expect, it, vi } from "vitest";
import { NotFoundError, RUNTIME_REPAIR_AUDIT_STREAM } from "@goatcitadel/contracts";
import {
  RUNTIME_REPAIR_SWEEP_BOOT_DELAY_MS,
  RUNTIME_REPAIR_SWEEP_INTERVAL_MS,
  createRuntimeRepairAuditPort,
  createRuntimeRepairReadPort,
  createRuntimeRepairsRuntime,
  type RuntimeRepairStorageView,
} from "./runtime-repair-composition.js";

function storage(overrides: Partial<RuntimeRepairStorageView["approvals"]> = {}): RuntimeRepairStorageView {
  return {
    durableRuns: {
      listRunIdsByStatus: vi.fn(() => ["run-1"]),
      getRunsByIds: vi.fn(() => new Map()),
      listDeadLetters: vi.fn(() => []),
      listRuns: vi.fn(() => []),
    },
    approvals: {
      get: vi.fn(() => {
        throw new NotFoundError({ entity: "Approval", id: "approval-1" });
      }),
      list: vi.fn(() => []),
      listExpiredPending: vi.fn(() => []),
      ...overrides,
    },
    audit: {
      append: vi.fn(async () => undefined),
      listRecent: vi.fn(async () => []),
    },
  };
}

describe("runtime repair composition", () => {
  it("reports a missing approval as null", async () => {
    await expect(createRuntimeRepairReadPort(storage()).getApproval("approval-1")).resolves.toBeNull();
  });

  it("passes any other approval read failure through, so the sweep marks the source unreadable", async () => {
    const failing = storage({
      get: vi.fn(() => {
        throw new Error("database unavailable");
      }),
    });
    await expect(createRuntimeRepairReadPort(failing).getApproval("approval-1")).rejects.toThrow(
      "database unavailable",
    );
  });

  it("reads only waiting runs and only pending approvals", async () => {
    const view = storage();
    const reads = createRuntimeRepairReadPort(view);
    await reads.listWaitingRunIds(10);
    await reads.listPendingApprovals(20);
    expect(view.durableRuns.listRunIdsByStatus).toHaveBeenCalledWith("waiting", 10);
    expect(view.approvals.list).toHaveBeenCalledWith("pending", 20);
  });

  it("throttles maintenance-tick calls to the sweep cadence, starting after the boot delay", async () => {
    const view = storage();
    let nowMs = 1_000_000;
    const runAdmitted = vi.fn(async (_label: string, work: () => Promise<void>) => await work());
    const runtime = createRuntimeRepairsRuntime({ storage: view, runAdmitted, now: () => nowMs });

    await runtime.runIfDue();
    expect(runAdmitted).not.toHaveBeenCalled();

    nowMs += RUNTIME_REPAIR_SWEEP_BOOT_DELAY_MS;
    await runtime.runIfDue();
    await runtime.runIfDue();
    expect(runAdmitted).toHaveBeenCalledTimes(1);
    expect(runAdmitted).toHaveBeenCalledWith("runtime-repair-sweep", expect.any(Function));
    expect(runtime.snapshot().ready).toBe(true);

    nowMs += RUNTIME_REPAIR_SWEEP_INTERVAL_MS;
    await runtime.runIfDue();
    expect(runAdmitted).toHaveBeenCalledTimes(2);
  });

  it("stays not-ready when this Gateway is not admitted to cron work", async () => {
    let nowMs = 0;
    const runtime = createRuntimeRepairsRuntime({
      storage: storage(),
      runAdmitted: vi.fn(async () => undefined),
      now: () => nowMs,
    });
    nowMs += RUNTIME_REPAIR_SWEEP_BOOT_DELAY_MS;
    await runtime.runIfDue();
    expect(runtime.snapshot().ready).toBe(false);
  });

  it("never throws into the maintenance tick", async () => {
    let nowMs = 0;
    const runtime = createRuntimeRepairsRuntime({
      storage: storage(),
      runAdmitted: vi.fn(async () => {
        throw new Error("admission failed");
      }),
      now: () => nowMs,
    });
    nowMs += RUNTIME_REPAIR_SWEEP_BOOT_DELAY_MS;
    await expect(runtime.runIfDue()).resolves.toBeUndefined();
  });

  it("writes and reads only the runtime repair audit stream", async () => {
    const view = storage();
    const audit = createRuntimeRepairAuditPort(view);
    await audit.append({ event: "finding_observed" });
    await audit.listRecent(5);
    expect(view.audit.append).toHaveBeenCalledWith(RUNTIME_REPAIR_AUDIT_STREAM, { event: "finding_observed" });
    expect(view.audit.listRecent).toHaveBeenCalledWith(RUNTIME_REPAIR_AUDIT_STREAM, 5);
  });
});

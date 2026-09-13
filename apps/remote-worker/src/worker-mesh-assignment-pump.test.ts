import { describe, expect, it, vi } from "vitest";
import { withWorkerMeshAssignmentPump } from "./worker-mesh-assignment-pump.js";
import type { WorkerMeshCapabilityCycleResult } from "./worker-mesh-capability-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settled = (unknown = false): WorkerMeshCapabilityCycleResult => ({
  status: "settled", recovered: false, manualReconciliationRequired: unknown,
  receipt: { invocationId: "invocation-a", envelopeSha256: "1".repeat(64),
    disposition: unknown ? "unknown" : "succeeded", settlementSha256: "2".repeat(64),
    requestSha256: "3".repeat(64), settledAt: "2026-09-11T00:00:00.000Z" },
});
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", () => resolve(), { once: true });
});

describe("mesh work alongside connected assignments", () => {
  it("services a mesh request created by an assignment that is waiting for that same worker", async () => {
    const dispatched = deferred<void>();
    const result = deferred<string>();
    const onSettlement = vi.fn(() => result.resolve("canonical tool result"));
    let polling = 0;
    const value = await withWorkerMeshAssignmentPump({
      assignment: async () => { dispatched.resolve(); return result.promise; },
      mesh: async () => {
        await dispatched.promise;
        if (++polling === 1) return { status: "idle" };
        return settled();
      },
      onSettlement,
      wait: async () => undefined,
    });
    expect(value).toBe("canonical tool result");
    expect(onSettlement).toHaveBeenCalled();
    expect(polling).toBeGreaterThanOrEqual(2);
  });

  it("starts assignment work under a busy mesh queue and drains the current effect before returning", async () => {
    const entered = deferred<void>();
    const effect = deferred<WorkerMeshCapabilityCycleResult>();
    const assignmentDone = deferred<void>();
    const assignment = vi.fn(async () => { await entered.promise; assignmentDone.resolve(); return "Chat completed"; });
    const mesh = vi.fn(async () => { entered.resolve(); return effect.promise; });
    let returned = false;
    const run = withWorkerMeshAssignmentPump({ assignment, mesh, onSettlement: vi.fn() }).then((value) => { returned = true; return value; });
    await assignmentDone.promise;
    expect(assignment).toHaveBeenCalledTimes(1);
    expect(returned).toBe(false);
    effect.resolve(settled());
    expect(await run).toBe("Chat completed");
    expect(mesh).toHaveBeenCalledTimes(1);
  });

  it("wakes an idle mesh poll when the assignment finishes", async () => {
    const sleeping = deferred<void>();
    const finished = deferred<string>();
    const mesh = vi.fn(async (): Promise<WorkerMeshCapabilityCycleResult> => ({ status: "idle" }));
    await expect(withWorkerMeshAssignmentPump({
      assignment: async () => { await sleeping.promise; finished.resolve("done"); return finished.promise; },
      mesh, onSettlement: vi.fn(),
      wait: async (signal) => { sleeping.resolve(); await aborted(signal); throw new Error("poll sleep stopped"); },
    })).resolves.toBe("done");
    expect(mesh).toHaveBeenCalledTimes(1);
  });

  it("cancels and drains assignment I/O after mesh transport failure", async () => {
    const cancelled = deferred<void>();
    const cleaned = deferred<void>();
    let returned = false;
    const run = withWorkerMeshAssignmentPump({
      assignment: async (signal) => { await aborted(signal); cancelled.resolve(); await cleaned.promise; return "cancelled"; },
      mesh: async () => { throw new Error("mesh transport failed"); }, onSettlement: vi.fn(),
    }).catch((error: unknown) => { returned = true; throw error; });
    const proof = expect(run).rejects.toThrow("mesh transport failed");
    await cancelled.promise;
    expect(returned).toBe(false);
    cleaned.resolve();
    await proof;
  });

  it("cancels and drains destination work after an assignment failure", async () => {
    const entered = deferred<void>();
    const cleanup = deferred<void>();
    const onSettlement = vi.fn();
    await expect(withWorkerMeshAssignmentPump({
      assignment: async () => { await entered.promise; throw new Error("assignment failed"); },
      mesh: async (signal) => { entered.resolve(); await aborted(signal); cleanup.resolve(); throw new Error("mesh cancelled"); },
      onSettlement,
    })).rejects.toThrow("assignment failed");
    await cleanup.promise;
    expect(onSettlement).not.toHaveBeenCalled();
  });

  it("propagates shutdown into both owners and awaits their exit", async () => {
    const stop = new AbortController();
    const entered = deferred<void>();
    const exited: string[] = [];
    const run = withWorkerMeshAssignmentPump({ signal: stop.signal,
      assignment: async (signal) => { await entered.promise; stop.abort(); await aborted(signal); exited.push("assignment"); return "cancelled"; },
      mesh: async (signal) => { entered.resolve(); await aborted(signal); exited.push("mesh"); throw new Error("mesh stopped"); },
      onSettlement: vi.fn(),
    });
    await expect(run).rejects.toThrow();
    expect(exited.sort()).toEqual(["assignment", "mesh"]);
  });

  it("stops the assignment when a destination outcome needs reconciliation", async () => {
    const onSettlement = vi.fn();
    const mesh = vi.fn(async () => settled(true));
    await expect(withWorkerMeshAssignmentPump({
      assignment: async (signal) => { await aborted(signal); return "cancelled"; }, mesh, onSettlement,
    })).rejects.toThrow("reconciliation");
    expect(onSettlement).toHaveBeenCalledWith(settled(true));
    expect(mesh).toHaveBeenCalledTimes(1);
  });

  it("does not start either owner after cancellation", async () => {
    const stop = new AbortController(); stop.abort();
    const assignment = vi.fn(); const mesh = vi.fn();
    await expect(withWorkerMeshAssignmentPump({ signal: stop.signal, assignment, mesh, onSettlement: vi.fn() })).rejects.toThrow();
    expect(assignment).not.toHaveBeenCalled(); expect(mesh).not.toHaveBeenCalled();
  });

  it("does not continue after settlement-report failure", async () => {
    await expect(withWorkerMeshAssignmentPump({
      assignment: async (signal) => { await aborted(signal); return "cancelled"; },
      mesh: async () => settled(), onSettlement: () => { throw new Error("report failed"); },
    })).rejects.toThrow("report failed");
  });
});

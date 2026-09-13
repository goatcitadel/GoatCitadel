import { afterEach, describe, expect, it, vi } from "vitest";
import { withRenewingWorkerLease } from "./worker-execution-lease.js";
import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";

const lease: LeaseBinding = {
  registryWorkspaceId: "registry",
  assignmentId: "assignment",
  assignmentGeneration: 1,
  leaseRevision: 1,
  leaseToken: "a".repeat(43),
};
const context = {} as RouteContext;
const readControl = vi.fn(async (_context: RouteContext, current: LeaseBinding) => ({
  status: 200,
  body: {
    disposition: "active",
    assignmentId: current.assignmentId,
    assignmentGeneration: current.assignmentGeneration,
    lease: current,
  },
}));
function input() {
  let deadline = 0;
  const owner = {
    renew: vi.fn(async (current: LeaseBinding) => {
      deadline = Date.now() + 900;
      return { ...current, leaseRevision: current.leaseRevision + 1, leaseToken: "b".repeat(43) };
    }),
    remainingLeaseMs: () => Math.max(0, deadline - Date.now()),
  };
  return { owner, context, lease, workerSentThrough: 7, observed: {}, readControl };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("worker execution lease", () => {
  it("renews before inference and maintains one serial heartbeat while work waits", async () => {
    vi.useFakeTimers();
    const values = input();
    let finish: (value: string) => void = () => {};
    const execute = vi.fn(async (current: LeaseBinding, signal: AbortSignal) => {
      expect(current.leaseRevision).toBe(2);
      expect(signal.aborted).toBe(false);
      return await new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const run = withRenewingWorkerLease(values, execute);
    await vi.advanceTimersByTimeAsync(950);
    expect(values.owner.renew).toHaveBeenCalledTimes(4);
    expect(values.owner.renew.mock.calls.map((call) => call[0].leaseRevision)).toEqual([1, 2, 3, 4]);
    finish("actual output");
    expect(await run).toMatchObject({ lease: { leaseRevision: 6 }, value: "actual output" });
    expect(values.owner.renew).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains an in-flight secret rotation before returning the lease used by later transcript writes", async () => {
    vi.useFakeTimers();
    const values = input();
    let finishWork: (value: string) => void = () => {};
    let finishRenewal: (value: LeaseBinding) => void = () => {};
    values.owner.renew.mockImplementationOnce(async (current) => ({ ...current, leaseRevision: 2 }));
    values.owner.remainingLeaseMs = () => 900;
    values.owner.renew.mockImplementationOnce(
      async () =>
        await new Promise<LeaseBinding>((resolve) => {
          finishRenewal = resolve;
        }),
    );
    let returned = false;
    const run = withRenewingWorkerLease(
      values,
      async () =>
        await new Promise<string>((resolve) => {
          finishWork = resolve;
        }),
    );
    void run.then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(300);
    finishWork("output");
    await vi.advanceTimersByTimeAsync(0);
    expect(returned).toBe(false);
    finishRenewal({ ...lease, leaseRevision: 3, leaseToken: "c".repeat(43) });
    expect(await run).toMatchObject({ lease: { leaseRevision: 4, leaseToken: "b".repeat(43) } });
    expect(values.owner.renew.mock.calls[2]?.[0]).toMatchObject({ leaseRevision: 3, leaseToken: "c".repeat(43) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses cancellation, cross-assignment control, and missing timing before provider execution", async () => {
    for (const mode of ["cancelled", "mismatched", "missing_time"]) {
      const values = input();
      values.readControl = vi.fn(async (_context, current) => ({
        status: 200,
        body: {
          disposition: mode === "cancelled" ? "cancel_requested" : "active",
          assignmentId: mode === "mismatched" ? "other" : current.assignmentId,
          assignmentGeneration: current.assignmentGeneration,
          lease: current,
        },
      }));
      if (mode === "missing_time") values.owner.remainingLeaseMs = () => 0;
      const execute = vi.fn();
      await expect(withRenewingWorkerLease(values, execute)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("does not publish completed output when the final authority refresh fails", async () => {
    const values = input();
    values.owner.renew.mockImplementationOnce(async current => ({ ...current, leaseRevision: 2 }));
    values.owner.remainingLeaseMs = () => 900;
    values.owner.renew.mockRejectedValueOnce(new Error("final refresh unavailable"));
    await expect(withRenewingWorkerLease(values, async () => "completed output")).rejects.toThrow("final refresh unavailable");
  });

  it("aborts pending execution on an ambiguous renewal, retains its error, and never retries work", async () => {
    vi.useFakeTimers();
    const values = input();
    values.owner.renew.mockImplementationOnce(async (current) => ({ ...current, leaseRevision: 2 }));
    values.owner.remainingLeaseMs = () => 900;
    values.owner.renew.mockRejectedValueOnce(new Error("lost renewal response"));
    const execute = vi.fn(
      async (_current: LeaseBinding, signal: AbortSignal) =>
        await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("execution aborted")), { once: true });
        }),
    );
    const run = withRenewingWorkerLease(values, execute);
    const rejected = expect(run).rejects.toThrow("execution aborted");
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(values.owner.renew).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

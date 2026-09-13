import { describe, expect, it, vi } from "vitest";
import type { LeaseBinding, RouteContext, readControl } from "./connected-worker-routes.js";
import { renewWorkerLeaseControl } from "./worker-lease-control.js";
import { withRenewingWorkerLease } from "./worker-execution-lease.js";
import { WorkerProtectedRouteError } from "./worker-protected-route-client.js";

const rejected = () => new WorkerProtectedRouteError("Control rejected", 403, { error: "REMOTE_WORKER_ASSIGNMENT_REJECTED" });
function fixture() {
  const lease: LeaseBinding = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1,
    leaseRevision: 1, leaseToken: "a".repeat(43) };
  const owner = {
    renew: vi.fn(async (current: LeaseBinding) => ({ ...current, leaseRevision: current.leaseRevision + 1,
      leaseToken: String(current.leaseRevision + 1).padStart(43, "b") })),
    remainingLeaseMs: () => 900,
  };
  const control = vi.fn<typeof readControl>(async (_context, current) => ({ status: 200,
    body: { assignmentId: current.assignmentId, assignmentGeneration: current.assignmentGeneration,
      disposition: "active", lease: { ...current } } }));
  return { context: {} as RouteContext, owner, lease, workerSentThrough: 7, observed: {} as Record<string, unknown>, readControl: control };
}

describe("worker lease and control refresh", () => {
  it("renews from the retained rotated secret after a raced control rejection", async () => {
    const h = fixture();
    h.readControl.mockRejectedValueOnce(rejected());
    const result = await renewWorkerLeaseControl(h);
    expect(result.lease.leaseRevision).toBe(3);
    expect(h.owner.renew.mock.calls[1]?.[0]).toEqual(await h.owner.renew.mock.results[0]!.value);
    expect(h.readControl.mock.calls.map((call) => call[1].leaseRevision)).toEqual([2, 3]);
    expect(new Set(h.readControl.mock.calls.map((call) => call[2])).size).toBe(2);
    expect(h.observed.leaseControlRefreshes).toBe(1);
  });

  it("bounds persistent control rejection and never enters execution", async () => {
    const h = fixture();
    h.readControl.mockRejectedValue(rejected());
    const execute = vi.fn();
    await expect(withRenewingWorkerLease(h, execute)).rejects.toThrow("Control rejected");
    expect(h.owner.renew).toHaveBeenCalledTimes(3);
    expect(h.readControl).toHaveBeenCalledTimes(3);
    expect(h.observed.leaseControlRefreshes).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not repeat an ambiguous renewal or bypass revoked authority", async () => {
    const h = fixture();
    h.readControl.mockRejectedValueOnce(rejected());
    const renew = h.owner.renew.getMockImplementation()!;
    h.owner.renew.mockImplementationOnce(renew).mockRejectedValueOnce(new Error("Renewal authority revoked or response uncertain"));
    const execute = vi.fn();
    await expect(withRenewingWorkerLease(h, execute)).rejects.toThrow("Renewal authority revoked or response uncertain");
    expect(h.owner.renew).toHaveBeenCalledTimes(2);
    expect(h.readControl).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    new Error("unclassified read failure"),
    new WorkerProtectedRouteError("different status", 500, { error: "REMOTE_WORKER_ASSIGNMENT_REJECTED" }),
    new WorkerProtectedRouteError("different owner", 403, { error: "OTHER_REJECTION" }),
    new WorkerProtectedRouteError("unexpected details", 403, { error: "REMOTE_WORKER_ASSIGNMENT_REJECTED", extra: true }),
  ])("does not refresh for $message", async (error) => {
    const h = fixture();
    h.readControl.mockRejectedValueOnce(error);
    await expect(renewWorkerLeaseControl(h)).rejects.toBe(error);
    expect(h.owner.renew).toHaveBeenCalledOnce();
    expect(h.observed.leaseControlRefreshes).toBeUndefined();
  });

  it.each(["assignment", "revision", "disposition"] as const)("rejects a mismatched %s receipt without refreshing", async (field) => {
    const h = fixture();
    const read = h.readControl.getMockImplementation()!;
    h.readControl.mockImplementationOnce(async (...args) => {
      const response = await read(...args);
      return { ...response, body: { ...response.body,
        ...(field === "assignment" ? { assignmentId: "another-assignment" } : {}),
        ...(field === "disposition" ? { disposition: "unknown" } : {}),
        ...(field === "revision" ? { lease: { ...(response.body.lease as Record<string, unknown>), leaseRevision: 99 } } : {}),
      } };
    });
    await expect(renewWorkerLeaseControl(h)).rejects.toThrow();
    expect(h.owner.renew).toHaveBeenCalledOnce();
    expect(h.observed.leaseControlRefreshes).toBeUndefined();
  });

  it("preserves cancellation for terminal settlement and prevents new execution", async () => {
    const h = fixture();
    const read = h.readControl.getMockImplementation()!;
    h.readControl.mockImplementation(async (...args) => {
      const response = await read(...args);
      return { ...response, body: { ...response.body, disposition: "cancel_requested" } };
    });
    await expect(renewWorkerLeaseControl(h)).resolves.toMatchObject({ control: { body: { disposition: "cancel_requested" } } });
    const execute = vi.fn();
    await expect(withRenewingWorkerLease(h, execute)).rejects.toThrow("cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refreshes the final control fence without repeating completed work", async () => {
    const h = fixture();
    const read = h.readControl.getMockImplementation()!;
    h.readControl.mockImplementationOnce(read).mockRejectedValueOnce(rejected());
    const execute = vi.fn(async () => "one result");
    await expect(withRenewingWorkerLease(h, execute)).resolves.toMatchObject({ lease: { leaseRevision: 4 }, value: "one result" });
    expect(execute).toHaveBeenCalledOnce();
    expect(h.owner.renew).toHaveBeenCalledTimes(3);
    expect(h.observed.leaseControlRefreshes).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableRunService, DurableWorkerInterruptionError } from "./durable-run-service.js";

type HeartbeatHarness = {
  executeWithLeaseHeartbeat: <T>(
    run: Record<string, unknown>,
    execute: (context: { signal: AbortSignal; controller: AbortController }) => Promise<T>,
  ) => Promise<T>;
  renewLeaseWithDatabaseClock: () => Promise<boolean>;
  recordEventLoopLag: () => Promise<void>;
};

function buildHarness(getRun: () => unknown): HeartbeatHarness {
  const run = { runId: "run-1", status: "running", leaseOwnerId: "worker-1", version: 1 };
  const service = new DurableRunService({
    storage: { durableRuns: { getRun: async () => getRun() ?? run } },
  } as never);
  const harness = service as unknown as HeartbeatHarness;
  harness.renewLeaseWithDatabaseClock = async () => true;
  return harness;
}

const run = { runId: "run-1", status: "running", leaseOwnerId: "worker-1", version: 1 };

describe("durable lease heartbeat fail-closed behaviour", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tolerates a throwing event-loop-lag recorder and keeps renewing the lease", async () => {
    vi.useFakeTimers();
    const harness = buildHarness(() => run);
    harness.recordEventLoopLag = async () => {
      throw new Error("diagnostics down");
    };
    const renew = vi.spyOn(harness, "renewLeaseWithDatabaseClock");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = harness.executeWithLeaseHeartbeat(run, async () => {
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        return "done";
      });
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(result).resolves.toBe("done");
      expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("aborts the run instead of leaking an unhandled rejection when the heartbeat itself throws", async () => {
    vi.useFakeTimers();
    const harness = buildHarness(() => run);
    harness.recordEventLoopLag = async () => undefined;
    // First renewal (before execution) succeeds; every heartbeat renewal then fails until tolerance is
    // exhausted, and the lease-revocation cleanup itself throws - the old code leaked that rejection.
    let renewals = 0;
    harness.renewLeaseWithDatabaseClock = async () => {
      renewals += 1;
      if (renewals > 1) {
        throw new Error("renewal failed");
      }
      return true;
    };
    (harness as unknown as { revokeActiveExecutionLease: () => Promise<void> }).revokeActiveExecutionLease =
      async () => {
        throw new Error("revoke exploded");
      };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = harness.executeWithLeaseHeartbeat(run, async ({ signal }) => {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      });
      const settled = result.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await settled).toBeInstanceOf(DurableWorkerInterruptionError);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

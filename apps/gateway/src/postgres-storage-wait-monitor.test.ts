import { describe, expect, it, vi } from "vitest";
import { PostgresStorageWaitMonitor } from "./postgres-storage-wait-monitor.js";

describe("PostgresStorageWaitMonitor", () => {
  it("keeps rolling wait metrics and emits rate-limited slow and critical diagnostics", () => {
    let now = 1_000_000;
    const recordDiagnostic = vi.fn();
    const monitor = new PostgresStorageWaitMonitor({ now: () => now, recordDiagnostic });
    const wait = (durationMs: number) =>
      monitor.observe({
        operationKind: "query:one",
        transactionPosture: "active",
        sessionPosture: "pinned",
        outcome: "completed",
        durationMs,
      });

    wait(20);
    wait(300);
    wait(600);
    wait(2_100);

    expect(recordDiagnostic).toHaveBeenCalledTimes(2);
    expect(recordDiagnostic.mock.calls[0]?.[0]).toMatchObject({
      level: "warn",
      event: "postgres_sync_wait_slow",
      durationMs: 300,
    });
    expect(recordDiagnostic.mock.calls[1]?.[0]).toMatchObject({
      level: "error",
      event: "postgres_sync_wait_critical",
      durationMs: 2_100,
      context: {
        operationKind: "query:one",
        transactionPosture: "active",
        sessionPosture: "pinned",
        rollingCount: 4,
        rollingP95Ms: 2_100,
        rollingMaxMs: 2_100,
      },
    });
    expect(monitor.snapshot()).toMatchObject({
      windowMs: 300_000,
      count: 4,
      slowCount: 3,
      criticalCount: 1,
      p95Ms: 2_100,
      maxMs: 2_100,
    });

    now += 300_001;
    expect(monitor.snapshot()).toMatchObject({ count: 0, p95Ms: 0, maxMs: 0 });
  });
});

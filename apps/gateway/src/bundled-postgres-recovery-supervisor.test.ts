import { describe, expect, it, vi } from "vitest";
import { BundledPostgresRecoverySupervisor } from "./bundled-postgres-recovery-supervisor.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("BundledPostgresRecoverySupervisor", () => {
  it("leaves a healthy bundled Postgres runtime alone", async () => {
    const logger = createLogger();
    const getHealth = vi.fn(async () => ({ reachable: true }));
    const recover = vi.fn(async () => {});
    const supervisor = new BundledPostgresRecoverySupervisor({ getHealth, recover, logger });

    await supervisor.checkNow();

    expect(recover).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("repairs an unreachable bundled Postgres runtime and verifies readiness", async () => {
    const logger = createLogger();
    const getHealth = vi
      .fn<() => Promise<{ reachable: boolean }>>()
      .mockResolvedValueOnce({ reachable: false })
      .mockResolvedValueOnce({ reachable: true });
    const recover = vi.fn(async () => {});
    const supervisor = new BundledPostgresRecoverySupervisor({ getHealth, recover, logger });

    await supervisor.checkNow();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(getHealth).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: "database health check reported unreachable" },
      "bundled Postgres is unavailable; starting automatic recovery",
    );
    expect(logger.info).toHaveBeenCalledWith({}, "bundled Postgres automatic recovery completed");
  });

  it("backs off after a failed repair and stops scheduling when closed", async () => {
    vi.useFakeTimers();
    try {
      const logger = createLogger();
      const getHealth = vi.fn(async () => ({ reachable: false }));
      const recover = vi.fn(async () => {
        throw new Error("Docker Desktop is unavailable");
      });
      const supervisor = new BundledPostgresRecoverySupervisor({
        getHealth,
        recover,
        logger,
        probeIntervalMs: 10,
        maxRetryDelayMs: 40,
      });

      supervisor.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ attempt: 1, retryDelayMs: 10, error: "Docker Desktop is unavailable" }),
        "bundled Postgres automatic recovery failed; retrying",
      );

      await supervisor.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(recover).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

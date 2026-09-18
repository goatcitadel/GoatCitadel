import { describe, expect, it, vi } from "vitest";
import type { ConnectedWorkerConfig } from "./worker-runtime-config.js";
import type { ConnectedWorkerReport } from "./connected-worker-runtime.js";
import { runWorkerProcess } from "./worker-process-runtime.js";

const config = { runId: "process-fixture", stopAfter: "complete", runMode: "continuous" } as ConnectedWorkerConfig;
const report = (outcome: "completed" | "stopped", awaiting?: string): ConnectedWorkerReport => ({
  runId: config.runId,
  outcome,
  awaiting,
  stagesCompleted: [],
  admitted: "retained_credential",
});

describe("connected worker foreground lifecycle", () => {
  it.each(["native_runtime_owner", "native_parent_continuation"])("does not retry unresolved %s work", async awaiting => {
    const nativeRuntime = { run: vi.fn() }, runOnce = vi.fn(async () => report("stopped", awaiting)), waitForOffer = vi.fn();
    await expect(runWorkerProcess(config, { signal: new AbortController().signal, nativeRuntime, runOnce, publishReport: vi.fn(), waitForOffer }))
      .rejects.toThrow("operator reconciliation");
    expect(runOnce).toHaveBeenCalledWith(config, expect.objectContaining({ nativeRuntime }));
    expect(runOnce).toHaveBeenCalledTimes(1); expect(waitForOffer).not.toHaveBeenCalled();
  });
  it.each(["approval_resolution", "parent_recovery"])("polls serially through %s waits and stops cleanly without abandoning retained work", async (awaiting) => {
    const shutdown = new AbortController();
    const runOnce = vi.fn(async () => report("stopped", awaiting));
    const publishReport = vi.fn();
    const waitForOffer = vi.fn(async () => { if (runOnce.mock.calls.length === 3) shutdown.abort(); });
    await runWorkerProcess(config, { signal: shutdown.signal, runOnce, publishReport, waitForOffer });
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(waitForOffer).toHaveBeenCalledTimes(3);
    expect(publishReport).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: "shutdown_requested", recoveryRequired: false,
      lastReport: expect.objectContaining({ awaiting }),
    }));
  });

  it("waits between empty polls and completed assignments without overlapping work", async () => {
    const shutdown = new AbortController();
    const order: string[] = [];
    let executions = 0;
    const runOnce = vi.fn(async () => {
      order.push(`run:${++executions}`);
      return executions === 1 ? report("stopped", "assignment_offer") : report("completed");
    });
    const publishReport = vi.fn(async () => {
      order.push("report");
    });
    await runWorkerProcess(config, {
      signal: shutdown.signal,
      runOnce,
      publishReport,
      waitForOffer: async () => {
        order.push("wait");
        if (executions === 3) shutdown.abort();
      },
    });
    expect(order).toEqual(["run:1", "report", "wait", "run:2", "report", "wait", "run:3", "report", "wait", "report"]);
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(publishReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "shutdown_requested", recoveryRequired: false }),
    );
  });

  it("never retries a connection or execution failure with an uncertain outcome", async () => {
    const runOnce = vi.fn(async () => {
      throw new Error("lost settlement response");
    });
    const waitForOffer = vi.fn();
    await expect(
      runWorkerProcess(config, {
        signal: new AbortController().signal,
        runOnce,
        publishReport: vi.fn(),
        waitForOffer,
      }),
    ).rejects.toThrow("lost settlement response");
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(waitForOffer).not.toHaveBeenCalled();
  });

  it("does not launch more work after an unresolved stop or report persistence failure", async () => {
    const runOnce = vi.fn(async () => report("stopped"));
    await expect(
      runWorkerProcess(config, {
        signal: new AbortController().signal,
        runOnce,
        publishReport: vi.fn(),
      }),
    ).rejects.toThrow("reconciliation");
    expect(runOnce).toHaveBeenCalledTimes(1);
    const completed = vi.fn(async () => report("completed"));
    await expect(
      runWorkerProcess(config, {
        signal: new AbortController().signal,
        runOnce: completed,
        publishReport: async () => {
          throw new Error("disk unavailable");
        },
      }),
    ).rejects.toThrow("disk unavailable");
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("propagates process cancellation into the active request and retains recovery truth", async () => {
    const shutdown = new AbortController();
    const publishReport = vi.fn();
    const runOnce = vi.fn(async (_config, { signal } = {}) => {
      expect(signal).toBe(shutdown.signal);
      shutdown.abort();
      throw new Error("cancelled request with unknown outcome");
    });
    await runWorkerProcess(config, { signal: shutdown.signal, runOnce, publishReport });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(publishReport).toHaveBeenCalledWith(expect.objectContaining({ recoveryRequired: true }));
  });

  it("retains one-shot behavior and refuses continuous protocol probes", async () => {
    const runOnce = vi.fn(async () => report("completed"));
    const waitForOffer = vi.fn();
    await runWorkerProcess(
      { ...config, runMode: "once" },
      {
        signal: new AbortController().signal,
        runOnce,
        publishReport: vi.fn(),
        waitForOffer,
      },
    );
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(waitForOffer).not.toHaveBeenCalled();
    await expect(
      runWorkerProcess(
        { ...config, executionMode: "protocol_probe" },
        {
          signal: new AbortController().signal,
          runOnce,
          publishReport: vi.fn(),
        },
      ),
    ).rejects.toThrow("complete governed execution");
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});

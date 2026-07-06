import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";
import type { BackgroundIntervalHandle } from "./background-scheduler.js";

interface ReapResult {
  dryRun: boolean;
  scanned: number;
  removed: string[];
  skippedActive: string[];
}

interface ReaperHarness {
  readonly gateway: GatewayService;
  readonly reapOrphaned: ReturnType<typeof vi.fn>;
  readonly backgroundTasks: Set<Promise<void>>;
}

function emptyReapResult(): ReapResult {
  return { dryRun: false, scanned: 0, removed: [], skippedActive: [] };
}

function createReaperHarness(reapImpl: () => Promise<ReapResult> = async () => emptyReapResult()): ReaperHarness {
  const reapOrphaned = vi.fn(reapImpl);
  const backgroundTasks = new Set<Promise<void>>();
  const gateway = Object.create(GatewayService.prototype) as GatewayService & {
    orchestrationWorktreeService: { reapOrphaned: typeof reapOrphaned };
    backgroundTasks: Set<Promise<void>>;
    closing: boolean;
    orchestrationWorktreeReapScheduler?: BackgroundIntervalHandle;
  };
  gateway.orchestrationWorktreeService = { reapOrphaned };
  gateway.backgroundTasks = backgroundTasks;
  gateway.closing = false;
  return { gateway, reapOrphaned, backgroundTasks };
}

async function flushBackgroundTasks(backgroundTasks: Set<Promise<void>>): Promise<void> {
  await Promise.allSettled([...backgroundTasks]);
}

describe("GatewayService orchestration worktree reaper scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes reapOrphaned({ dryRun: false }) after the boot delay and on each interval", async () => {
    const { gateway, reapOrphaned, backgroundTasks } = createReaperHarness();

    (
      GatewayService.prototype as never as { startOrchestrationWorktreeReapScheduler: () => void }
    ).startOrchestrationWorktreeReapScheduler.call(gateway);

    expect(reapOrphaned).not.toHaveBeenCalled();

    // Post-boot pass.
    await vi.advanceTimersByTimeAsync(30_000);
    await flushBackgroundTasks(backgroundTasks);
    expect(reapOrphaned).toHaveBeenCalledTimes(1);
    expect(reapOrphaned).toHaveBeenLastCalledWith({ dryRun: false });

    // Hourly recurring pass.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await flushBackgroundTasks(backgroundTasks);
    expect(reapOrphaned).toHaveBeenCalledTimes(2);
    expect(reapOrphaned).toHaveBeenLastCalledWith({ dryRun: false });
  });

  it("is idempotent: a second start does not register a duplicate interval", async () => {
    const { gateway, reapOrphaned, backgroundTasks } = createReaperHarness();
    const start = (GatewayService.prototype as never as { startOrchestrationWorktreeReapScheduler: () => void })
      .startOrchestrationWorktreeReapScheduler;

    start.call(gateway);
    start.call(gateway);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushBackgroundTasks(backgroundTasks);

    // A single boot pass despite two start calls.
    expect(reapOrphaned).toHaveBeenCalledTimes(1);
  });

  it("catches and logs reaper errors instead of throwing or rejecting unhandled", async () => {
    const { gateway, reapOrphaned, backgroundTasks } = createReaperHarness(async () => {
      throw new Error("reaper boom");
    });

    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    (
      GatewayService.prototype as never as { startOrchestrationWorktreeReapScheduler: () => void }
    ).startOrchestrationWorktreeReapScheduler.call(gateway);

    await vi.advanceTimersByTimeAsync(30_000);
    // The background task settles without rejecting (allSettled would surface a throw as rejected).
    const settled = await Promise.allSettled([...backgroundTasks]);
    stderrSpy.mockRestore();

    expect(reapOrphaned).toHaveBeenCalledTimes(1);
    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);

    const warning = stderrLines.find((line) => line.includes("orchestration worktree reaper tick failed"));
    expect(warning).toBeDefined();
    const parsed = JSON.parse(warning!) as { level: string; msg: string };
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toContain("orchestration worktree reaper tick failed");
  });

  it("skips reaping while the gateway is closing", async () => {
    const { gateway, reapOrphaned, backgroundTasks } = createReaperHarness();

    (
      GatewayService.prototype as never as { startOrchestrationWorktreeReapScheduler: () => void }
    ).startOrchestrationWorktreeReapScheduler.call(gateway);
    (gateway as unknown as { closing: boolean }).closing = true;

    await vi.advanceTimersByTimeAsync(30_000);
    await flushBackgroundTasks(backgroundTasks);

    expect(reapOrphaned).not.toHaveBeenCalled();
  });

  it("clears the reaper timers on gateway shutdown", async () => {
    const { gateway, reapOrphaned, backgroundTasks } = createReaperHarness();
    const closable = gateway as unknown as {
      chatProactiveService: { stopScheduler: () => void };
      improvementService: { stopScheduler: () => void };
      durableRunService: { stopWorker: () => void };
      approvalEffectsService: { stopWorker: () => void };
      discordRuntimeService: { close: () => Promise<void> };
      signalInboundRuntimeService: { stop: () => void };
      assemblyService: { close: () => Promise<void> };
      npuSidecar: { close: () => Promise<void> };
      llamaCppRuntime: { close: () => Promise<void> };
      storage: { close: () => void };
      orchestrationWorktreeReapScheduler?: BackgroundIntervalHandle;
    };
    closable.chatProactiveService = { stopScheduler: vi.fn() };
    closable.improvementService = { stopScheduler: vi.fn() };
    closable.durableRunService = { stopWorker: vi.fn() };
    closable.approvalEffectsService = { stopWorker: vi.fn() };
    closable.discordRuntimeService = { close: vi.fn(async () => undefined) };
    closable.signalInboundRuntimeService = { stop: vi.fn() };
    closable.assemblyService = { close: vi.fn(async () => undefined) };
    closable.npuSidecar = { close: vi.fn(async () => undefined) };
    closable.llamaCppRuntime = { close: vi.fn(async () => undefined) };
    closable.storage = { close: vi.fn() };

    (
      GatewayService.prototype as never as { startOrchestrationWorktreeReapScheduler: () => void }
    ).startOrchestrationWorktreeReapScheduler.call(gateway);

    // The scheduler registers a disposer handle; closing must invoke it and clear the field.
    expect(closable.orchestrationWorktreeReapScheduler).toBeDefined();
    const stopSpy = vi.spyOn(closable.orchestrationWorktreeReapScheduler as BackgroundIntervalHandle, "stop");

    await GatewayService.prototype.close.call(gateway);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(closable.orchestrationWorktreeReapScheduler).toBeUndefined();

    // After shutdown, advancing time fires no further reaper passes (boot timer + interval cleared).
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    await flushBackgroundTasks(backgroundTasks);
    expect(reapOrphaned).not.toHaveBeenCalled();
  });
});

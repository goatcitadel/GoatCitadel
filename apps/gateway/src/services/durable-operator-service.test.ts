import { describe, expect, it, vi } from "vitest";
import type { DurableRunRecord, DurableWakeResult } from "@goatcitadel/contracts";
import { DurableOperatorService, type DurableOperatorServiceDeps } from "./durable-operator-service.js";

describe("DurableOperatorService", () => {
  it("delegates read and direct mutation operations with route defaults", async () => {
    const deps = fakeDeps();
    const service = new DurableOperatorService(deps);

    expect(await service.getDiagnostics()).toEqual({ status: "ok" });
    expect(await service.listRuns()).toEqual([{ runId: "run-1", status: "completed" }]);
    expect(await service.listRuns(7)).toEqual([{ runId: "run-1", status: "completed" }]);
    expect(await service.listRunHistory({ workspaceId: "alpha", limit: 2, cursor: "page" })).toEqual({
      items: [],
      nextCursor: "next",
    });
    expect(deps.durableRunService.listDurableRunHistory).toHaveBeenCalledWith({
      workspaceId: "alpha",
      limit: 2,
      cursor: "page",
    });
    expect(await service.listDeadLetters()).toEqual([{ entryId: "dead-1" }]);
    expect(await service.listDeadLetters(8)).toEqual([{ entryId: "dead-1" }]);
    expect(await service.listRunCheckpoints("run-1")).toEqual([{ checkpointId: "checkpoint-1" }]);
    expect(await service.listRunCheckpoints("run-1", 9)).toEqual([{ checkpointId: "checkpoint-1" }]);
    expect(await service.getRun("run-1")).toEqual(run("completed"));
    expect(await service.listRunTimeline("run-1")).toEqual([{ eventId: "event-1" }]);
    expect(await service.listRunTimeline("run-1", 10)).toEqual([{ eventId: "event-1" }]);
    expect(await service.pauseRun("run-1")).toEqual(run("paused"));
    expect(await service.pauseRun("run-1", "admin")).toEqual(run("paused"));
    expect(await service.recoverDeadLetter("dead-1")).toEqual(run("queued"));
    expect(await service.recoverDeadLetter("dead-1", "admin", { maxAttempts: 3 })).toEqual(run("queued"));

    expect(deps.durableRunService.listDurableRuns).toHaveBeenNthCalledWith(1, 50);
    expect(deps.durableRunService.listDurableRuns).toHaveBeenNthCalledWith(2, 7);
    expect(deps.durableRunService.listDurableDeadLetters).toHaveBeenNthCalledWith(1, 50);
    expect(deps.durableRunService.listDurableDeadLetters).toHaveBeenNthCalledWith(2, 8);
    expect(deps.durableRunService.listDurableRunCheckpoints).toHaveBeenNthCalledWith(1, "run-1", 200);
    expect(deps.durableRunService.listDurableRunCheckpoints).toHaveBeenNthCalledWith(2, "run-1", 9);
    expect(deps.durableRunService.listDurableRunTimeline).toHaveBeenNthCalledWith(1, "run-1", 300);
    expect(deps.durableRunService.listDurableRunTimeline).toHaveBeenNthCalledWith(2, "run-1", 10);
    expect(deps.durableRunService.pauseDurableRun).toHaveBeenNthCalledWith(1, "run-1", "operator");
    expect(deps.durableRunService.pauseDurableRun).toHaveBeenNthCalledWith(2, "run-1", "admin");
    expect(deps.durableRunService.recoverDurableDeadLetter).toHaveBeenNthCalledWith(1, "dead-1", "operator", undefined);
    expect(deps.durableRunService.recoverDurableDeadLetter).toHaveBeenNthCalledWith(2, "dead-1", "admin", {
      maxAttempts: 3,
    });
  });

  it("requests processing only for queued created and retried runs", async () => {
    const deps = fakeDeps();
    const service = new DurableOperatorService(deps);

    deps.durableRunService.createDurableRun
      .mockResolvedValueOnce(run("queued"))
      .mockResolvedValueOnce(run("completed"));
    deps.durableRunService.retryDurableRun.mockResolvedValueOnce(run("queued")).mockResolvedValueOnce(run("failed"));

    expect(await service.createRun({ kind: "test" } as never)).toEqual(run("queued"));
    expect(await service.createRun({ kind: "test" } as never)).toEqual(run("completed"));
    expect(await service.retryRun("run-1")).toEqual(run("queued"));
    expect(await service.retryRun("run-2", "operator_fix", "admin")).toEqual(run("failed"));

    expect(deps.durableRunService.requestRunProcessing).toHaveBeenCalledWith("run-1");
    expect(deps.durableRunService.requestRunProcessing).toHaveBeenCalledTimes(2);
    expect(deps.memoryLifecycleService.syncMaintenanceFromDurableRun).toHaveBeenCalledWith(run("queued"));
    expect(deps.memoryLifecycleService.syncMaintenanceFromDurableRun).toHaveBeenCalledWith(run("failed"));
    expect(deps.hooksService.enqueueAfterHooks).toHaveBeenCalledWith({
      workspaceId: "workspace-run-1",
      trigger: "orchestration.retry.scheduled",
      entityType: "durable_run",
      entityId: "run-1",
      payload: {
        runId: "run-1",
        reason: "manual_retry",
        actorId: "operator",
        status: "queued",
        attemptCount: 2,
      },
    });
    expect(deps.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-run-1",
        entityId: "run-2",
        payload: expect.objectContaining({ actorId: "admin", reason: "operator_fix", status: "failed" }),
      }),
    );
  });

  it("syncs maintenance for resume and cancel operations", async () => {
    const deps = fakeDeps();
    const service = new DurableOperatorService(deps);

    expect(await service.resumeRun("run-1")).toEqual(run("running"));
    expect(await service.resumeRun("run-1", "admin")).toEqual(run("running"));
    expect(await service.cancelRun("run-1")).toEqual(run("cancelled"));
    expect(await service.cancelRun("run-1", "admin")).toEqual(run("cancelled"));

    expect(deps.durableRunService.resumeDurableRun).toHaveBeenNthCalledWith(1, "run-1", "operator");
    expect(deps.durableRunService.resumeDurableRun).toHaveBeenNthCalledWith(2, "run-1", "admin");
    expect(deps.durableRunService.cancelDurableRun).toHaveBeenNthCalledWith(1, "run-1", "operator");
    expect(deps.durableRunService.cancelDurableRun).toHaveBeenNthCalledWith(2, "run-1", "admin");
    expect(deps.durableRunService.requestRunProcessing).toHaveBeenCalledWith("run-1");
    expect(deps.memoryLifecycleService.syncMaintenanceFromDurableRun).toHaveBeenCalledTimes(4);
  });

  it("enqueues wake hooks only when a run was actually woken", async () => {
    const deps = fakeDeps();
    const service = new DurableOperatorService(deps);
    const woke: DurableWakeResult = {
      runId: "run-1",
      eventKey: "approval.resolved",
      outcome: "woke",
      run: run("queued"),
    };
    const ignored: DurableWakeResult = { runId: "run-2", eventKey: "timer", outcome: "skipped_not_waiting" };
    deps.durableRunService.wakeDurableRun.mockResolvedValueOnce(woke).mockResolvedValueOnce(ignored);

    expect(
      await service.wakeRun("run-1", {
        eventKey: "approval.resolved",
        correlationId: "corr-1",
        payload: { ok: true },
      }),
    ).toEqual(woke);
    expect(await service.wakeRun("run-2", { eventKey: "timer" })).toEqual(ignored);

    expect(deps.durableRunService.requestRunProcessing).toHaveBeenCalledWith("run-1");
    expect(deps.hooksService.enqueueAfterHooks).toHaveBeenCalledTimes(1);
    expect(deps.hooksService.enqueueAfterHooks).toHaveBeenCalledWith({
      workspaceId: "workspace-run-1",
      trigger: "orchestration.run.woken",
      entityType: "durable_run",
      entityId: "run-1",
      payload: {
        runId: "run-1",
        eventKey: "approval.resolved",
        correlationId: "corr-1",
        payload: { ok: true },
      },
    });
  });

  it("can defer processing until a larger wake transaction commits", async () => {
    const deps = fakeDeps();
    const service = new DurableOperatorService(deps);
    const woke: DurableWakeResult = {
      runId: "run-1",
      eventKey: "approval.resolved",
      outcome: "woke",
      run: run("queued"),
    };
    deps.durableRunService.wakeDurableRun.mockResolvedValueOnce(woke);

    await expect(
      service.wakeRun(
        "run-1",
        {
          eventKey: "approval.resolved",
          correlationId: "approval-1",
        },
        { deferProcessing: true },
      ),
    ).resolves.toEqual(woke);

    expect(deps.durableRunService.requestRunProcessing).not.toHaveBeenCalled();
    expect(deps.hooksService.enqueueAfterHooks).toHaveBeenCalledTimes(1);
  });

  it("preserves retry commit truth when a post-commit hook enqueue fails", async () => {
    const deps = fakeDeps();
    deps.hooksService.enqueueAfterHooks.mockImplementationOnce(() => {
      throw new Error("hook queue unavailable");
    });
    const service = new DurableOperatorService(deps);

    await expect(service.retryRun("run-1")).rejects.toThrow(
      expect.objectContaining({
        name: "DurableOperatorPostCommitError",
        mutationCommitted: true,
        canonicalResult: expect.objectContaining({ runId: "run-1", status: "queued" }),
      }),
    );
    expect(deps.durableRunService.retryDurableRun).toHaveBeenCalledTimes(1);
  });

  it("attempts every retry post-commit consumer before reporting committed failure", async () => {
    const deps = fakeDeps();
    deps.memoryLifecycleService.syncMaintenanceFromDurableRun.mockImplementationOnce(() => {
      throw new Error("maintenance sync unavailable");
    });
    const service = new DurableOperatorService(deps);

    await expect(service.retryRun("run-1")).rejects.toThrow(
      expect.objectContaining({
        name: "DurableOperatorPostCommitError",
        mutationCommitted: true,
        canonicalResult: expect.objectContaining({ runId: "run-1", status: "queued" }),
      }),
    );
    expect(deps.durableRunService.requestRunProcessing).toHaveBeenCalledWith("run-1");
    expect(deps.hooksService.enqueueAfterHooks).toHaveBeenCalledTimes(1);
  });
});

function run(status: DurableRunRecord["status"]): DurableRunRecord {
  return {
    runId: "run-1",
    status,
    attemptCount: 2,
  } as DurableRunRecord;
}

function fakeDeps() {
  const durableRunService = {
    getDurableDiagnostics: vi.fn(async () => ({ status: "ok" }) as never),
    listDurableRuns: vi.fn(async () => [{ runId: "run-1", status: "completed" }] as never),
    listDurableRunHistory: vi.fn(async () => ({ items: [], nextCursor: "next" })),
    listDurableDeadLetters: vi.fn(async () => [{ entryId: "dead-1" }] as never),
    getDurableDeadLetter: vi.fn(),
    listDurableRunCheckpoints: vi.fn(async () => [{ checkpointId: "checkpoint-1" }] as never),
    createDurableRun: vi.fn(async () => run("queued")),
    getDurableRun: vi.fn(async () => run("completed")),
    getDurableRunsByIds: vi.fn(async () => new Map()),
    listDurableRunTimeline: vi.fn(async () => [{ eventId: "event-1" }] as never),
    watchDurableChildRun: vi.fn(),
    listDurableChildWatchers: vi.fn(),
    detachDurableChildWatcher: vi.fn(),
    reattachDurableChildWatcher: vi.fn(),
    closeDurableChildWatcher: vi.fn(),
    getDurableBackgroundTaskRail: vi.fn(),
    controlDurableBackgroundTask: vi.fn(),
    pauseDurableRun: vi.fn(async () => run("paused")),
    resumeDurableRun: vi.fn(async () => run("running")),
    cancelDurableRun: vi.fn(async () => run("cancelled")),
    retryDurableRun: vi.fn(async () => run("queued")),
    wakeDurableRun: vi.fn<DurableOperatorServiceDeps["durableRunService"]["wakeDurableRun"]>(),
    recoverDurableDeadLetter: vi.fn(async () => run("queued")),
    requestRunProcessing: vi.fn(),
  };
  return {
    durableRunService,
    hooksService: { enqueueAfterHooks: vi.fn() },
    memoryLifecycleService: { syncMaintenanceFromDurableRun: vi.fn() },
    resolveDurableRunHookWorkspaceId: vi.fn(async (input: DurableRunRecord) => `workspace-${input.runId}`),
  } satisfies DurableOperatorServiceDeps;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { DurableRunService } from "./durable-run-service.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function createHarness(options?: {
  onBackgroundAttentionRequired?: (input: {
    eventId: string;
    workspaceId: string;
    sessionId: string;
    watcherId: string;
    childRunId: string;
    title: string;
    message: string;
  }) => Promise<boolean | void> | boolean | void;
  beforeBackgroundTaskRailProjection?: (
    parentRunId: string,
    input: { workspaceId: string; sessionId: string },
  ) => Promise<void> | void;
}) {
  const root = path.join(os.tmpdir(), `goatcitadel-background-task-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(root, "runtime.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  storage.chatSessionMeta.ensure("parent-session", "2026-07-13T00:00:00.000Z", "workspace-a");
  storage.chatSessionMeta.ensure("child-session", "2026-07-13T00:00:00.000Z", "workspace-a");
  storage.durableRuns.createRun({
    runId: "parent-run",
    workflowKey: "chat.turn.execute",
    status: "running",
    payload: { version: "chat.turn.execute.v1", sessionId: "parent-session", turnId: "parent-turn" },
    now: "2026-07-13T00:00:00.000Z",
  });
  storage.durableRuns.createRun({
    runId: "child-run",
    workflowKey: "connector.delivery",
    status: "running",
    payload: { sessionId: "child-session", turnId: "child-turn" },
    now: "2026-07-13T00:00:00.000Z",
  });
  const context = {
    storage: createSqliteAsyncStorage(storage),
    config: { assistant: { durable: { enabled: true } } },
    publishRealtime: vi.fn(),
    requireFeatureEnabled: vi.fn(),
    isFeatureEnabled: vi.fn(() => true),
  } as never;
  const service = new DurableRunService(
    context,
    options?.onBackgroundAttentionRequired || options?.beforeBackgroundTaskRailProjection
      ? ({
          backgroundTasks: new Set(),
          workflowRegistry: {
            executeWorkflow: vi.fn(),
            isWorkflowRecoverable: vi.fn(),
            markWorkflowUnrecoverable: vi.fn(),
          },
          onBackgroundAttentionRequired: options.onBackgroundAttentionRequired,
          beforeBackgroundTaskRailProjection: options.beforeBackgroundTaskRailProjection,
        } as never)
      : undefined,
  );
  const watcher = await service.watchDurableChildRun({
    parentRunId: "parent-run",
    childRunId: "child-run",
    source: "orchestration_phase",
    metadata: { childSessionId: "child-session", childTurnId: "child-turn" },
  });
  return { storage, context, service, watcher };
}

describe("DurableRunService background-task rail", () => {
  it("runs server-owned Explorer repair before the first restart rail projection", async () => {
    let repaired = false;
    const beforeBackgroundTaskRailProjection = vi.fn(
      async (parentRunId: string, input: { workspaceId: string; sessionId: string }) => {
        expect(parentRunId).toBe("parent-run");
        expect(input).toEqual({ workspaceId: "workspace-a", sessionId: "parent-session" });
        repaired = true;
      },
    );
    const { context } = await createHarness();
    const originalListByParent = context.storage.durableChildWatchers.listByParent;
    context.storage.durableChildWatchers.listByParent = vi.fn(async (...args) => {
      expect(repaired).toBe(true);
      return await originalListByParent(...args);
    });
    const restarted = new DurableRunService(context, {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow: vi.fn(),
        isWorkflowRecoverable: vi.fn(),
        markWorkflowUnrecoverable: vi.fn(),
      },
      beforeBackgroundTaskRailProjection,
    } as never);

    await restarted.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });

    expect(beforeBackgroundTaskRailProjection).toHaveBeenCalledTimes(1);
  });

  it("retains child state across service restart and governs detach, reattach, and cancellation races", async () => {
    const { storage, context, service, watcher } = await createHarness();
    const initial = await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    expect(initial.tasks[0]).toMatchObject({
      watcherId: watcher.watcherId,
      canonicalStatus: "running",
      scope: { verified: true },
      attention: { state: "foreground", reason: "watcher_attached", required: false },
      controls: { cancel: { enabled: true } },
    });
    const childBeforeAttentionChange = storage.durableRuns.getRun("child-run");

    const detached = await service.controlDurableBackgroundTask(
      "parent-run",
      watcher.watcherId,
      {
        workspaceId: "workspace-a",
        sessionId: "parent-session",
        action: "detach",
        expectedWatcherRevision: initial.tasks[0]!.watcherRevision,
      },
      "operator-a",
    );
    expect(detached).toMatchObject({
      outcome: "applied",
      rail: {
        tasks: [
          {
            watcherState: "detached",
            attention: {
              state: "background",
              reason: "operator_continued_in_background",
              required: false,
            },
          },
        ],
      },
    });
    expect(storage.durableRuns.getRun("child-run")).toMatchObject({
      status: childBeforeAttentionChange.status,
      version: childBeforeAttentionChange.version,
    });

    const restarted = new DurableRunService(context);
    const afterRestart = await restarted.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    expect(afterRestart.tasks[0]).toMatchObject({
      watcherState: "detached",
      canonicalStatus: "running",
      attention: { state: "background", reason: "operator_continued_in_background" },
    });

    const reattached = await restarted.controlDurableBackgroundTask(
      "parent-run",
      watcher.watcherId,
      {
        workspaceId: "workspace-a",
        sessionId: "parent-session",
        action: "reattach",
        expectedWatcherRevision: afterRestart.tasks[0]!.watcherRevision,
      },
      "operator-a",
    );
    expect(reattached.rail.tasks[0]).toMatchObject({
      watcherState: "attached",
      attention: { state: "foreground", reason: "watcher_attached" },
    });

    const currentTask = reattached.rail.tasks[0]!;
    await expect(
      restarted.controlDurableBackgroundTask(
        "parent-run",
        watcher.watcherId,
        {
          workspaceId: "workspace-a",
          sessionId: "parent-session",
          action: "cancel",
          expectedWatcherRevision: currentTask.watcherRevision,
          expectedChildVersion: currentTask.childVersion! + 1,
        },
        "operator-a",
      ),
    ).rejects.toThrow(/changed from version/);
    expect(storage.durableRuns.getRun("child-run").status).toBe("running");

    const cancelled = await restarted.controlDurableBackgroundTask(
      "parent-run",
      watcher.watcherId,
      {
        workspaceId: "workspace-a",
        sessionId: "parent-session",
        action: "cancel",
        expectedWatcherRevision: currentTask.watcherRevision,
        expectedChildVersion: currentTask.childVersion,
        reason: "Bearer abcdefghijklmnopqrstuvwxyz operator request",
      },
      "operator-a",
    );
    expect(cancelled.rail.tasks[0]?.canonicalStatus).toBe("cancelled");
    expect(storage.durableRuns.getRun("child-run")).toMatchObject({
      status: "cancelled",
      lastError: "cancelled by background-task-rail:operator-a",
    });
    expect(storage.durableRuns.listCheckpoints("child-run").at(-1)?.state).toMatchObject({
      reason: "Bearer [REDACTED] operator request",
    });
    expect(storage.durableRunEvents.listByRun("child-run").at(-1)?.payload).toMatchObject({
      reason: "Bearer [REDACTED] operator request",
    });

    const converged = await restarted.controlDurableBackgroundTask(
      "parent-run",
      watcher.watcherId,
      {
        workspaceId: "workspace-a",
        sessionId: "parent-session",
        action: "cancel",
        expectedWatcherRevision: cancelled.rail.tasks[0]!.watcherRevision,
        expectedChildVersion: currentTask.childVersion,
      },
      "operator-a",
    );
    expect(converged.outcome).toBe("converged");
  });

  it("fails closed when the requested parent workspace or session scope does not match", async () => {
    const { service } = await createHarness();
    await expect(
      service.getDurableBackgroundTaskRail("parent-run", {
        workspaceId: "workspace-b",
        sessionId: "parent-session",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      service.getDurableBackgroundTaskRail("parent-run", {
        workspaceId: "workspace-a",
        sessionId: "different-session",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a stale client revision after same-millisecond watcher ABA changes", async () => {
    const { storage, service, watcher } = await createHarness();
    const clientA = (
      await service.getDurableBackgroundTaskRail("parent-run", {
        workspaceId: "workspace-a",
        sessionId: "parent-session",
      })
    ).tasks[0]!;
    const clientB = { ...clientA };
    const sameMillisecond = "2026-07-13T00:00:01.000Z";
    storage.durableChildWatchers.detach(watcher.watcherId, sameMillisecond);
    storage.durableChildWatchers.reattach(watcher.watcherId, sameMillisecond);
    storage.durableChildWatchers.detach(watcher.watcherId, sameMillisecond);
    storage.durableChildWatchers.reattach(watcher.watcherId, sameMillisecond);

    const current = storage.durableChildWatchers.get(watcher.watcherId);
    expect(current.revision).toBe(clientA.watcherRevision + 4);
    expect(current.updatedAt).toBe(sameMillisecond);
    for (const staleClient of [clientA, clientB]) {
      await expect(
        service.controlDurableBackgroundTask(
          "parent-run",
          watcher.watcherId,
          {
            workspaceId: "workspace-a",
            sessionId: "parent-session",
            action: "detach",
            expectedWatcherRevision: staleClient.watcherRevision,
          },
          "operator-a",
        ),
      ).rejects.toThrow(/changed before detach/);
    }
    expect(storage.durableChildWatchers.get(watcher.watcherId)).toMatchObject({
      state: "attached",
      revision: current.revision,
    });
  });

  it("best-effort notifies once for a newly projected background blocker without changing the child run", async () => {
    const notify = vi.fn(async () => undefined);
    const { storage, service, watcher } = await createHarness({ onBackgroundAttentionRequired: notify });
    const initial = await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    await service.controlDurableBackgroundTask("parent-run", watcher.watcherId, {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
      action: "detach",
      expectedWatcherRevision: initial.tasks[0]!.watcherRevision,
    });
    const running = storage.durableRuns.getRun("child-run");
    storage.durableRuns.updateRun({
      runId: running.runId,
      status: "waiting",
      updatedAt: "2026-07-13T00:00:03.000Z",
      expectedVersion: running.version,
    });

    const first = await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    const second = await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });

    expect(first.tasks[0]?.attention).toMatchObject({
      state: "background",
      required: true,
      requiredReason: "waiting",
    });
    expect(second.tasks[0]?.canonicalStatus).toBe("waiting");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expect.stringMatching(/^durable-attention:[a-f0-9]{64}$/),
        workspaceId: "workspace-a",
        sessionId: "parent-session",
        watcherId: watcher.watcherId,
        childRunId: "child-run",
      }),
    );
    expect(storage.durableRuns.getRun("child-run")).toMatchObject({
      status: "waiting",
      version: running.version + 1,
    });
  });

  it("attempts background notification from the committed canonical child transition without Chat polling", async () => {
    const notify = vi.fn(async () => undefined);
    const { storage, service, watcher } = await createHarness({ onBackgroundAttentionRequired: notify });
    const initial = await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    await service.controlDurableBackgroundTask("parent-run", watcher.watcherId, {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
      action: "detach",
      expectedWatcherRevision: initial.tasks[0]!.watcherRevision,
    });
    const running = storage.durableRuns.getRun("child-run");
    await service.cancelDurableRun("child-run", "test-operator");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        sessionId: "parent-session",
        childRunId: "child-run",
        message: expect.stringContaining("needs attention: missing output"),
      }),
    );
    expect(storage.durableRuns.getRun("child-run")).toMatchObject({
      status: "cancelled",
      version: running.version + 1,
    });
  });

  it("notifies from a committed continuation-gate pause without waiting for Chat polling", async () => {
    const notify = vi.fn(async () => undefined);
    const { storage, context } = await createHarness();
    storage.durableRuns.createRun({
      runId: "paused-child-run",
      workflowKey: "connector.delivery",
      status: "queued",
      payload: { sessionId: "child-session", turnId: "paused-child-turn" },
      now: "2026-07-13T00:00:02.000Z",
    });
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn();
    const service = new DurableRunService(context, {
      backgroundTasks,
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: vi.fn(() => ({ recoverable: true })),
        markWorkflowUnrecoverable: vi.fn(),
      },
      evaluateContinuationGate: vi.fn(() => ({
        decision: "pause",
        reasonCodes: ["approval_wait"],
        summary: "Continue gate set to pause: approval_wait.",
        metrics: {
          stepsSinceCheckpoint: 0,
          toolRunCount: 0,
          failedToolRunCount: 0,
          retryFailureStreak: 0,
          approvalWait: true,
          userInputWait: false,
          evidenceGapCount: 0,
        },
        recommendedAction: "Wait for the operator to resolve the approval.",
        createdAt: "2026-07-13T00:00:03.000Z",
      })),
      onBackgroundAttentionRequired: notify,
    } as never);
    const watcher = await service.watchDurableChildRun({
      parentRunId: "parent-run",
      childRunId: "paused-child-run",
      source: "orchestration_phase",
      metadata: { childSessionId: "child-session", childTurnId: "paused-child-turn" },
    });
    await service.detachDurableChildWatcher(watcher.watcherId);

    service.startWorker();
    await vi.waitFor(() => expect(storage.durableRuns.getRun("paused-child-run").status).toBe("paused"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await service.stopWorker();
    await Promise.all([...backgroundTasks]);

    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        sessionId: "parent-session",
        watcherId: watcher.watcherId,
        childRunId: "paused-child-run",
        message: expect.stringContaining("needs attention: paused"),
      }),
    );
  });

  it("does not notify when the canonical blocker transaction rolls back after its event append", async () => {
    const notify = vi.fn(async () => undefined);
    const { storage, service, watcher } = await createHarness({ onBackgroundAttentionRequired: notify });
    const initial = await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    await service.controlDurableBackgroundTask("parent-run", watcher.watcherId, {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
      action: "detach",
      expectedWatcherRevision: initial.tasks[0]!.watcherRevision,
    });
    const append = storage.durableRunEvents.append.bind(storage.durableRunEvents);
    vi.spyOn(storage.durableRunEvents, "append").mockImplementation((event) => {
      const persisted = append(event);
      if (event.eventType === "run_cancelled") {
        throw new Error("forced rollback after blocker event append");
      }
      return persisted;
    });

    await expect(service.cancelDurableRun("child-run", "test-operator")).rejects.toThrow(/forced rollback/);
    await Promise.resolve();

    expect(notify).not.toHaveBeenCalled();
    expect(storage.durableRuns.getRun("child-run").status).toBe("running");
    expect(storage.durableRunEvents.listByRun("child-run").some((event) => event.eventType === "run_cancelled")).toBe(
      false,
    );
  });

  it("notifies detached parents beyond the first 100 watcher fanout rows", async () => {
    const notify = vi.fn(async () => undefined);
    const { storage, service } = await createHarness({ onBackgroundAttentionRequired: notify });
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const parentRunId = `scale-parent-run-${suffix}`;
      const parentSessionId = `scale-parent-session-${suffix}`;
      const watcherId = `scale-watcher-${suffix}`;
      storage.chatSessionMeta.ensure(parentSessionId, "2026-07-13T00:00:00.000Z", "workspace-a");
      storage.durableRuns.createRun({
        runId: parentRunId,
        workflowKey: "chat.turn.execute",
        status: "running",
        payload: { version: "chat.turn.execute.v1", sessionId: parentSessionId, turnId: `parent-turn-${suffix}` },
        now: "2026-07-13T00:00:00.000Z",
      });
      storage.durableChildWatchers.create({
        watcherId,
        parentRunId,
        childRunId: "child-run",
        source: "orchestration_phase",
      });
      storage.durableChildWatchers.detach(watcherId, "2026-07-13T00:00:01.000Z");
    }

    await service.cancelDurableRun("child-run", "test-operator");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(101), { timeout: 10_000 });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "scale-parent-session-100",
        watcherId: "scale-watcher-100",
        childRunId: "child-run",
      }),
    );
  });

  it("keeps notification failure non-authoritative and retries with the same stable event id", async () => {
    const notify = vi.fn(async () => {
      throw new Error("notification target unavailable");
    });
    const { storage, service, watcher } = await createHarness({ onBackgroundAttentionRequired: notify });
    const initial = await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    await service.controlDurableBackgroundTask("parent-run", watcher.watcherId, {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
      action: "detach",
      expectedWatcherRevision: initial.tasks[0]!.watcherRevision,
    });
    const running = storage.durableRuns.getRun("child-run");
    storage.durableRuns.updateRun({
      runId: running.runId,
      status: "waiting",
      updatedAt: "2026-07-13T00:00:03.000Z",
      expectedVersion: running.version,
    });

    await expect(
      service.getDurableBackgroundTaskRail("parent-run", {
        workspaceId: "workspace-a",
        sessionId: "parent-session",
      }),
    ).resolves.toMatchObject({ tasks: [{ canonicalStatus: "waiting" }] });
    await service.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0].eventId).toBe(notify.mock.calls[1]?.[0].eventId);
    expect(storage.durableRuns.getRun("child-run")).toMatchObject({
      status: "waiting",
      version: running.version + 1,
    });
  });
});

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

async function createHarness() {
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
  const service = new DurableRunService(context);
  const watcher = await service.watchDurableChildRun({
    parentRunId: "parent-run",
    childRunId: "child-run",
    source: "orchestration_phase",
    metadata: { childSessionId: "child-session", childTurnId: "child-turn" },
  });
  return { storage, context, service, watcher };
}

describe("DurableRunService background-task rail", () => {
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
      controls: { cancel: { enabled: true } },
    });

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
    expect(detached).toMatchObject({ outcome: "applied", rail: { tasks: [{ watcherState: "detached" }] } });

    const restarted = new DurableRunService(context);
    const afterRestart = await restarted.getDurableBackgroundTaskRail("parent-run", {
      workspaceId: "workspace-a",
      sessionId: "parent-session",
    });
    expect(afterRestart.tasks[0]).toMatchObject({ watcherState: "detached", canonicalStatus: "running" });

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
    expect(reattached.rail.tasks[0]?.watcherState).toBe("attached");

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
});

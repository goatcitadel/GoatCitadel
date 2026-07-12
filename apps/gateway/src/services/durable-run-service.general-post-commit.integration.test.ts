import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { GENERAL_CHAT_POST_COMMIT_EFFECTS, type GeneralChatPostCommitProgress } from "./chat-durable-run-service.js";
import { DurableRunService } from "./durable-run-service.js";
import { IDEMPOTENT_REALTIME_ENVELOPE_KEY, RealtimeEventService } from "./realtime-event-service.js";
import type { ServiceContext } from "./service-context.js";

const roots: string[] = [];
const services: DurableRunService[] = [];
const storages: Storage[] = [];

afterEach(() => {
  for (const service of services.splice(0)) {
    service.stopWorker();
  }
  for (const storage of storages.splice(0)) {
    try {
      storage.close();
    } catch {
      // A restart test may already have closed this handle.
    }
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("DurableRunService general Chat post-commit integration", () => {
  it("atomically enqueues deterministic async children, survives restart, and never repeats committed receipts", async () => {
    const harness = createStorageHarness();
    const parent = seedParent(harness.storage, "generation-restart");
    let failParentReceipt = true;
    const originalUpdate = harness.storage.durableRuns.updateRun.bind(harness.storage.durableRuns);
    const updateSpy = vi.spyOn(harness.storage.durableRuns, "updateRun").mockImplementation((input) => {
      const pending = input.metadata?.generalChatPostCommitPending as
        | { durableEffectRunIds?: Record<string, unknown> }
        | undefined;
      if (failParentReceipt && input.runId === parent.runId && pending?.durableEffectRunIds?.commitments) {
        failParentReceipt = false;
        throw new Error("simulated crash before parent enqueue receipt");
      }
      return originalUpdate(input);
    });
    const onGeneral = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      reconcileGeneralEffects(progress);
      return { status: "enqueued" };
    });
    const firstService = createService(harness.storage, onGeneral);
    // Model a process that can persist recovery work but crashes before its
    // worker drains the newly queued children.
    firstService.stopWorker();

    expect(await firstService.reconcileGeneralChatPostCommit(parent.runId)).toBe(false);
    expect(listPostCommitChildren(harness.storage)).toHaveLength(0);

    updateSpy.mockRestore();
    expect(await firstService.reconcileGeneralChatPostCommit(parent.runId)).toBe(false);
    const children = listPostCommitChildren(harness.storage);
    expect(children).toHaveLength(3);
    expect(new Set(children.map((run) => run.runId)).size).toBe(3);
    expect(children.every((run) => run.status === "queued")).toBe(true);
    expect(JSON.stringify(children.map((run) => run.payload))).not.toContain("Please follow up tomorrow");
    expect(children.map((run) => run.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentRunId: parent.runId,
          generationId: "generation-restart",
          workspaceId: "workspace-post-commit",
          sessionId: "session-post-commit",
          turnId: "turn-post-commit",
        }),
      ]),
    );
    expect(harness.storage.durableRuns.getRun(parent.runId).metadata).toMatchObject({
      generalChatPostCommitPending: {
        durableEffectRunIds: {
          commitments: expect.any(String),
          background_review: expect.any(String),
          memory_maintenance: expect.any(String),
        },
      },
    });

    expect(await firstService.reconcileGeneralChatPostCommit(parent.runId)).toBe(false);
    expect(onGeneral).toHaveBeenCalledTimes(3);
    expect(listPostCommitChildren(harness.storage)).toHaveLength(3);

    firstService.stopWorker();
    harness.storage.close();
    storages.splice(storages.indexOf(harness.storage), 1);
    const restartedStorage = openStorage(harness);
    const executeWorkflow = vi.fn(async (run: DurableRunRecord) => {
      restartedStorage.runImmediateTransaction(() => {
        const current = restartedStorage.durableRuns.getRunForUpdate(run.runId);
        restartedStorage.durableRuns.updateRun({
          runId: run.runId,
          status: "completed",
          finishedAt: new Date().toISOString(),
          clearLease: true,
          updatedAt: new Date().toISOString(),
          expectedVersion: current.version,
        });
      });
    });
    const restartedService = createService(restartedStorage, onGeneral, executeWorkflow);
    restartedService.startWorker();
    await waitFor(
      () => listPostCommitChildren(restartedStorage).every((run) => run.status === "completed"),
      () =>
        JSON.stringify({
          calls: executeWorkflow.mock.calls.map(([run]) => [run.runId, run.status]),
          runs: listPostCommitChildren(restartedStorage).map((run) => [run.runId, run.status, run.lastError]),
          diagnostics: restartedService.getDurableDiagnostics(),
        }),
    );

    expect(executeWorkflow).toHaveBeenCalledTimes(3);
    expect(listPostCommitChildren(restartedStorage).every((run) => run.status === "completed")).toBe(true);
    await waitFor(
      () => !restartedStorage.durableRuns.getRun(parent.runId).metadata?.generalChatPostCommitPending,
      () => JSON.stringify(restartedStorage.durableRuns.getRun(parent.runId).metadata),
    );
    expect(restartedStorage.durableRuns.getRun(parent.runId).metadata).toMatchObject({
      generalChatPostCommit: {
        generationId: "generation-restart",
        settlementStatus: "completed",
        durableEffectOutcomes: {
          commitments: { status: "completed" },
          background_review: { status: "completed" },
          memory_maintenance: { status: "completed" },
        },
      },
    });
  }, 30_000);

  it("keeps parent truth pending across restart and records a terminal child failure", async () => {
    const harness = createStorageHarness();
    const parent = seedParent(harness.storage, "generation-child-failure");
    const onGeneral = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      reconcileGeneralEffects(progress);
      return { status: "dispatched" };
    });
    const firstService = createService(harness.storage, onGeneral);
    firstService.stopWorker();

    expect(await firstService.reconcileGeneralChatPostCommit(parent.runId)).toBe(false);
    expect(harness.storage.durableRuns.getRun(parent.runId).metadata).toHaveProperty("generalChatPostCommitPending");
    harness.storage.close();
    storages.splice(storages.indexOf(harness.storage), 1);

    const restartedStorage = openStorage(harness);
    for (const child of listPostCommitChildren(restartedStorage)) {
      const failed = child.metadata?.effect === "background_review";
      restartedStorage.durableRuns.updateRun({
        runId: child.runId,
        status: failed ? "failed" : "completed",
        finishedAt: new Date().toISOString(),
        lastError: failed ? "provider failed after first token" : undefined,
        updatedAt: new Date().toISOString(),
        expectedVersion: child.version,
      });
    }
    const restartedService = createService(restartedStorage, onGeneral);

    expect(await restartedService.reconcileGeneralChatPostCommit(parent.runId)).toBe(true);
    expect(restartedStorage.durableRuns.getRun(parent.runId).metadata).toMatchObject({
      generalChatPostCommit: {
        settlementStatus: "settled_with_failures",
        durableEffectOutcomes: {
          commitments: { status: "completed" },
          background_review: { status: "failed", error: "provider failed after first token" },
          memory_maintenance: { status: "completed" },
        },
      },
    });
    expect(restartedStorage.durableRuns.getRun(parent.runId).metadata?.generalChatPostCommit).not.toHaveProperty(
      "completedAt",
    );
  });

  it("does not busy-wake the local worker while post-commit children run on another worker", async () => {
    const harness = createStorageHarness();
    const parent = seedParent(harness.storage, "generation-foreign-worker");
    const onGeneral = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      reconcileGeneralEffects(progress);
      return { status: "dispatched" };
    });
    const service = createService(harness.storage, onGeneral);
    service.stopWorker();

    expect(await service.reconcileGeneralChatPostCommit(parent.runId)).toBe(false);
    for (const child of listPostCommitChildren(harness.storage)) {
      const now = new Date().toISOString();
      harness.storage.durableRuns.updateRun({
        runId: child.runId,
        status: "running",
        leaseOwnerId: `foreign-${child.runId}`,
        leaseHeartbeatAt: now,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        updatedAt: now,
        expectedVersion: child.version,
      });
    }
    const requestProcessing = vi.spyOn(service, "requestRunProcessing").mockImplementation(() => undefined);

    expect(await service.reconcileGeneralChatPostCommit(parent.runId)).toBe(false);
    expect(requestProcessing).not.toHaveBeenCalled();
    expect(harness.storage.durableRuns.getRun(parent.runId).metadata).toHaveProperty("generalChatPostCommitPending");
  });

  it("never emits a live parent realtime ghost and replays one stable delivery after receipt commit", async () => {
    const harness = createStorageHarness();
    const parent = seedParent(harness.storage, "generation-parent-realtime");
    const realtime = new RealtimeEventService({ storage: harness.storage, getGatewayNodeId: () => "node-test" });
    const listener = vi.fn();
    realtime.subscribeRealtime(listener);
    const onGeneral = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      progress.publishEffect("realtime", () => {
        realtime.publishRealtime("chat_thread_updated", "chat", {
          sessionId: "session-post-commit",
          [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: {
            deliveryId: `${parent.runId}:${progress.generationId}:chat-thread-updated`,
            occurredAt: progress.requestedAt,
          },
        });
      });
      for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
        progress.runEffect(effect, () => undefined);
      }
      return { status: "completed" };
    });
    const service = createService(harness.storage, onGeneral);
    service.stopWorker();
    const originalUpdate = harness.storage.durableRuns.updateRun.bind(harness.storage.durableRuns);
    let failReceipt = true;
    const updateSpy = vi.spyOn(harness.storage.durableRuns, "updateRun").mockImplementation((input) => {
      const pending = input.metadata?.generalChatPostCommitPending as { completedEffects?: unknown[] } | undefined;
      if (failReceipt && input.runId === parent.runId && pending?.completedEffects?.includes("realtime")) {
        failReceipt = false;
        throw new Error("simulated parent receipt failure");
      }
      return originalUpdate(input);
    });

    expect(await service.reconcileGeneralChatPostCommit(parent.runId)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    updateSpy.mockRestore();
    expect(await service.reconcileGeneralChatPostCommit(parent.runId)).toBe(true);
    expect(await service.reconcileGeneralChatPostCommit(parent.runId)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("preserves a replacement generation and resumes after a partial synchronous effect failure", async () => {
    const generationHarness = createStorageHarness();
    const generationParent = seedParent(generationHarness.storage, "generation-waiting", "waiting");
    const observedGenerations: string[] = [];
    const generationService = createService(
      generationHarness.storage,
      vi.fn(async (_run, progress) => {
        observedGenerations.push(progress.generationId);
        progress.runEffect("capability_gap", () => undefined);
        if (progress.generationId === "generation-waiting") {
          const current = generationHarness.storage.durableRuns.getRun(generationParent.runId);
          generationHarness.storage.durableRuns.updateRun({
            runId: current.runId,
            status: "completed",
            metadata: pendingMetadata("generation-completed", "completed"),
            updatedAt: new Date().toISOString(),
            expectedVersion: current.version,
          });
          return { status: "waiting" };
        }
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          progress.runEffect(effect, () => undefined);
        }
        return { status: "completed" };
      }),
    );

    expect(await generationService.reconcileGeneralChatPostCommit(generationParent.runId)).toBe(true);
    expect(observedGenerations).toEqual(["generation-waiting", "generation-completed"]);
    expect(generationHarness.storage.durableRuns.getRun(generationParent.runId).metadata).toMatchObject({
      generalChatPostCommit: { generationId: "generation-completed", traceStatus: "completed" },
    });

    const partialHarness = createStorageHarness();
    const partialParent = seedParent(partialHarness.storage, "generation-partial");
    const learnedMemory = vi.fn();
    const realtime = vi.fn();
    let failRealtime = true;
    const partialService = createService(
      partialHarness.storage,
      vi.fn(async (_run, progress) => {
        progress.runEffect("learned_memory_user", learnedMemory);
        progress.publishEffect("realtime", () => {
          realtime();
          if (failRealtime) {
            failRealtime = false;
            throw new Error("retained stream unavailable");
          }
        });
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          progress.runEffect(effect, () => undefined);
        }
        return { status: "completed" };
      }),
    );

    expect(await partialService.reconcileGeneralChatPostCommit(partialParent.runId)).toBe(false);
    expect(partialHarness.storage.durableRuns.getRun(partialParent.runId).metadata).toMatchObject({
      generalChatPostCommitPending: { completedEffects: ["learned_memory_user", "realtime"] },
    });
    expect(await partialService.reconcileGeneralChatPostCommit(partialParent.runId)).toBe(true);
    expect(learnedMemory).toHaveBeenCalledTimes(1);
    expect(realtime).toHaveBeenCalledTimes(2);
  });
});

function reconcileGeneralEffects(progress: GeneralChatPostCommitProgress): void {
  progress.enqueueDurableEffect({
    effect: "commitments",
    sessionId: "session-post-commit",
    workspaceId: "workspace-post-commit",
    turnId: "turn-post-commit",
    autonomous: false,
  });
  progress.enqueueDurableEffect({
    effect: "background_review",
    sessionId: "session-post-commit",
    workspaceId: "workspace-post-commit",
    turnId: "turn-post-commit",
    delegatedChild: false,
    autonomous: false,
  });
  progress.enqueueDurableEffect({
    effect: "memory_maintenance",
    sessionId: "session-post-commit",
    workspaceId: "workspace-post-commit",
    turnId: "turn-post-commit",
    delegatedChild: false,
  });
  for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
    if (
      !["commitments", "background_review", "memory_maintenance"].includes(effect) &&
      !progress.completedEffects.includes(effect)
    ) {
      progress.runEffect(effect, () => undefined);
    }
  }
}

function createStorageHarness(): {
  root: string;
  dbPath: string;
  transcriptsDir: string;
  auditDir: string;
  storage: Storage;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-general-post-commit-"));
  roots.push(root);
  const dbPath = path.join(root, "goatcitadel.db");
  const transcriptsDir = path.join(root, "transcripts");
  const auditDir = path.join(root, "audit");
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({ dbPath, transcriptsDir, auditDir });
  storages.push(storage);
  return { root, dbPath, transcriptsDir, auditDir, storage };
}

function openStorage(harness: { dbPath: string; transcriptsDir: string; auditDir: string }): Storage {
  const storage = new Storage(harness);
  storages.push(storage);
  return storage;
}

function createService(
  storage: Storage,
  onGeneral?: (run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => Promise<Record<string, unknown>>,
  executeWorkflow = vi.fn(async () => undefined),
): DurableRunService {
  const service = new DurableRunService(
    {
      storage,
      config: {
        assistant: { durable: { enabled: true, workflowTimeoutMs: 30_000 }, mesh: { nodeId: "test-node" } },
      },
      publishRealtime: () => undefined,
      requireFeatureEnabled: () => undefined,
      isFeatureEnabled: () => true,
      logger: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
    } as unknown as ServiceContext,
    {
      backgroundTasks: new Set(),
      workflowRegistry: {
        executeWorkflow,
        isWorkflowRecoverable: () => ({ recoverable: true }),
        markWorkflowUnrecoverable: vi.fn(),
      },
      ...(onGeneral ? { onGeneralChatPostCommit: onGeneral } : {}),
    },
  );
  services.push(service);
  return service;
}

function seedParent(
  storage: Storage,
  generationId: string,
  status: DurableRunRecord["status"] = "completed",
): DurableRunRecord {
  return storage.durableRuns.createRun({
    runId: `parent-${generationId}`,
    workflowKey: "chat.turn.execute",
    status,
    payload: {
      version: "chat.turn.execute.v1",
      sessionId: "session-post-commit",
      turnId: "turn-post-commit",
      userMessageId: "user-post-commit",
      assistantMessageId: "assistant-post-commit",
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "Please follow up tomorrow." },
    },
    metadata: pendingMetadata(generationId, status === "waiting" ? "waiting_for_approval" : "completed"),
  });
}

function pendingMetadata(generationId: string, traceStatus: string): Record<string, unknown> {
  return {
    generalChatPostCommitPending: {
      version: 1,
      generationId,
      traceStatus,
      requestedAt: "2026-07-11T00:00:00.000Z",
      completedEffects: [],
      durableEffectRunIds: {},
    },
  };
}

function listPostCommitChildren(storage: Storage): DurableRunRecord[] {
  return storage.durableRuns.listRuns(100).filter((run) => run.workflowKey === "chat.post_commit.effect");
}

async function waitFor(predicate: () => boolean, describe?: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for durable post-commit recovery: ${describe?.() ?? "no detail"}`);
}

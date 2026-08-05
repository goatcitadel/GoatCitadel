import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import {
  GENERAL_CHAT_POST_COMMIT_EFFECTS,
  type GeneralChatPostCommitEffectWorkflowPayload,
  type GeneralChatPostCommitProgress,
} from "./chat-durable-run-service.js";
import { isDurableWorkflowRecoverable, markDurableWorkflowUnrecoverable } from "./durable-execution-service.js";
import { buildDurableLocalProcessLeaseOwnerId, DurableRunService } from "./durable-run-service.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";
import {
  buildChatTurnRuntimeAuthoritySeal,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import { IDEMPOTENT_REALTIME_ENVELOPE_KEY, RealtimeEventService } from "./realtime-event-service.js";
import type { ServiceContext } from "./service-context.js";
import { SharedHostLifecycleService } from "./shared-host-lifecycle-service.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";

const roots: string[] = [];
const services: DurableRunService[] = [];
const storages: Storage[] = [];
const asyncStorages = new WeakMap<Storage, AsyncStorage>();

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
  it("preserves a dead local worker prefix and releases the exact durable admission before its lease TTL", async () => {
    const harness = createStorageHarness();
    const seeded = seedRunningRetainedPrefix(harness.storage);
    const backgroundTasks = new Set<Promise<void>>();
    const executeWorkflow = vi.fn(async () => undefined);
    const asyncStorage = getAsyncStorage(harness.storage);
    const workflowHost = {
      storage: asyncStorage,
      publishRealtime: vi.fn(),
      recordDevDiagnostic: vi.fn(),
      persistChatStreamChunk: vi.fn(),
    };
    const service = new DurableRunService(
      {
        storage: asyncStorage,
        config: {
          assistant: { durable: { enabled: true, workflowTimeoutMs: 30_000 }, mesh: { nodeId: "test-node" } },
        },
        publishRealtime: () => undefined,
        requireFeatureEnabled: () => undefined,
        isFeatureEnabled: () => true,
        logger: { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined },
      } as unknown as ServiceContext,
      {
        backgroundTasks,
        sharedHostLifecycle: new SharedHostLifecycleService({ enabled: false }),
        isLocalProcessAlive: vi.fn(() => false),
        workflowRegistry: {
          executeWorkflow,
          isWorkflowRecoverable: (run) => isDurableWorkflowRecoverable(workflowHost as never, run),
          markWorkflowUnrecoverable: (run, reason, context) =>
            markDurableWorkflowUnrecoverable(workflowHost as never, run, reason, context),
        },
        onGeneralChatPostCommit: async (_run, progress) => {
          for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
            await progress.runEffect(effect, () => undefined);
          }
          return { status: "failed" };
        },
      },
    );
    services.push(service);

    service.startWorker();
    await waitFor(
      () => harness.storage.sessionMutationAdmissions.require(seeded.admissionId).status === "cancelled",
      () =>
        JSON.stringify({
          run: harness.storage.durableRuns.getRun(seeded.runId),
          trace: harness.storage.chatTurnTraces.get(seeded.turnId),
          admission: harness.storage.sessionMutationAdmissions.require(seeded.admissionId),
        }),
    );

    const failedRun = harness.storage.durableRuns.getRun(seeded.runId);
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(failedRun).toMatchObject({
      status: "failed",
      leaseOwnerId: undefined,
      lastError: "Durable Chat output was emitted before interruption and cannot be safely replayed.",
      metadata: {
        linkedFinalization: expect.any(Object),
        generalChatPostCommit: expect.objectContaining({ settlementStatus: "completed" }),
        chatTurnRuntimeAuthority: expect.any(Object),
      },
    });
    expect(failedRun.metadata).not.toHaveProperty("waitForEvent");
    expect(failedRun.metadata).toMatchObject({ operatorNote: "preserve-during-restart-finalization" });
    expect(harness.storage.chatMessages.get(seeded.assistantMessageId)?.content).toBe(seeded.visiblePrefix);
    expect(harness.storage.chatTurnTraces.get(seeded.turnId)).toMatchObject({
      status: "failed",
      failure: {
        failureClass: "interrupted_by_restart",
        recommendedAction: "continue_from_partial",
      },
      completion: { status: "interrupted" },
      durable: { runId: seeded.runId, status: "failed", checkpointKind: "run_failed" },
    });
    expect(harness.storage.sessionMutationAdmissions.require(seeded.admissionId)).toMatchObject({
      status: "cancelled",
      terminalAuthorityKind: "durable_terminal",
      terminalDurableRunId: seeded.runId,
      terminalDurableRunStatus: "failed",
    });

    const nextRequest = { content: "Reply with exactly: CHAT_OK" };
    const nextAdmission = harness.storage.sessionMutationAdmissions.admit({
      workspaceId: seeded.workspaceId,
      sessionId: seeded.sessionId,
      expectedSessionIncarnationId: seeded.sessionIncarnationId,
      turnId: `${seeded.turnId}:next`,
      runtimeOwnerId: "integration:restart-next-turn",
      admissionKind: "turn_write",
      aggregateRevision: harness.storage.chatSessionMeta.get(seeded.sessionId)!.revision,
      controllerGeneration: seeded.controllerGeneration,
      actorKind: "operator",
      actorId: "operator:restart-next-turn",
      operation: "chat_send",
      materialSha256: computeFrozenChatTurnAdmissionMaterialSha256(nextRequest),
      idempotencyKey: `admission:${seeded.turnId}:next`,
      correlationId: `${seeded.turnId}:next`,
    });
    expect(nextAdmission).toMatchObject({
      disposition: "created",
      admission: { status: "active", turnId: `${seeded.turnId}:next` },
    });
  }, 30_000);

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
      await reconcileGeneralEffects(progress);
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
          postCommitGenerationId: "generation-restart",
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
    expect(onGeneral).toHaveBeenCalledTimes(2);
    expect(listPostCommitChildren(harness.storage)).toHaveLength(3);

    firstService.stopWorker();
    harness.storage.close();
    storages.splice(storages.indexOf(harness.storage), 1);
    const restartedStorage = openStorage(harness);
    const executeWorkflow = vi.fn(async (run: DurableRunRecord) => {
      settlePostCommitChild(restartedStorage, run, "completed");
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
      await reconcileGeneralEffects(progress);
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
      settlePostCommitChild(
        restartedStorage,
        child,
        failed ? "failed" : "completed",
        failed ? "provider failed after first token" : undefined,
      );
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
    expect(restartedStorage.durableRuns.getRun(parent.runId).metadata?.generalChatPostCommit).toMatchObject({
      completedAt: expect.any(String),
    });
  });

  it("does not busy-wake the local worker while post-commit children run on another worker", async () => {
    const harness = createStorageHarness();
    const parent = seedParent(harness.storage, "generation-foreign-worker");
    const onGeneral = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      await reconcileGeneralEffects(progress);
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
    const realtime = new RealtimeEventService({
      storage: getAsyncStorage(harness.storage),
      getGatewayNodeId: () => "node-test",
    });
    const listener = vi.fn();
    realtime.subscribeRealtime(listener);
    const onGeneral = vi.fn(async (_run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => {
      await progress.publishEffect("realtime", () =>
        realtime.publishRealtime("chat_thread_updated", "chat", {
          sessionId: "session-post-commit",
          [IDEMPOTENT_REALTIME_ENVELOPE_KEY]: {
            deliveryId: `${parent.runId}:${progress.generationId}:chat-thread-updated`,
            occurredAt: progress.requestedAt,
          },
        }),
      );
      for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
        await progress.runEffect(effect, () => undefined);
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
        await progress.runEffect("capability_gap", () => undefined);
        if (progress.generationId === "generation-waiting") {
          const current = generationHarness.storage.durableRuns.getRun(generationParent.runId);
          const replacement = buildParentRuntimeTransition(generationParent.runId, "generation-completed", "completed");
          generationHarness.storage.durableRuns.updateRun({
            runId: current.runId,
            status: "completed",
            metadata: replacement.metadata,
            updatedAt: new Date().toISOString(),
            expectedVersion: current.version,
          });
          generationHarness.storage.durableRuns.createCheckpoint({
            runId: current.runId,
            checkpointKind: "run_completed",
            state: replacement.checkpointState,
          });
          generationHarness.storage.chatMessages.upsert({
            messageId: "assistant-post-commit",
            sessionId: "session-post-commit",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: replacement.outputText!,
            timestamp: "2026-07-11T00:00:00.000Z",
          });
          generationHarness.storage.chatTurnTraces.patch("turn-post-commit", {
            status: "completed",
            durable: {
              runId: generationParent.runId,
              status: "completed",
              checkpointKind: "run_completed",
            },
            finishedAt: "2026-07-11T00:00:00.000Z",
          });
          return { status: "waiting" };
        }
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
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
        await progress.runEffect("learned_memory_user", learnedMemory);
        await progress.publishEffect("realtime", () => {
          realtime();
          if (failRealtime) {
            failRealtime = false;
            throw new Error("retained stream unavailable");
          }
        });
        for (const effect of GENERAL_CHAT_POST_COMMIT_EFFECTS) {
          await progress.runEffect(effect, () => undefined);
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

async function reconcileGeneralEffects(progress: GeneralChatPostCommitProgress): Promise<void> {
  await progress.enqueueDurableEffect({
    effect: "commitments",
    sessionId: "session-post-commit",
    workspaceId: "workspace-post-commit",
    turnId: "turn-post-commit",
    autonomous: false,
  });
  await progress.enqueueDurableEffect({
    effect: "background_review",
    sessionId: "session-post-commit",
    workspaceId: "workspace-post-commit",
    turnId: "turn-post-commit",
    delegatedChild: false,
    autonomous: false,
  });
  await progress.enqueueDurableEffect({
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
      await progress.runEffect(effect, () => undefined);
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

function getAsyncStorage(storage: Storage): AsyncStorage {
  const existing = asyncStorages.get(storage);
  if (existing) return existing;
  const asyncStorage = createSqliteAsyncStorage(storage);
  asyncStorages.set(storage, asyncStorage);
  return asyncStorage;
}

function createService(
  storage: Storage,
  onGeneral?: (run: DurableRunRecord, progress: GeneralChatPostCommitProgress) => Promise<Record<string, unknown>>,
  executeWorkflow = vi.fn(async () => undefined),
): DurableRunService {
  const service = new DurableRunService(
    {
      storage: getAsyncStorage(storage),
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

function seedRunningRetainedPrefix(storage: Storage): {
  runId: string;
  admissionId: string;
  sessionIncarnationId: string;
  controllerGeneration: number;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  assistantMessageId: string;
  visiblePrefix: string;
} {
  const runId = "restart-prefix-parent";
  const now = "2026-07-30T14:00:00.000Z";
  const workspaceId = "workspace-restart-prefix";
  const sessionId = "session-restart-prefix";
  const turnId = "turn-restart-prefix";
  const userMessageId = "user-restart-prefix";
  const assistantMessageId = "assistant-restart-prefix";
  const visiblePrefix = "STREAMING_BEFORE_RESTART ";
  const request = { content: "Synthetic restart during an active provider stream proof." };
  const requestActor = { actorKind: "operator" as const, actorId: "operator:restart-prefix" };
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:${requestActor.actorId}:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: requestActor.actorId,
    timestamp: now,
  });
  const lifecycle = storage.chatSessionLifecycles.ensureActive({
    workspaceId,
    sessionId,
    actorId: requestActor.actorId,
    idempotencyKey: `lifecycle:${sessionId}`,
    correlationId: `lifecycle:${sessionId}`,
    metadataTimestamp: now,
  });
  const sessionMeta = storage.chatSessionMeta.get(sessionId)!;
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const admission = storage.sessionMutationAdmissions.admit({
    workspaceId,
    sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    turnId,
    runtimeOwnerId: `integration:${runId}`,
    admissionKind: "turn_write",
    aggregateRevision: sessionMeta.revision,
    controllerGeneration: lifecycle.generation,
    actorKind: requestActor.actorKind,
    actorId: requestActor.actorId,
    operation: "chat_send",
    materialSha256: admissionMaterialSha256,
    idempotencyKey: `admission:${runId}`,
    correlationId: `admission:${runId}`,
  }).admission;
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    admissionMaterialSha256,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
    policyRunIdDerivation: { version: 1 as const, kind: "durable_run_id" as const, runId },
    workspaceId,
    admissionAggregateRevision: admission.aggregateRevision,
    admissionControllerGeneration: admission.controllerGeneration,
    requestActor,
    sessionId,
    turnId,
    userMessageId,
    assistantMessageId,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  let run = storage.durableRuns.createRun({
    runId,
    workflowKey: "chat.turn.execute",
    status: "queued",
    maxAttempts: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
    payload,
    metadata: {
      retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
      // This is the real pre-fix persisted shape. Terminalization must remove
      // the null waiting marker before sealing checkpoint-anchored authority.
      waitForEvent: null,
      operatorNote: "preserve-during-restart-finalization",
    },
    now,
  });
  storage.sessionMutationAdmissions.bindDurableRun({
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    durableRunId: runId,
    requestRuntimeClaim: {
      runtimeOwnerId: admission.runtimeOwnerId!,
      leaseRevision: admission.runtimeLeaseRevision!,
    },
  });
  run = storage.durableRuns.updateRun({
    runId,
    status: "running",
    leaseOwnerId: buildDurableLocalProcessLeaseOwnerId({ pid: 987_660, nonce: randomUUID() }),
    leaseHeartbeatAt: now,
    leaseExpiresAt: "2099-07-30T14:02:00.000Z",
    startedAt: now,
    updatedAt: now,
    expectedVersion: run.version,
  });
  storage.durableRuns.createCheckpoint({
    runId,
    checkpointKind: "run_started",
    state: { workflowKey: run.workflowKey, status: "running" },
    createdAt: now,
  });
  storage.chatMessages.upsert({
    messageId: userMessageId,
    sessionId,
    role: "user",
    actorType: "user",
    actorId: requestActor.actorId,
    content: request.content,
    timestamp: now,
  });
  storage.chatTurnTraces.create({
    turnId,
    sessionId,
    userMessageId,
    assistantMessageId,
    status: "running",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "off",
    routing: {},
    durable: { runId, status: "running", checkpointKind: "run_started" },
    startedAt: now,
  });
  storage.chatStreamEvents.append({
    eventId: "restart-prefix-message-start",
    sessionId,
    turnId,
    runId,
    sequence: 1,
    chunkType: "message_start",
    payload: { type: "message_start", sessionId, turnId, messageId: assistantMessageId },
    createdAt: now,
  });
  storage.chatStreamEvents.append({
    eventId: "restart-prefix-visible-delta",
    sessionId,
    turnId,
    runId,
    sequence: 2,
    chunkType: "delta",
    payload: { type: "delta", sessionId, turnId, messageId: assistantMessageId, delta: visiblePrefix },
    createdAt: "2026-07-30T14:00:00.001Z",
  });
  return {
    runId,
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    controllerGeneration: lifecycle.generation,
    workspaceId,
    sessionId,
    turnId,
    assistantMessageId,
    visiblePrefix,
  };
}

function seedParent(
  storage: Storage,
  generationId: string,
  status: DurableRunRecord["status"] = "completed",
): DurableRunRecord {
  const runId = `parent-${generationId}`;
  const now = "2026-07-11T00:00:00.000Z";
  const workspaceId = "workspace-post-commit";
  const sessionId = "session-post-commit";
  const turnId = "turn-post-commit";
  const userMessageId = "user-post-commit";
  const assistantMessageId = "assistant-post-commit";
  const request = { content: "Please follow up tomorrow." };
  const requestActor = { actorKind: "operator" as const, actorId: "operator:post-commit" };
  const lifecycle = storage.chatSessionLifecycles.ensureActive({
    workspaceId,
    sessionId,
    actorId: requestActor.actorId,
    idempotencyKey: `lifecycle:${sessionId}`,
    correlationId: `lifecycle:${sessionId}`,
    metadataTimestamp: now,
  });
  const sessionMeta = storage.chatSessionMeta.get(sessionId)!;
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const admission = storage.sessionMutationAdmissions.admit({
    workspaceId,
    sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    turnId,
    runtimeOwnerId: `integration:${runId}`,
    admissionKind: "turn_write",
    aggregateRevision: sessionMeta.revision,
    controllerGeneration: lifecycle.generation,
    actorKind: requestActor.actorKind,
    actorId: requestActor.actorId,
    operation: "chat_send",
    materialSha256: admissionMaterialSha256,
    idempotencyKey: `admission:${runId}`,
    correlationId: `admission:${runId}`,
  }).admission;
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    admissionMaterialSha256,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
    workspaceId,
    admissionAggregateRevision: admission.aggregateRevision,
    admissionControllerGeneration: admission.controllerGeneration,
    requestActor,
    sessionId,
    turnId,
    userMessageId,
    assistantMessageId,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  const transition = buildParentRuntimeTransition(runId, generationId, status);
  let run = storage.durableRuns.createRun({
    runId,
    workflowKey: "chat.turn.execute",
    status: "queued",
    maxAttempts: DURABLE_RETRY_POLICY_DEFAULT.maxAttempts,
    payload,
    metadata: { retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT } },
    now,
  });
  storage.sessionMutationAdmissions.bindDurableRun({
    admissionId: admission.admissionId,
    sessionIncarnationId: admission.sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    durableRunId: runId,
    requestRuntimeClaim: {
      runtimeOwnerId: admission.runtimeOwnerId!,
      leaseRevision: admission.runtimeLeaseRevision!,
    },
  });
  run = storage.durableRuns.updateRun({
    runId,
    status,
    metadata: transition.metadata,
    updatedAt: now,
    ...(status === "completed" ? { finishedAt: now } : {}),
    expectedVersion: run.version,
  });
  storage.durableRuns.createCheckpoint({
    runId,
    checkpointKind: status === "waiting" ? "run_waiting" : "run_completed",
    state: transition.checkpointState,
    createdAt: now,
  });
  if (status === "completed") {
    storage.chatMessages.upsert({
      messageId: assistantMessageId,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: transition.outputText!,
      timestamp: now,
    });
  }
  storage.chatTurnTraces.create({
    turnId,
    sessionId,
    userMessageId,
    assistantMessageId,
    status: status === "waiting" ? "waiting_for_approval" : "completed",
    mode: "chat",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    routing: {},
    durable: {
      runId,
      status,
      checkpointKind: status === "waiting" ? "run_waiting" : "run_completed",
    },
    startedAt: now,
    ...(status === "completed"
      ? {
          finishedAt: now,
          completion: { status: "complete", repaired: false, repair: { applied: false } },
        }
      : {}),
  });
  return run;
}

function pendingMetadata(generationId: string, traceStatus: string): Record<string, unknown> {
  return {
    generalChatPostCommitPending: {
      version: 1,
      generationId,
      traceStatus,
      requestedAt: "2026-07-11T00:00:00.000Z",
      postCommitEligibility: {
        version: 1,
        autonomyEnabledAtParentSettlement: true,
        evalIntegrityTurn: false,
        humanSession: true,
      },
      completedEffects: [],
      durableEffectRunIds: {},
    },
  };
}

function buildParentRuntimeTransition(
  runId: string,
  generationId: string,
  status: DurableRunRecord["status"],
): { metadata: Record<string, unknown>; checkpointState: Record<string, unknown>; outputText?: string } {
  const waiting = status === "waiting";
  const traceStatus = waiting ? "waiting_for_approval" : "completed";
  const pending = pendingMetadata(generationId, traceStatus);
  const marker = pending.generalChatPostCommitPending as Record<string, unknown>;
  const transitionAt = String(marker.requestedAt);
  const postCommitEligibility = marker.postCommitEligibility as never;
  const waitForEvent = { eventKey: "approval.resolved", correlationId: `approval:${generationId}` };
  const outputText = "Post-commit parent output";
  const authority = buildChatTurnRuntimeAuthoritySeal({
    runId,
    turnId: "turn-post-commit",
    transitionKind: waiting ? "waiting" : "terminal",
    durableStatus: waiting ? "waiting" : "completed",
    traceStatus,
    transitionAt,
    postCommitGenerationId: generationId,
    postCommitEligibility,
    ...(waiting ? { waitForEvent } : {}),
    ...(!waiting
      ? {
          terminalOutput: {
            assistantMessageId: "assistant-post-commit",
            outputText,
            outputSummary: outputText,
          },
        }
      : {}),
    requiredFinalizers: ["general"],
  });
  const metadata = withChatTurnRuntimeAuthority(
    {
      ...pending,
      retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT },
      ...(waiting
        ? { waitForEvent }
        : {
            outputText,
            finalOutput: outputText,
            outputSummary: outputText,
            finalSummary: outputText,
          }),
    },
    authority,
  );
  const checkpointState = withChatTurnRuntimeAuthorityCheckpoint(
    waiting
      ? { waitForEvent }
      : {
          assistantMessageId: "assistant-post-commit",
          outputText,
          outputSummary: outputText,
        },
    authority,
  );
  return { metadata, checkpointState, ...(waiting ? {} : { outputText }) };
}

function listPostCommitChildren(storage: Storage): DurableRunRecord[] {
  return storage.durableRuns.listRuns(100).filter((run) => run.workflowKey === "chat.post_commit.effect");
}

function settlePostCommitChild(
  storage: Storage,
  observed: DurableRunRecord,
  status: "completed" | "failed",
  lastError?: string,
): DurableRunRecord {
  let claimed = storage.durableRuns.getRun(observed.runId);
  if (claimed.status === "queued") {
    const workerId = `integration-worker:${claimed.runId}`;
    claimed =
      storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
        runId: claimed.runId,
        workerId,
        leaseDurationMs: 60_000,
      }) ??
      (() => {
        throw new Error(`Could not claim post-commit child ${claimed.runId}`);
      })();
  }
  if (claimed.status !== "running" || !claimed.leaseOwnerId) {
    throw new Error(`Post-commit child ${claimed.runId} does not hold a live execution lease`);
  }
  const payload = claimed.payload as unknown as GeneralChatPostCommitEffectWorkflowPayload;
  const stage =
    payload.effect === "commitments"
      ? "commitments_write"
      : payload.effect === "background_review"
        ? "background_evidence"
        : "memory_maintenance_evaluation";
  storage.sessionMutationAdmissions.runPostCommitChildStage(
    {
      childAdmission: payload.childAdmission,
      parentRunId: payload.parentRunId,
      postCommitGenerationId: payload.postCommitGenerationId,
      effect: payload.effect,
      childRunId: claimed.runId,
      sourceTurnId: payload.input.turnId,
      postCommitEligibility: payload.postCommitEligibility,
      stage,
      terminal: true,
      durableClaim: {
        durableRunId: claimed.runId,
        leaseOwnerId: claimed.leaseOwnerId,
        attemptCount: claimed.attemptCount,
      },
    },
    () => ({
      disposition: status === "completed" ? "allowed" : "late_blocked",
      value: undefined,
    }),
  );
  const now = new Date().toISOString();
  return storage.runImmediateTransaction(() => {
    const current = storage.durableRuns.getRunForUpdate(claimed.runId);
    return storage.durableRuns.updateRun({
      runId: current.runId,
      status,
      finishedAt: now,
      ...(lastError ? { lastError } : { clearLastError: true }),
      clearLease: true,
      updatedAt: now,
      expectedVersion: current.version,
    });
  });
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

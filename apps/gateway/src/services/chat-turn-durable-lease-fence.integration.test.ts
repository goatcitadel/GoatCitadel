import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventIngestService, resolveSessionRoute } from "@goatcitadel/gateway-core";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import {
  buildDurableChatCanonicalWriteFence,
  executePreparedAgentChatTurnBackground,
  type ChatTurnDispatchHost,
} from "./chat-turn-dispatch-service.js";
import { ChatSteerService } from "./chat-steer-service.js";
import { ChatTurnExecutionRegistry } from "./chat-turn-execution-registry.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("durable Chat canonical write lease fence", () => {
  it("rolls back canonical writes when the database lease expires during the fenced work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-lease-expiry-"));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    cleanups.push(() => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const runId = "run-expire-during-write";
    const leaseOwnerId = "worker-expiring";
    const now = new Date();
    storage.durableRuns.createRun({
      runId,
      workflowKey: "chat.turn.execute",
      status: "running",
      startedAt: now.toISOString(),
      leaseOwnerId,
      leaseHeartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + 1_000).toISOString(),
      now: now.toISOString(),
    });
    const asyncStorage = createSqliteAsyncStorage(storage);
    const lockFreshActiveLeaseForUpdate = vi.spyOn(storage.durableRuns, "lockFreshActiveLeaseForUpdate");
    const fence = buildDurableChatCanonicalWriteFence(
      // HX-411: the fence asserts the turn's immutable admission is still active
      // before/after the fenced work. The admission stays active here; only the
      // durable database lease expires, which is what this test exercises.
      {
        storage: asyncStorage,
        sessionControlRuntimeOwner: { assertActiveTurnWrite: vi.fn() },
      } as unknown as ChatTurnDispatchHost,
      {
        turnId: "turn-expire-during-write",
        turnAdmission: {
          identity: {
            admissionId: "admission-expire-during-write",
            sessionIncarnationId: "incarnation-expire-during-write",
            workspaceId: "default",
            sessionId: "session-expired-write",
            turnId: "turn-expire-during-write",
            aggregateRevision: 1,
            controllerGeneration: 1,
            materialSha256: "a".repeat(64),
          },
          requestActor: { actorKind: "operator", actorId: "operator" },
        },
      } as never,
      runId,
      {
        streamRegistration: { requireActive: vi.fn() } as never,
        durableLeaseOwnerId: leaseOwnerId,
      },
    );

    await expect(
      fence?.(async () => {
        await asyncStorage.chatMessages.upsert({
          messageId: "assistant-expired-write",
          sessionId: "session-expired-write",
          role: "assistant",
          actorType: "agent",
          actorId: "assistant",
          content: "must roll back",
          timestamp: now.toISOString(),
        });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, 1_200);
      }),
    ).rejects.toThrow(/lease.*no longer active/i);

    expect(lockFreshActiveLeaseForUpdate).toHaveBeenCalledTimes(2);
    expect(storage.chatMessages.get("assistant-expired-write")).toBeUndefined();
  });

  it("rolls back stale worker assistant, trace, and leaf writes after lease takeover", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-lease-fence-"));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    cleanups.push(() => {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const route = { channel: "mission", account: "operator", peer: "lease-fence" };
    const sessionId = resolveSessionRoute(route).sessionId;
    const turnId = "turn-lease-fence";
    const parentTurnId = "turn-parent";
    const assistantMessageId = "assistant-lease-fence";
    const runId = "run-lease-fence";
    const now = new Date();
    const heartbeatAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    storage.durableRuns.createRun({
      runId,
      workflowKey: "chat.turn.execute",
      status: "running",
      startedAt: heartbeatAt,
      leaseOwnerId: "worker-a",
      leaseHeartbeatAt: heartbeatAt,
      leaseExpiresAt: expiresAt,
      now: heartbeatAt,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId,
      userMessageId: "user-lease-fence",
      parentTurnId,
      branchKind: "append",
      status: "running",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      effectiveToolAutonomy: "manual",
      routing: {},
      startedAt: heartbeatAt,
    });
    storage.chatSessionBranchState.setActiveLeaf(sessionId, parentTurnId, heartbeatAt);
    const asyncStorage = createSqliteAsyncStorage(storage);

    const eventIngest = new EventIngestService(asyncStorage);
    const lockFreshActiveLeaseForUpdate = vi.spyOn(storage.durableRuns, "lockFreshActiveLeaseForUpdate");
    const lockActiveLeaseForUpdate = vi.spyOn(storage.durableRuns, "lockActiveLeaseForUpdate");
    const streamRegistry = new ChatTurnExecutionRegistry();
    const streamRegistration = streamRegistry.registerActiveStream(sessionId, turnId, 0, runId);
    const persistChatStreamChunk = vi.fn();
    const finalizeDurableChatRun = vi.fn();
    const markChatTurnCancelled = vi.fn();
    let transferred = false;
    const host = {
      storage: asyncStorage,
      config: {
        assistant: {
          durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true },
        },
      },
      backgroundTasks: new Set<Promise<void>>(),
      turnRuntime: {
        runStream: vi.fn(async function* () {
          yield {
            type: "message_done",
            sessionId,
            turnId,
            messageId: assistantMessageId,
            content: "Stale worker A answer must never commit.",
          };
        }),
      },
      hooksService: {
        runInlineHooks: vi.fn(async () => ({ runs: [] })),
        enqueueAfterHooks: vi.fn(),
      },
      steerService: new ChatSteerService(),
      beginActiveChatTurnExecution: vi.fn(() => new AbortController()),
      endActiveChatTurnExecution: vi.fn(),
      getActiveChatTurnExecution: vi.fn(),
      markChatTurnCancelled,
      resolvePreparedTurnOrchestration: vi.fn(async () => undefined),
      createChatCompletion: vi.fn(),
      recordDevDiagnostic: vi.fn(),
      buildChatOrchestrationSummary: vi.fn(),
      createChatSession: vi.fn(),
      inheritDelegatedSessionToolGrants: vi.fn(),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(),
      agentSendChatMessageStream: vi.fn(),
      isFeatureEnabled: vi.fn(() => false),
      ingestEvent: vi.fn(async (idempotencyKey, payload, options) => {
        if (!transferred) {
          transferred = true;
          const current = await asyncStorage.durableRuns.getRun(runId);
          const takeoverAt = new Date().toISOString();
          await asyncStorage.durableRuns.updateRun({
            runId,
            status: "running",
            leaseOwnerId: "worker-b",
            leaseHeartbeatAt: takeoverAt,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            expectedVersion: current.version,
            updatedAt: takeoverAt,
          });
        }
        return eventIngest.ingest({
          endpoint: "/api/v1/gateway/events",
          idempotencyKey,
          payload,
          ...(options?.onCommit ? { onCommit: options.onCommit } : {}),
        });
      }),
      updateActiveLeafOrThrow: vi.fn(async (nextSessionId, expectedLeaf, nextLeaf) => {
        const updated = await asyncStorage.chatSessionBranchState.setActiveLeafIfCurrent(
          nextSessionId,
          expectedLeaf,
          nextLeaf,
          new Date().toISOString(),
        );
        if (!updated) throw new Error("active leaf changed");
      }),
      collectCapabilityUpgradeSuggestions: vi.fn(async () => []),
      collectSpecialistCandidateSuggestions: vi.fn(() => []),
      publishRealtime: vi.fn(),
      extractAndPersistLearnedMemory: vi.fn(),
      recordTurnCommitments: vi.fn(),
      recordCapabilityGapFromTrace: vi.fn(),
      scheduleChatMemoryContextPrewarm: vi.fn(),
      scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
      scheduleBackgroundReviewIfDue: vi.fn(),
      persistChatStreamChunk,
      createHydratedChatTurnTrace: vi.fn((_turnId, trace) => trace),
      registerActiveChatTurnStream: vi.fn(),
      streamPersistedChatTurnEvents: vi.fn(),
      withEphemeralStreamEnvelope: vi.fn(),
      closeActiveChatTurnStream: vi.fn(),
      completeActiveChatTurnStream: vi.fn(),
      beginDurableChatRun: vi.fn(),
      finalizeDurableChatRun,
      commsSend: vi.fn(),
      ensureSessionInternalToolGrant: vi.fn(),
      requireExecutedToolResult: vi.fn(),
      // HX-411: the canonical-write fence asserts the immutable turn admission is
      // still active. It remains active through the takeover; the durable lease is
      // what is superseded here.
      sessionControlRuntimeOwner: { assertActiveTurnWrite: vi.fn() },
    } as unknown as ChatTurnDispatchHost;
    const prepared = {
      session: { sessionId },
      turnId,
      userEventId: "user-lease-fence",
      assistantMessageId,
      parentTurnId,
      branchKind: "append",
      content: "answer once",
      route,
      normalized: { mode: "chat", webMode: "off", memoryMode: "off", thinkingLevel: "standard" },
      prefs: {
        mode: "chat",
        providerId: "fake",
        model: "fake-model",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      autonomy: { proactiveMode: "off", retrievalMode: "off" },
      effectiveToolAutonomy: "manual",
      workspaceId: "default",
      resolvedGuidance: { globalFilesUsed: [], workspaceFilesUsed: [], truncated: false },
      modelRouterDecision: {},
      userMessage: { messageId: "user-lease-fence" },
      turnAdmission: {
        identity: {
          admissionId: "admission-lease-fence",
          sessionIncarnationId: "incarnation-lease-fence",
          workspaceId: "default",
          sessionId,
          turnId,
          aggregateRevision: 1,
          controllerGeneration: 1,
          materialSha256: "a".repeat(64),
        },
        requestActor: { actorKind: "operator", actorId: "operator" },
      },
    } as never;

    await expect(
      executePreparedAgentChatTurnBackground(
        host,
        sessionId,
        { content: "answer once", mode: "chat" },
        prepared,
        "chat_thread_turn_appended",
        runId,
        undefined,
        {
          streamRegistration,
          skipMessageStart: true,
          durableLeaseOwnerId: "worker-a",
        },
      ),
    ).rejects.toMatchObject({ name: "DurableWorkerInterruptionError" });

    expect(storage.durableRuns.getRun(runId)).toMatchObject({ status: "running", leaseOwnerId: "worker-b" });
    expect(lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(runId, "worker-a");
    expect(lockActiveLeaseForUpdate).not.toHaveBeenCalled();
    expect(storage.chatMessages.get(assistantMessageId)).toBeUndefined();
    expect(storage.chatTurnTraces.get(turnId)).toMatchObject({ status: "running", assistantMessageId: undefined });
    expect(storage.chatSessionBranchState.get(sessionId)?.activeLeafTurnId).toBe(parentTurnId);
    expect(finalizeDurableChatRun).not.toHaveBeenCalled();
    expect(markChatTurnCancelled).not.toHaveBeenCalled();
    expect(persistChatStreamChunk).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
      expect.anything(),
      expect.anything(),
    );
    expect(persistChatStreamChunk).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "message_done" }),
      expect.anything(),
      expect.anything(),
    );
  });
});

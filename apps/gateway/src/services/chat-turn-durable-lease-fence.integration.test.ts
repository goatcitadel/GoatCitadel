import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventIngestService, resolveSessionRoute } from "@goatcitadel/gateway-core";
import { Storage } from "@goatcitadel/storage";
import { executePreparedAgentChatTurnBackground, type ChatTurnDispatchHost } from "./chat-turn-dispatch-service.js";
import { ChatSteerService } from "./chat-steer-service.js";
import { ChatTurnExecutionRegistry } from "./chat-turn-execution-registry.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("durable Chat canonical write lease fence", () => {
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

    const eventIngest = new EventIngestService(storage);
    const streamRegistry = new ChatTurnExecutionRegistry();
    const streamRegistration = streamRegistry.registerActiveStream(sessionId, turnId, 0, runId);
    const persistChatStreamChunk = vi.fn();
    const finalizeDurableChatRun = vi.fn();
    const markChatTurnCancelled = vi.fn();
    let transferred = false;
    const host = {
      storage,
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
          const current = storage.durableRuns.getRun(runId);
          const takeoverAt = new Date().toISOString();
          storage.durableRuns.updateRun({
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
      updateActiveLeafOrThrow: vi.fn((nextSessionId, expectedLeaf, nextLeaf) => {
        const updated = storage.chatSessionBranchState.setActiveLeafIfCurrent(
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

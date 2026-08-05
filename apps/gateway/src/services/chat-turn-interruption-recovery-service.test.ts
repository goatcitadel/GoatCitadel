import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ChatMessageRecord, ChatTurnTraceCreateInput } from "@goatcitadel/contracts";
import { TOOL_EFFECT_CLASSIFICATION_VERSION } from "@goatcitadel/contracts";
import {
  INTERRUPTED_BY_RESTART_MESSAGE,
  reconcileInterruptedDurableChatTurn,
  reconcileInterruptedChatTurns,
  type ChatTurnInterruptionRecoveryDeps,
} from "./chat-turn-interruption-recovery-service.js";

const createdRoots: string[] = [];
const openStorages: Storage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) {
    try {
      storage.close();
    } catch {
      // ignore
    }
  }
  for (const root of createdRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function createStorage(): Storage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-turn-interruption-"));
  createdRoots.push(root);
  const dataDir = path.join(root, "data");
  const transcriptsDir = path.join(dataDir, "transcripts");
  const auditDir = path.join(dataDir, "audit");
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(dataDir, "goatcitadel.db"),
    transcriptsDir,
    auditDir,
  });
  openStorages.push(storage);
  return storage;
}

function buildDeps(storage: Storage): ChatTurnInterruptionRecoveryDeps & {
  publishRealtime: ReturnType<typeof vi.fn>;
  recordDevDiagnostic: ReturnType<typeof vi.fn>;
} {
  return {
    storage: createSqliteAsyncStorage(storage),
    publishRealtime: vi.fn(async () => undefined),
    recordDevDiagnostic: vi.fn(),
    now: () => "2026-07-07T20:00:00.000Z",
  };
}

function seedSession(storage: Storage, sessionId = "session-a"): void {
  storage.sessions.upsert({
    sessionId,
    sessionKey: `mission:operator:${sessionId}`,
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: "2026-07-07T19:45:00.000Z",
  });
}

function appendStreamChunk(
  storage: Storage,
  sequence: number,
  payload: Record<string, unknown>,
  runId?: string,
  ids: { sessionId?: string; turnId?: string; eventSuffix?: string } = {},
): void {
  const sessionId = ids.sessionId ?? "session-a";
  const turnId = ids.turnId ?? "turn-active";
  storage.chatStreamEvents.append({
    eventId: `stream-event-${ids.eventSuffix ?? "default"}-${sequence}`,
    sessionId,
    turnId,
    sequence,
    runId,
    chunkType: typeof payload.type === "string" ? payload.type : "unknown",
    payload,
    createdAt: `2026-07-07T19:46:${20 + sequence}.000Z`,
  });
}

function userMessage(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    messageId: "msg-user",
    sessionId: "session-a",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content: "please do the thing",
    timestamp: "2026-07-07T19:46:19.000Z",
    ...overrides,
  };
}

function activeTrace(overrides: Partial<ChatTurnTraceCreateInput> = {}): ChatTurnTraceCreateInput {
  return {
    turnId: "turn-active",
    sessionId: "session-a",
    userMessageId: "msg-user",
    status: "running",
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    startedAt: "2026-07-07T19:46:20.000Z",
    ...overrides,
  };
}

describe("reconcileInterruptedChatTurns", () => {
  it("fails a stranded running trace with an interrupted_by_restart failure", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace());
    const deps = buildDeps(storage);

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual(["turn-active"]);
    expect(result.synthesizedTurnIds).toEqual([]);
    const trace = storage.chatTurnTraces.get("turn-active");
    expect(trace.status).toBe("failed");
    expect(trace.failure).toMatchObject({
      failureClass: "interrupted_by_restart",
      message: INTERRUPTED_BY_RESTART_MESSAGE,
      retryable: true,
      recommendedAction: "retry",
    });
    expect(trace.completion).toMatchObject({ status: "interrupted", repaired: false });
    expect(trace.finishedAt).toBe("2026-07-07T20:00:00.000Z");
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.objectContaining({
        type: "chat_thread_turn_interrupted",
        sessionId: "session-a",
        turnId: "turn-active",
      }),
      expect.anything(),
    );
  });

  it("clears stale pendingUserInput when failing a waiting_for_user_input trace", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create({
      ...activeTrace({ status: "waiting_for_user_input" }),
      pendingUserInput: {
        promptId: "prompt-1",
        question: "Which environment?",
        createdAt: "2026-07-07T19:46:25.000Z",
      } as never,
    });
    const deps = buildDeps(storage);

    await reconcileInterruptedChatTurns(deps);

    const trace = storage.chatTurnTraces.get("turn-active");
    expect(trace.status).toBe("failed");
    expect(trace.pendingUserInput).toBeUndefined();
  });

  it("is a no-op when run a second time after a reconciling boot", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace());
    storage.chatMessages.upsert(userMessage({ sessionId: "session-orphan", messageId: "msg-orphan" }));
    const first = await reconcileInterruptedChatTurns(buildDeps(storage));
    expect(first.interruptedTurnIds).toHaveLength(1);
    expect(first.synthesizedTurnIds).toHaveLength(1);

    const secondDeps = buildDeps(storage);
    const second = await reconcileInterruptedChatTurns(secondDeps);

    expect(second.interruptedTurnIds).toEqual([]);
    expect(second.synthesizedTurnIds).toEqual([]);
    expect(second.skippedDurableOwnedTurnIds).toEqual([]);
    expect(secondDeps.publishRealtime).not.toHaveBeenCalled();
  });

  it("skips active traces owned by a live durable run (durable boot recovery owns them)", async () => {
    const storage = createStorage();
    const run = storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "running",
    });
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create({
      ...activeTrace(),
      durable: { runId: run.runId, status: "running" },
    });
    const deps = buildDeps(storage);

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual([]);
    expect(result.skippedDurableOwnedTurnIds).toEqual(["turn-active"]);
    expect(storage.chatTurnTraces.get("turn-active").status).toBe("running");
  });

  it("fails an active trace whose durable run already reached a terminal status", async () => {
    const storage = createStorage();
    const run = storage.durableRuns.createRun({
      workflowKey: "chat.turn.execute",
      status: "running",
    });
    storage.durableRuns.updateRun({ runId: run.runId, status: "failed" });
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create({
      ...activeTrace(),
      durable: { runId: run.runId, status: "running" },
    });
    const deps = buildDeps(storage);

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual(["turn-active"]);
    expect(storage.chatTurnTraces.get("turn-active").status).toBe("failed");
  });

  it("preserves retained deltas as an interrupted partial prefix and enqueues them exactly once", async () => {
    const storage = createStorage();
    seedSession(storage);
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace({ assistantMessageId: "msg-assistant" }));
    appendStreamChunk(storage, 1, {
      type: "message_start",
      sessionId: "session-a",
      turnId: "turn-active",
      messageId: "msg-assistant",
    });
    appendStreamChunk(storage, 2, {
      type: "delta",
      sessionId: "session-a",
      turnId: "turn-active",
      messageId: "msg-assistant",
      delta: "completed prefix",
    });

    const first = await reconcileInterruptedChatTurns(buildDeps(storage));

    expect(first.preservedPartialTurnIds).toEqual(["turn-active"]);
    expect(first.restoredFinalTurnIds).toEqual([]);
    expect(first.transcriptEventsEnqueued).toBe(1);
    expect(storage.chatMessages.get("msg-assistant")?.content).toBe("completed prefix");
    expect(storage.chatTurnTraces.get("turn-active")).toMatchObject({
      status: "partial",
      failure: {
        failureClass: "interrupted_by_restart",
        recommendedAction: "continue_from_partial",
      },
      completion: { status: "interrupted" },
    });
    expect(storage.transcriptOutbox.get("msg-assistant")?.event.payload).toMatchObject({
      message: { messageId: "msg-assistant", content: "completed prefix" },
    });

    const second = await reconcileInterruptedChatTurns(buildDeps(storage));
    expect(second.transcriptEventsEnqueued).toBe(0);
    const third = await reconcileInterruptedChatTurns(buildDeps(storage));
    expect(third.transcriptEventsEnqueued).toBe(0);
    expect(storage.transcriptOutbox.listPending(10)).toHaveLength(1);
    expect(storage.chatTurnTraces.get("turn-active")).toMatchObject({
      status: "partial",
      completion: { status: "interrupted" },
    });
    expect(storage.transcriptOutbox.get("msg-assistant")?.event.payload).toMatchObject({
      message: { content: "completed prefix" },
    });
  });

  it("preserves an exact durable prefix while keeping the authority-compatible terminal failed trace", async () => {
    const storage = createStorage();
    seedSession(storage);
    const created = storage.durableRuns.createRun({ workflowKey: "chat.turn.execute", status: "running" });
    storage.durableRuns.updateRun({ runId: created.runId, status: "failed", clearLease: true });
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(
      activeTrace({
        assistantMessageId: "msg-assistant",
        durable: { runId: created.runId, status: "running" },
      }),
    );
    appendStreamChunk(
      storage,
      1,
      {
        type: "message_start",
        sessionId: "session-a",
        turnId: "turn-active",
        messageId: "msg-assistant",
      },
      created.runId,
    );
    appendStreamChunk(
      storage,
      2,
      {
        type: "delta",
        sessionId: "session-a",
        turnId: "turn-active",
        messageId: "msg-assistant",
        delta: "STREAMING_BEFORE_RESTART ",
      },
      created.runId,
    );

    const result = await reconcileInterruptedDurableChatTurn(buildDeps(storage), {
      runId: created.runId,
      turnId: "turn-active",
    });

    expect(result.preservedPartialTurnIds).toEqual(["turn-active"]);
    expect(result.transcriptEventsEnqueued).toBe(1);
    expect(storage.chatMessages.get("msg-assistant")?.content).toBe("STREAMING_BEFORE_RESTART ");
    expect(storage.chatTurnTraces.get("turn-active")).toMatchObject({
      status: "failed",
      failure: {
        failureClass: "interrupted_by_restart",
        recommendedAction: "continue_from_partial",
      },
      completion: { status: "interrupted" },
      durable: { runId: created.runId, status: "running" },
    });
    expect(storage.transcriptOutbox.get("msg-assistant")?.event.payload).toMatchObject({
      message: { content: "STREAMING_BEFORE_RESTART " },
    });
  });

  it("bounds a recovered prefix on complete UTF-8 code points", async () => {
    const storage = createStorage();
    seedSession(storage);
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace({ assistantMessageId: "msg-assistant" }));
    appendStreamChunk(storage, 1, {
      type: "delta",
      sessionId: "session-a",
      turnId: "turn-active",
      messageId: "msg-assistant",
      delta: "😀".repeat(40_000),
    });

    await reconcileInterruptedChatTurns(buildDeps(storage));

    const content = storage.chatMessages.get("msg-assistant")!.content;
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(content).toContain("...[recovered prefix truncated]");
    expect(content).not.toContain("�");
  });

  it("does not downgrade persisted recovery when realtime diagnostics fail", async () => {
    const storage = createStorage();
    seedSession(storage);
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace({ assistantMessageId: "msg-assistant" }));
    appendStreamChunk(storage, 1, {
      type: "delta",
      sessionId: "session-a",
      turnId: "turn-active",
      messageId: "msg-assistant",
      delta: "durably recovered prefix",
    });
    const deps = buildDeps(storage);
    deps.publishRealtime.mockRejectedValue(new Error("observer failure sk-proj-1234567890abcdefghijklmnopqrstuvwxyz"));

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.preservedPartialTurnIds).toEqual(["turn-active"]);
    expect(result.interruptedTurnIds).toEqual([]);
    expect(storage.chatTurnTraces.get("turn-active")).toMatchObject({
      status: "partial",
      completion: { status: "interrupted" },
    });
    expect(storage.chatMessages.get("msg-assistant")?.content).toBe("durably recovered prefix");
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.turn.interruption_recovery_notification_failed",
        message: expect.not.stringContaining("sk-proj-1234567890abcdefghijklmnopqrstuvwxyz"),
      }),
    );
  });

  it("isolates a failed recovery write so later turns still reconcile", async () => {
    const storage = createStorage();
    seedSession(storage, "session-a");
    seedSession(storage, "session-b");
    storage.chatMessages.upsert(userMessage({ messageId: "msg-user-a", sessionId: "session-a" }));
    storage.chatMessages.upsert(userMessage({ messageId: "msg-user-b", sessionId: "session-b" }));
    storage.chatTurnTraces.create(
      activeTrace({
        turnId: "turn-a",
        sessionId: "session-a",
        userMessageId: "msg-user-a",
        assistantMessageId: "msg-a",
      }),
    );
    storage.chatTurnTraces.create(
      activeTrace({
        turnId: "turn-b",
        sessionId: "session-b",
        userMessageId: "msg-user-b",
        assistantMessageId: "msg-b",
      }),
    );
    appendStreamChunk(
      storage,
      1,
      { type: "delta", sessionId: "session-a", turnId: "turn-a", messageId: "msg-a", delta: "first" },
      undefined,
      { sessionId: "session-a", turnId: "turn-a", eventSuffix: "a" },
    );
    appendStreamChunk(
      storage,
      1,
      { type: "delta", sessionId: "session-b", turnId: "turn-b", messageId: "msg-b", delta: "second" },
      undefined,
      { sessionId: "session-b", turnId: "turn-b", eventSuffix: "b" },
    );
    const deps = buildDeps(storage);
    const asyncStorage = deps.storage;
    const realSessions = storage.sessions;
    deps.storage = {
      chatTurnTraces: asyncStorage.chatTurnTraces,
      chatToolRuns: asyncStorage.chatToolRuns,
      chatTurnRecovery: asyncStorage.chatTurnRecovery,
      chatSessionPrefs: asyncStorage.chatSessionPrefs,
      chatSessionBranchState: asyncStorage.chatSessionBranchState,
      chatMessages: asyncStorage.chatMessages,
      chatStreamEvents: asyncStorage.chatStreamEvents,
      sessions: {
        async getBySessionId(sessionId: string) {
          if (sessionId === "session-a") {
            throw new Error("synthetic session lookup failure sk-proj-1234567890abcdefghijklmnopqrstuvwxyz");
          }
          return realSessions.getBySessionId(sessionId);
        },
      } as ChatTurnInterruptionRecoveryDeps["storage"]["sessions"],
      transcriptOutbox: asyncStorage.transcriptOutbox,
      durableRuns: asyncStorage.durableRuns,
      runImmediateTransaction: asyncStorage.runImmediateTransaction,
    } as ChatTurnInterruptionRecoveryDeps["storage"];

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toContain("turn-a");
    expect(result.preservedPartialTurnIds).toEqual(["turn-b"]);
    expect(storage.chatTurnTraces.get("turn-a").status).toBe("failed");
    expect(storage.chatTurnTraces.get("turn-b").status).toBe("partial");
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-a",
        message: expect.not.stringContaining("sk-proj-1234567890abcdefghijklmnopqrstuvwxyz"),
      }),
    );
  });

  it("does not promote a retained message_done projection without durable terminal-output proof", async () => {
    const storage = createStorage();
    seedSession(storage);
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace({ assistantMessageId: "msg-assistant" }));
    appendStreamChunk(storage, 1, {
      type: "message_done",
      sessionId: "session-a",
      turnId: "turn-active",
      messageId: "msg-assistant",
      content: "projected final text",
    });

    const result = await reconcileInterruptedChatTurns(buildDeps(storage));

    expect(result.preservedPartialTurnIds).toEqual(["turn-active"]);
    expect(result.restoredFinalTurnIds).toEqual([]);
    expect(storage.chatTurnTraces.get("turn-active")).toMatchObject({
      status: "partial",
      completion: { status: "interrupted" },
    });
  });

  it("restores message_done only when its durable owner committed the same terminal output", async () => {
    const storage = createStorage();
    seedSession(storage);
    const run = storage.durableRuns.createRun({ workflowKey: "chat.turn.execute", status: "running" });
    storage.durableRuns.updateRun({
      runId: run.runId,
      status: "completed",
      metadata: { finalOutput: "authoritative final text" },
      finishedAt: "2026-07-07T19:46:30.000Z",
    });
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create({
      ...activeTrace({ assistantMessageId: "msg-assistant" }),
      durable: { runId: run.runId, status: "running" },
    });
    appendStreamChunk(
      storage,
      1,
      {
        type: "message_done",
        sessionId: "session-a",
        turnId: "turn-active",
        messageId: "msg-assistant",
        content: "authoritative final text",
      },
      run.runId,
    );

    const result = await reconcileInterruptedChatTurns(buildDeps(storage));

    expect(result.restoredFinalTurnIds).toEqual(["turn-active"]);
    expect(result.preservedPartialTurnIds).toEqual([]);
    expect(storage.chatTurnTraces.get("turn-active")).toMatchObject({
      status: "completed",
      completion: { status: "complete" },
    });
    expect(storage.chatMessages.get("msg-assistant")?.content).toBe("authoritative final text");
  });

  it("finds authoritative message_done after more than twenty thousand retained deltas", async () => {
    const storage = createStorage();
    seedSession(storage);
    const run = storage.durableRuns.createRun({ workflowKey: "chat.turn.execute", status: "running" });
    storage.durableRuns.updateRun({
      runId: run.runId,
      status: "completed",
      metadata: { finalOutput: "late authoritative final" },
      finishedAt: "2026-07-07T19:59:00.000Z",
    });
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create({
      ...activeTrace({ assistantMessageId: "msg-assistant-late" }),
      durable: { runId: run.runId, status: "running" },
    });
    storage.runImmediateTransaction(() => {
      appendStreamChunk(storage, 1, { type: "message_start", messageId: "msg-assistant-late" }, run.runId);
      for (let sequence = 2; sequence <= 20_002; sequence += 1) {
        appendStreamChunk(storage, sequence, { type: "delta", delta: "x" }, run.runId);
      }
      appendStreamChunk(
        storage,
        20_003,
        {
          type: "message_done",
          messageId: "msg-assistant-late",
          content: "late authoritative final",
        },
        run.runId,
      );
    });

    const result = await reconcileInterruptedChatTurns(buildDeps(storage));

    expect(result.restoredFinalTurnIds).toEqual(["turn-active"]);
    expect(storage.chatTurnTraces.get("turn-active")).toMatchObject({
      status: "completed",
      completion: { status: "complete" },
    });
    expect(storage.chatMessages.get("msg-assistant-late")?.content).toBe("late authoritative final");
  }, 30_000);

  it("drains active traces beyond one page without retrying a failing first row", async () => {
    const storage = createStorage();
    for (let index = 0; index < 501; index += 1) {
      storage.chatTurnTraces.create(
        activeTrace({
          turnId: `turn-page-${index.toString().padStart(3, "0")}`,
          userMessageId: `msg-page-${index.toString().padStart(3, "0")}`,
          startedAt: new Date(Date.parse("2026-07-07T19:00:00.000Z") + index).toISOString(),
        }),
      );
    }
    const originalPatch = storage.chatTurnTraces.patch.bind(storage.chatTurnTraces);
    vi.spyOn(storage.chatTurnTraces, "patch").mockImplementation((turnId, patch) => {
      if (turnId === "turn-page-000") {
        throw new Error("first row remains unavailable");
      }
      return originalPatch(turnId, patch);
    });
    const deps = buildDeps(storage);

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toHaveLength(500);
    expect(storage.chatTurnTraces.get("turn-page-000").status).toBe("running");
    expect(storage.chatTurnTraces.get("turn-page-500").status).toBe("failed");
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "turn-page-000", event: "chat.turn.interruption_recovery_persistence_failed" }),
    );
  });

  it("synthesizes a failed trace for an orphaned latest user message and advances the branch leaf", async () => {
    const storage = createStorage();
    // A completed prior turn holds the active leaf, mirroring a crash right
    // after the next user message persisted but before its trace was created.
    storage.chatMessages.upsert(userMessage({ messageId: "msg-prior", timestamp: "2026-07-07T18:00:00.000Z" }));
    storage.chatTurnTraces.create({
      ...activeTrace({
        turnId: "turn-prior",
        userMessageId: "msg-prior",
        status: "completed",
        startedAt: "2026-07-07T18:00:00.000Z",
        finishedAt: "2026-07-07T18:00:30.000Z",
      }),
    });
    storage.chatSessionBranchState.setActiveLeaf("session-a", "turn-prior");
    storage.chatMessages.upsert(userMessage({ messageId: "msg-orphan" }));
    const deps = buildDeps(storage);

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual([]);
    expect(result.synthesizedTurnIds).toHaveLength(1);
    const turnId = result.synthesizedTurnIds[0]!;
    const trace = storage.chatTurnTraces.get(turnId);
    expect(trace.sessionId).toBe("session-a");
    expect(trace.userMessageId).toBe("msg-orphan");
    expect(trace.parentTurnId).toBe("turn-prior");
    expect(trace.status).toBe("failed");
    expect(trace.startedAt).toBe("2026-07-07T19:46:19.000Z");
    expect(trace.finishedAt).toBe("2026-07-07T20:00:00.000Z");
    expect(trace.failure).toMatchObject({
      failureClass: "interrupted_by_restart",
      retryable: true,
      recommendedAction: "retry",
    });
    expect(trace.completion).toMatchObject({ status: "interrupted", repaired: false });
    expect(storage.chatSessionBranchState.get("session-a")?.activeLeafTurnId).toBe(turnId);
  });

  it(
    "drains orphaned user messages beyond one page and isolates a failing first orphan",
    { timeout: 60_000 },
    async () => {
      const storage = createStorage();
      for (let index = 0; index < 501; index += 1) {
        const suffix = index.toString().padStart(3, "0");
        storage.chatMessages.upsert(
          userMessage({
            sessionId: `session-orphan-page-${suffix}`,
            messageId: `msg-orphan-page-${suffix}`,
            timestamp: new Date(Date.parse("2026-07-07T19:00:00.000Z") + index).toISOString(),
          }),
        );
      }
      const originalCreate = storage.chatTurnTraces.create.bind(storage.chatTurnTraces);
      vi.spyOn(storage.chatTurnTraces, "create").mockImplementation((input) => {
        if (input.userMessageId === "msg-orphan-page-000") {
          throw new Error("first orphan cannot be synthesized");
        }
        return originalCreate(input);
      });
      const deps = buildDeps(storage);

      const result = await reconcileInterruptedChatTurns(deps);

      expect(result.synthesizedTurnIds).toHaveLength(500);
      expect(storage.chatTurnRecovery.listOrphanedLatestUserMessages(1)[0]?.messageId).toBe("msg-orphan-page-000");
      expect(
        storage.chatTurnTraces.listBySession("session-orphan-page-500").some((trace) => trace.status === "failed"),
      ).toBe(true);
      expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "chat.turn.orphan_interruption_recovery_failed",
          sessionId: "session-orphan-page-000",
        }),
      );
    },
  );

  it("redacts and UTF-8 bounds oversized interruption and orphan diagnostics", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage({ messageId: "msg-diagnostic-active" }));
    storage.chatTurnTraces.create(
      activeTrace({ turnId: "turn-diagnostic-active", userMessageId: "msg-diagnostic-active" }),
    );
    storage.chatMessages.upsert(
      userMessage({
        sessionId: "session-diagnostic-orphan",
        messageId: "msg-diagnostic-orphan",
        timestamp: "2026-07-07T19:47:00.000Z",
      }),
    );
    const syntheticToken = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
    const oversizedError = new Error(`${syntheticToken}-${"😀".repeat(20_000)}`);
    const originalPatch = storage.chatTurnTraces.patch.bind(storage.chatTurnTraces);
    vi.spyOn(storage.chatTurnTraces, "patch").mockImplementation((turnId, patch) => {
      if (turnId === "turn-diagnostic-active") {
        throw oversizedError;
      }
      return originalPatch(turnId, patch);
    });
    const originalCreate = storage.chatTurnTraces.create.bind(storage.chatTurnTraces);
    vi.spyOn(storage.chatTurnTraces, "create").mockImplementation((input) => {
      if (input.userMessageId === "msg-diagnostic-orphan") {
        throw oversizedError;
      }
      return originalCreate(input);
    });
    const deps = buildDeps(storage);

    await reconcileInterruptedChatTurns(deps);

    for (const event of [
      "chat.turn.interruption_recovery_persistence_failed",
      "chat.turn.orphan_interruption_recovery_failed",
    ]) {
      const call = deps.recordDevDiagnostic.mock.calls.find(([diagnostic]) => diagnostic.event === event);
      expect(call).toBeDefined();
      const message = (call?.[0] as { message: string }).message;
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(2 * 1024);
      expect(message).not.toContain(syntheticToken);
      expect(message).not.toContain("�");
      expect(message).toContain("...[truncated]");
    }
  });

  it("adopts session prefs for a synthesized trace when they exist", async () => {
    const storage = createStorage();
    storage.chatSessionLifecycles.initialize({
      workspaceId: "default",
      sessionId: "session-b",
      actorId: "test-fixture",
      idempotencyKey: "test:lifecycle:init:session-b",
      correlationId: "test:correlation:lifecycle:init:session-b",
    });
    storage.chatSessionPrefs.ensure("session-b");
    storage.chatSessionPrefs.patch("session-b", { mode: "cowork", thinkingLevel: "extended" });
    storage.chatMessages.upsert(userMessage({ sessionId: "session-b", messageId: "msg-orphan-b" }));
    const deps = buildDeps(storage);

    const result = await reconcileInterruptedChatTurns(deps);

    const trace = storage.chatTurnTraces.get(result.synthesizedTurnIds[0]!);
    expect(trace.mode).toBe("chat");
    expect(trace.thinkingLevel).toBe("extended");
    expect(trace.parentTurnId).toBeUndefined();
    expect(storage.chatSessionBranchState.get("session-b")?.activeLeafTurnId).toBe(trace.turnId);
  });

  it("is a no-op on a healthy database", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage({ messageId: "msg-done", timestamp: "2026-07-07T18:00:00.000Z" }));
    storage.chatTurnTraces.create({
      ...activeTrace({
        turnId: "turn-done",
        userMessageId: "msg-done",
        status: "completed",
        finishedAt: "2026-07-07T18:00:30.000Z",
      }),
    });
    storage.chatMessages.upsert(
      userMessage({
        messageId: "msg-reply",
        role: "assistant",
        actorType: "agent",
        actorId: "assistant",
        timestamp: "2026-07-07T18:00:31.000Z",
      }),
    );
    const deps = buildDeps(storage);

    const result = await reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual([]);
    expect(result.synthesizedTurnIds).toEqual([]);
    expect(result.skippedDurableOwnedTurnIds).toEqual([]);
    expect(deps.publishRealtime).not.toHaveBeenCalled();
  });

  it("settles a crash before the dispatch boundary as no effect without replay", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace());
    storage.chatToolRuns.create({
      toolRunId: "tool-before-dispatch",
      turnId: "turn-active",
      sessionId: "session-a",
      toolName: "plugin:mutate",
      status: "started",
      effectPotential: "unknown",
      effectDisposition: "none",
      effectOutcomeKind: "none",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "none",
        reason: "planned_before_dispatch",
        refs: [],
      },
      startedAt: "2026-07-07T19:46:21.000Z",
    });
    const createSpy = vi.spyOn(storage.chatToolRuns, "create");

    const result = await reconcileInterruptedChatTurns(buildDeps(storage));

    expect(result.reconciledToolRunIds).toEqual(["tool-before-dispatch"]);
    expect(result.unknownEffectToolRunIds).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(storage.chatToolRuns.get("tool-before-dispatch")).toMatchObject({
      status: "failed",
      effectPotential: "unknown",
      effectDisposition: "none",
      effectOutcomeKind: "none",
      effectEvidence: { reason: "skipped_before_dispatch", refs: [] },
      failureGuidance: expect.stringContaining("Retry is safe"),
      finishedAt: "2026-07-07T20:00:00.000Z",
    });
  });

  it("settles a crash after a possible dispatch as unknown and suppresses replay", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace());
    storage.chatToolRuns.create({
      toolRunId: "tool-after-dispatch",
      turnId: "turn-active",
      sessionId: "session-a",
      toolName: "shell.run",
      status: "started",
      effectPotential: "unknown",
      effectDisposition: "unknown",
      effectOutcomeKind: "uncertain",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "uncertain",
        reason: "dispatch_may_have_occurred",
        refs: [],
      },
      startedAt: "2026-07-07T19:46:21.000Z",
    });
    const createSpy = vi.spyOn(storage.chatToolRuns, "create");

    const result = await reconcileInterruptedChatTurns(buildDeps(storage));

    expect(result.reconciledToolRunIds).toEqual(["tool-after-dispatch"]);
    expect(result.unknownEffectToolRunIds).toEqual(["tool-after-dispatch"]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(storage.chatToolRuns.get("tool-after-dispatch")).toMatchObject({
      status: "failed",
      effectPotential: "unknown",
      effectDisposition: "unknown",
      effectOutcomeKind: "uncertain",
      effectEvidence: { reason: "interrupted_after_possible_dispatch", refs: [] },
      failureGuidance: expect.stringContaining("Inspect state before retry"),
      finishedAt: "2026-07-07T20:00:00.000Z",
    });
  });

  it("keeps a trusted built-in safe read at no effect across an interrupted executor", async () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace());
    storage.chatToolRuns.create({
      toolRunId: "tool-safe-read",
      turnId: "turn-active",
      sessionId: "session-a",
      toolName: "time.now",
      status: "started",
      effectPotential: "none",
      effectDisposition: "none",
      effectOutcomeKind: "none",
      effectEvidence: {
        version: TOOL_EFFECT_CLASSIFICATION_VERSION,
        outcomeKind: "none",
        reason: "trusted_safe_read",
        refs: [],
      },
      startedAt: "2026-07-07T19:46:21.000Z",
    });

    const result = await reconcileInterruptedChatTurns(buildDeps(storage));

    expect(result.unknownEffectToolRunIds).toEqual([]);
    expect(storage.chatToolRuns.get("tool-safe-read")).toMatchObject({
      status: "failed",
      effectPotential: "none",
      effectDisposition: "none",
      effectOutcomeKind: "none",
      effectEvidence: { reason: "trusted_safe_read", refs: [] },
    });
  });
});

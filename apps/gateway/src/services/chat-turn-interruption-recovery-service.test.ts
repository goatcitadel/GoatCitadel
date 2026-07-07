import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { ChatMessageRecord, ChatTurnTraceCreateInput } from "@goatcitadel/contracts";
import {
  INTERRUPTED_BY_RESTART_MESSAGE,
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
    storage,
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    now: () => "2026-07-07T20:00:00.000Z",
  };
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
  it("fails a stranded running trace with an interrupted_by_restart failure", () => {
    const storage = createStorage();
    storage.chatMessages.upsert(userMessage());
    storage.chatTurnTraces.create(activeTrace());
    const deps = buildDeps(storage);

    const result = reconcileInterruptedChatTurns(deps);

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

  it("skips active traces owned by a live durable run (durable boot recovery owns them)", () => {
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

    const result = reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual([]);
    expect(result.skippedDurableOwnedTurnIds).toEqual(["turn-active"]);
    expect(storage.chatTurnTraces.get("turn-active").status).toBe("running");
  });

  it("fails an active trace whose durable run already reached a terminal status", () => {
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

    const result = reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual(["turn-active"]);
    expect(storage.chatTurnTraces.get("turn-active").status).toBe("failed");
  });

  it("synthesizes a failed trace for an orphaned latest user message and advances the branch leaf", () => {
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

    const result = reconcileInterruptedChatTurns(deps);

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

  it("adopts session prefs for a synthesized trace when they exist", () => {
    const storage = createStorage();
    storage.chatSessionPrefs.ensure("session-b");
    storage.chatSessionPrefs.patch("session-b", { mode: "cowork", thinkingLevel: "extended" });
    storage.chatMessages.upsert(userMessage({ sessionId: "session-b", messageId: "msg-orphan-b" }));
    const deps = buildDeps(storage);

    const result = reconcileInterruptedChatTurns(deps);

    const trace = storage.chatTurnTraces.get(result.synthesizedTurnIds[0]!);
    expect(trace.mode).toBe("cowork");
    expect(trace.thinkingLevel).toBe("extended");
    expect(trace.parentTurnId).toBeUndefined();
    expect(storage.chatSessionBranchState.get("session-b")?.activeLeafTurnId).toBe(trace.turnId);
  });

  it("is a no-op on a healthy database", () => {
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

    const result = reconcileInterruptedChatTurns(deps);

    expect(result.interruptedTurnIds).toEqual([]);
    expect(result.synthesizedTurnIds).toEqual([]);
    expect(result.skippedDurableOwnedTurnIds).toEqual([]);
    expect(deps.publishRealtime).not.toHaveBeenCalled();
  });
});

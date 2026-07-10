import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@goatcitadel/storage";
import { ChatTurnExecutionRegistry, ChatTurnStreamRegistrationMismatchError } from "../chat-turn-execution-registry.js";
import { GatewayChatStreamRuntime } from "./chat-stream-runtime.js";

describe("GatewayChatStreamRuntime registration identity", () => {
  it("rejects stale producer deltas before they can mutate the resumed stream projector", () => {
    const appended: Array<{ payload: Record<string, unknown> }> = [];
    const registry = new ChatTurnExecutionRegistry();
    const storage = {
      chatStreamEvents: {
        append: vi.fn((event: { payload: Record<string, unknown> }) => appended.push(event)),
        getLatestSequence: vi.fn(() => 0),
        purgeBefore: vi.fn(),
      },
    } as unknown as Storage;
    const runtime = new GatewayChatStreamRuntime({
      storage,
      chatTurnExecutionRegistry: registry,
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      initialLastChatStreamPurgeAt: Date.now(),
    });

    const pausedAttempt = runtime.registerActiveChatTurnStream("session-1", "turn-1", "run-1");
    runtime.persistChatStreamChunk(
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "Authorization: Bearer ",
      },
      "run-1",
      pausedAttempt,
    );
    const resumedAttempt = runtime.registerActiveChatTurnStream("session-1", "turn-1", "run-1", {
      continuation: true,
    });
    const appendCountBeforeStaleWrite = appended.length;

    expect(() =>
      runtime.persistChatStreamChunk(
        {
          type: "delta",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "message-1",
          delta: "stale-producer-data ",
        },
        "run-1",
        pausedAttempt,
      ),
    ).toThrow(ChatTurnStreamRegistrationMismatchError);
    expect(appended).toHaveLength(appendCountBeforeStaleWrite);

    expect(runtime.completeActiveChatTurnStream("turn-1", pausedAttempt.registrationId)).toBe(false);
    expect(runtime.closeActiveChatTurnStream("turn-1", pausedAttempt.registrationId)).toBe(false);
    expect(runtime.getActiveChatTurnStream("turn-1")).toBe(resumedAttempt);
    expect(resumedAttempt.completed).toBe(false);

    runtime.persistChatStreamChunk(
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "hunter2\n",
      },
      "run-1",
      resumedAttempt,
    );

    expect(JSON.stringify(appended)).not.toContain("hunter2");
    expect(appended.at(-1)?.payload).toMatchObject({ type: "delta" });
  });

  it("rejects stale producer terminal chunks without resetting the resumed stream projector", () => {
    const appended: Array<{ payload: Record<string, unknown> }> = [];
    const registry = new ChatTurnExecutionRegistry();
    const runtime = new GatewayChatStreamRuntime({
      storage: {
        chatStreamEvents: {
          append: vi.fn((event: { payload: Record<string, unknown> }) => appended.push(event)),
          getLatestSequence: vi.fn(() => 0),
          purgeBefore: vi.fn(),
        },
      } as unknown as Storage,
      chatTurnExecutionRegistry: registry,
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      initialLastChatStreamPurgeAt: Date.now(),
    });

    const pausedAttempt = runtime.registerActiveChatTurnStream("session-1", "turn-1", "run-1");
    runtime.persistChatStreamChunk(
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "Authorization: Bearer ",
      },
      "run-1",
      pausedAttempt,
    );
    const resumedAttempt = runtime.registerActiveChatTurnStream("session-1", "turn-1", "run-1", {
      continuation: true,
    });
    const appendCountBeforeStaleTerminal = appended.length;

    expect(() =>
      runtime.persistChatStreamChunk(
        {
          type: "done",
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: "message-1",
        },
        "run-1",
        pausedAttempt,
      ),
    ).toThrow(ChatTurnStreamRegistrationMismatchError);
    expect(appended).toHaveLength(appendCountBeforeStaleTerminal);
    expect(runtime.getActiveChatTurnStream("turn-1")).toBe(resumedAttempt);

    runtime.persistChatStreamChunk(
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "hunter2\n",
      },
      "run-1",
      resumedAttempt,
    );

    expect(JSON.stringify(appended)).not.toContain("hunter2");
  });

  it("keeps resumed text suppressed even after retained stream events expire", () => {
    const appended: Array<{ payload: Record<string, unknown> }> = [];
    const runtime = new GatewayChatStreamRuntime({
      storage: {
        chatStreamEvents: {
          append: vi.fn((event: { payload: Record<string, unknown> }) => appended.push(event)),
          getLatestSequence: vi.fn(() => 0),
          purgeBefore: vi.fn(),
        },
      } as unknown as Storage,
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      initialLastChatStreamPurgeAt: Date.now(),
    });

    runtime.registerActiveChatTurnStream("session-1", "turn-expired", "run-1", {
      continuation: false,
    });
    const resumedAttempt = runtime.registerActiveChatTurnStream("session-1", "turn-expired", "run-1", {
      continuation: true,
    });
    runtime.persistChatStreamChunk(
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-expired",
        messageId: "message-1",
        delta: "ordinary public response.",
      },
      "run-1",
      resumedAttempt,
    );

    expect(appended.at(-1)?.payload).toMatchObject({ type: "delta", delta: "" });
    expect(JSON.stringify(appended)).not.toContain("ordinary public response");
  });

  it("keeps a fresh durable producer live when only message_start was already persisted", () => {
    const appended: Array<{ payload: Record<string, unknown> }> = [];
    const runtime = new GatewayChatStreamRuntime({
      storage: {
        chatStreamEvents: {
          append: vi.fn((event: { payload: Record<string, unknown> }) => appended.push(event)),
          getLatestSequence: vi.fn(() => 1),
          purgeBefore: vi.fn(),
        },
      } as unknown as Storage,
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      initialLastChatStreamPurgeAt: Date.now(),
    });

    const producer = runtime.registerActiveChatTurnStream("session-1", "turn-fresh", "run-1");
    runtime.persistChatStreamChunk(
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-fresh",
        messageId: "message-1",
        delta: "ordinary public response.\n",
      },
      "run-1",
      producer,
    );

    expect(appended.at(-1)?.payload).toMatchObject({ type: "delta", delta: "ordinary public response.\n" });
  });

  it("falls back to retained sequence truth when no explicit continuation signal is supplied", () => {
    const appended: Array<{ payload: Record<string, unknown> }> = [];
    const runtime = new GatewayChatStreamRuntime({
      storage: {
        chatStreamEvents: {
          append: vi.fn((event: { payload: Record<string, unknown> }) => appended.push(event)),
          getLatestSequence: vi.fn(() => 2),
          purgeBefore: vi.fn(),
        },
      } as unknown as Storage,
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      initialLastChatStreamPurgeAt: Date.now(),
    });

    const producer = runtime.registerActiveChatTurnStream("session-1", "turn-resumed", "run-1", {
      continuation: false,
    });
    runtime.persistChatStreamChunk(
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-resumed",
        messageId: "message-1",
        delta: "must stay suppressed\n",
      },
      "run-1",
      producer,
    );

    expect(appended.at(-1)?.payload).toMatchObject({ type: "delta", delta: "" });
  });

  it("rejects a producer lease presented for another turn", () => {
    const runtime = new GatewayChatStreamRuntime({
      storage: {
        chatStreamEvents: {
          append: vi.fn(),
          getLatestSequence: vi.fn(() => 0),
          purgeBefore: vi.fn(),
        },
      } as unknown as Storage,
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      initialLastChatStreamPurgeAt: Date.now(),
    });
    const producer = runtime.registerActiveChatTurnStream("session-1", "turn-1", "run-1");

    expect(() =>
      runtime.persistChatStreamChunk(
        {
          type: "delta",
          sessionId: "session-1",
          turnId: "turn-2",
          messageId: "message-1",
          delta: "wrong turn",
        },
        "run-1",
        producer,
      ),
    ).toThrow(ChatTurnStreamRegistrationMismatchError);
  });
});

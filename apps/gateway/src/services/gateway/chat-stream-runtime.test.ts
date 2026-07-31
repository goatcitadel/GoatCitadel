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

describe("GatewayChatStreamRuntime terminal admission barrier", () => {
  it.each([
    { terminalKind: "completed", leadingError: false },
    { terminalKind: "failed", leadingError: true },
  ])(
    "holds a retained $terminalKind terminal event until canonical durable release completes",
    async ({ leadingError }) => {
      let release!: () => void;
      const delayedRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      const beforeDeliverTerminalChatStreamEvent = vi.fn(async () => {
        await delayedRelease;
        return true;
      });
      const events = [
        ...(leadingError
          ? [
              {
                eventId: "event-error",
                sessionId: "session-1",
                turnId: "turn-1",
                sequence: 1,
                runId: "run-1",
                chunkType: "error",
                payload: {
                  type: "error",
                  sessionId: "session-1",
                  turnId: "turn-1",
                  error: "provider failed",
                },
                createdAt: "2026-07-29T00:00:00.000Z",
              },
            ]
          : []),
        {
          eventId: "event-done",
          sessionId: "session-1",
          turnId: "turn-1",
          sequence: leadingError ? 2 : 1,
          runId: "run-1",
          chunkType: "done",
          payload: {
            type: "done",
            sessionId: "session-1",
            turnId: "turn-1",
            messageId: "message-1",
          },
          createdAt: "2026-07-29T00:00:00.001Z",
        },
      ];
      const runtime = new GatewayChatStreamRuntime({
        storage: {
          chatStreamEvents: {
            listByTurn: vi.fn((_turnId: string, afterSequence: number) =>
              events.filter((event) => event.sequence > afterSequence),
            ),
          },
        } as unknown as Storage,
        chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
        createHydratedChatTurnTrace: (_turnId, trace) => trace,
        beforeDeliverTerminalChatStreamEvent,
      });
      const stream = runtime.streamPersistedChatTurnEvents("session-1", "turn-1");

      if (leadingError) {
        await expect(stream.next()).resolves.toMatchObject({ value: { type: "error", error: "provider failed" } });
      }
      let terminalSettled = false;
      const terminal = stream.next().then((result) => {
        terminalSettled = true;
        return result;
      });
      await vi.waitFor(() => expect(beforeDeliverTerminalChatStreamEvent).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(terminalSettled).toBe(false);

      release();

      await expect(terminal).resolves.toMatchObject({ value: { type: "done", turnId: "turn-1" }, done: false });
      await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });
      expect(beforeDeliverTerminalChatStreamEvent).toHaveBeenCalledWith({
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
      });
    },
  );

  it("returns a visible recovery error instead of done when canonical admission remains active", async () => {
    let released = false;
    const beforeDeliverTerminalChatStreamEvent = vi.fn(async () => released);
    const doneEvent = {
      eventId: "event-done",
      sessionId: "session-1",
      turnId: "turn-1",
      sequence: 1,
      runId: "run-1",
      chunkType: "done",
      payload: {
        type: "done",
        eventId: "event-done",
        sequence: 1,
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
      },
      createdAt: "2026-07-29T00:00:00.001Z",
    };
    const runtime = new GatewayChatStreamRuntime({
      storage: {
        chatStreamEvents: {
          getByEventId: vi.fn((eventId: string) => (eventId === doneEvent.eventId ? doneEvent : undefined)),
          listByTurn: vi.fn((_turnId: string, afterSequence: number) =>
            doneEvent.sequence > afterSequence ? [doneEvent] : [],
          ),
        },
      } as unknown as Storage,
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      beforeDeliverTerminalChatStreamEvent,
    });
    const stream = runtime.streamPersistedChatTurnEvents("session-1", "turn-1");

    const recovery = await stream.next();
    expect(recovery).toMatchObject({
      value: {
        type: "error",
        eventId: "event-done",
        turnId: "turn-1",
        error: expect.stringMatching(/durable admission is still active/iu),
      },
      done: false,
    });
    await expect(stream.next()).resolves.toEqual({ value: undefined, done: true });

    const stillBlocked = runtime.streamPersistedChatTurnEvents("session-1", "turn-1", {
      sinceEventId: "event-done",
    });
    await expect(stillBlocked.next()).resolves.toMatchObject({
      value: { type: "error", eventId: "event-done" },
      done: false,
    });
    await expect(stillBlocked.next()).resolves.toEqual({ value: undefined, done: true });

    released = true;
    const admitted = runtime.streamPersistedChatTurnEvents("session-1", "turn-1", {
      sinceEventId: "event-done",
    });
    await expect(admitted.next()).resolves.toMatchObject({
      value: { type: "done", eventId: "event-done", turnId: "turn-1" },
      done: false,
    });
    await expect(admitted.next()).resolves.toEqual({ value: undefined, done: true });
    expect(beforeDeliverTerminalChatStreamEvent).toHaveBeenCalledTimes(3);
  });

  it("re-gates an unresolvable recovery cursor until admission releases", async () => {
    let released = false;
    let sequence = 10;
    const beforeDeliverTerminalChatStreamEvent = vi.fn(async () => released);
    const persistChatStreamChunk = vi.fn((chunk: Record<string, unknown>, runId?: string) => ({
      ...chunk,
      eventId: `fallback-${sequence}`,
      sequence: sequence++,
      ...(runId ? { runId } : {}),
    }));
    const runtime = new GatewayChatStreamRuntime({
      storage: {
        chatStreamEvents: {
          getByEventId: vi.fn(() => undefined),
          getLatestSequence: vi.fn(() => 9),
        },
        chatTurnTraces: {
          get: vi.fn(() => ({
            sessionId: "session-1",
            turnId: "turn-1",
            assistantMessageId: "message-1",
            status: "completed",
            durable: { runId: "run-1" },
            completion: { status: "complete", repaired: false },
          })),
        },
        chatMessages: {
          get: vi.fn(() => ({ messageId: "message-1", content: "Canonical answer." })),
        },
      } as unknown as Storage,
      chatTurnExecutionRegistry: new ChatTurnExecutionRegistry(),
      createHydratedChatTurnTrace: (_turnId, trace) => trace,
      beforeDeliverTerminalChatStreamEvent,
      persistChatStreamChunk: persistChatStreamChunk as never,
    });

    const blocked = [];
    for await (const chunk of runtime.streamPersistedChatTurnEvents("session-1", "turn-1", {
      sinceEventId: "event-done:admission-recovery",
    })) {
      blocked.push(chunk);
    }
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      type: "error",
      eventId: "event-done:admission-recovery",
      error: expect.stringMatching(/durable admission is still active/iu),
    });
    expect(persistChatStreamChunk).not.toHaveBeenCalled();

    released = true;
    const admitted = [];
    for await (const chunk of runtime.streamPersistedChatTurnEvents("session-1", "turn-1", {
      sinceEventId: "event-done:admission-recovery",
    })) {
      admitted.push(chunk);
    }
    expect(admitted.map((chunk) => chunk.type)).toEqual(["trace_update", "message_done", "done"]);
    expect(admitted.filter((chunk) => chunk.type === "done")).toHaveLength(1);
    expect(beforeDeliverTerminalChatStreamEvent).toHaveBeenCalledTimes(2);
  });
});

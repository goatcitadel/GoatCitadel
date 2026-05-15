import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

function createGatewayHarness(overrides: Record<string, unknown> = {}) {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  Object.assign(gateway, {
    chatTurnExecutionRegistry: {
      getActiveStream: vi.fn(() => undefined),
    },
    config: {
      assistant: {
        web: {
          firecrawl: {
            enabled: true,
            baseUrl: "http://127.0.0.1:3002",
            apiKeyEnv: "FIRECRAWL_API_KEY",
            timeoutMs: 20_000,
            defaultReadBackend: "native",
            fallbackToNative: true,
          },
        },
      },
    },
    lastChatStreamPurgeAt: Date.now(),
    storage: {
      chatMessages: { get: vi.fn() },
      chatStreamEvents: {
        append: vi.fn(),
        getByEventId: vi.fn(),
        getLatestSequence: vi.fn(() => 0),
        listByTurn: vi.fn(() => []),
        purgeBefore: vi.fn(),
      },
      chatTurnTraces: { get: vi.fn() },
      durableRuns: { getRun: vi.fn() },
    },
  });
  Object.assign(gateway, overrides);
  return gateway;
}

async function collect<T>(source: AsyncGenerator<T>, limit = 10): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
    if (values.length >= limit) {
      break;
    }
  }
  return values;
}

describe("GatewayService loop 26 stream and runtime behavior", () => {
  it("persists stream chunks with active-stream sequencing and bounded purge cadence", () => {
    const active = { nextSequence: 7 };
    const gateway = createGatewayHarness({
      chatTurnExecutionRegistry: {
        getActiveStream: vi.fn(() => active),
      },
      lastChatStreamPurgeAt: 0,
      storage: {
        chatStreamEvents: {
          append: vi.fn(),
          getLatestSequence: vi.fn(() => 3),
          purgeBefore: vi.fn(),
        },
      },
    });

    const chunk = GatewayService.prototype.persistChatStreamChunk.call(
      gateway,
      {
        type: "delta",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "hello",
      } as never,
      "run-1",
    );

    expect(chunk).toMatchObject({
      type: "delta",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "message-1",
      delta: "hello",
      sequence: 7,
      runId: "run-1",
    });
    expect(chunk.eventId).toEqual(expect.any(String));
    expect(active.nextSequence).toBe(8);
    expect(gateway.storage.chatStreamEvents.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: chunk.eventId,
        sessionId: "session-1",
        turnId: "turn-1",
        sequence: 7,
        runId: "run-1",
        chunkType: "delta",
        payload: expect.objectContaining({ delta: "hello", runId: "run-1" }),
      }),
    );
    expect(gateway.storage.chatStreamEvents.purgeBefore).toHaveBeenCalledWith(expect.stringMatching(/T.*Z$/));
  });

  it("replays persisted events, skips malformed payloads, and stops on done", async () => {
    const gateway = createGatewayHarness({
      storage: {
        chatStreamEvents: {
          getByEventId: vi.fn(),
          listByTurn: vi.fn((_turnId: string, afterSequence: number) => {
            if (afterSequence === 0) {
              return [
                { sequence: 1, payload: { type: "delta", sessionId: "session-1" } },
                {
                  sequence: 2,
                  payload: {
                    type: "delta",
                    sessionId: "session-1",
                    eventId: "event-2",
                    sequence: 2,
                    turnId: "turn-1",
                    messageId: "message-1",
                    delta: "part",
                  },
                },
              ];
            }
            if (afterSequence === 2) {
              return [
                {
                  sequence: 3,
                  payload: {
                    type: "done",
                    sessionId: "session-1",
                    eventId: "event-3",
                    sequence: 3,
                    turnId: "turn-1",
                    messageId: "message-1",
                  },
                },
              ];
            }
            return [];
          }),
        },
      },
    });

    const chunks = await collect(
      GatewayService.prototype.streamPersistedChatTurnEvents.call(gateway, "session-1", "turn-1"),
    );

    expect(chunks).toEqual([
      expect.objectContaining({ type: "delta", eventId: "event-2", sequence: 2, delta: "part" }),
      expect.objectContaining({ type: "done", eventId: "event-3", sequence: 3 }),
    ]);
  });

  it("falls back to durable turn state when a resume cursor belongs to another turn", async () => {
    const trace = {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "append",
      status: "completed",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-05-14T20:00:00.000Z",
      assistantMessageId: "assistant-1",
      completion: { repaired: true },
      durable: { runId: "run-1" },
      toolRuns: [],
      citations: [],
      routing: {},
    };
    const gateway = createGatewayHarness({
      createHydratedChatTurnTrace: vi.fn((_turnId: string, input: unknown) => input),
      lastChatStreamPurgeAt: Date.now(),
      storage: {
        chatMessages: {
          get: vi.fn(() => ({
            messageId: "assistant-1",
            content: "Recovered answer",
          })),
        },
        chatStreamEvents: {
          append: vi.fn(),
          getByEventId: vi.fn(() => ({ turnId: "other-turn", sequence: 4 })),
          getLatestSequence: vi.fn(() => 4),
          listByTurn: vi.fn(() => []),
          purgeBefore: vi.fn(),
        },
        chatTurnTraces: {
          get: vi.fn(() => trace),
        },
      },
    });

    const chunks = await collect(
      GatewayService.prototype.streamPersistedChatTurnEvents.call(gateway, "session-1", "turn-1", {
        sinceEventId: "event-from-other-turn",
      }),
    );

    expect(chunks).toEqual([
      expect.objectContaining({ type: "trace_update", turnId: "turn-1", runId: "run-1" }),
      expect.objectContaining({
        type: "message_done",
        turnId: "turn-1",
        messageId: "assistant-1",
        content: "Recovered answer",
        repaired: true,
        runId: "run-1",
      }),
      expect.objectContaining({ type: "done", turnId: "turn-1", messageId: "assistant-1", runId: "run-1" }),
    ]);
    expect(gateway.storage.chatStreamEvents.listByTurn).not.toHaveBeenCalled();
  });

  it("detects durable live-tail state from stream rows and trace fallback", () => {
    const gateway = createGatewayHarness({
      storage: {
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(() => ({ run_id: "run-from-stream" })),
          })),
        },
        chatTurnTraces: { get: vi.fn() },
        durableRuns: { getRun: vi.fn(() => ({ status: "waiting" })) },
      },
    });

    expect((GatewayService.prototype as any).isDurableTurnStillStreaming.call(gateway, "turn-1")).toBe(true);
    expect(gateway.storage.durableRuns.getRun).toHaveBeenCalledWith("run-from-stream");

    const fallbackGateway = createGatewayHarness({
      storage: {
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(() => undefined),
          })),
        },
        chatTurnTraces: { get: vi.fn(() => ({ durable: { runId: "run-from-trace" } })) },
        durableRuns: { getRun: vi.fn(() => ({ status: "completed" })) },
      },
    });

    expect((GatewayService.prototype as any).isDurableTurnStillStreaming.call(fallbackGateway, "turn-2")).toBe(false);

    const missingGateway = createGatewayHarness({
      storage: {
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(() => undefined),
          })),
        },
        chatTurnTraces: {
          get: vi.fn(() => {
            throw new Error("missing trace");
          }),
        },
        durableRuns: { getRun: vi.fn() },
      },
    });

    expect((GatewayService.prototype as any).isDurableTurnStillStreaming.call(missingGateway, "turn-3")).toBe(false);
  });

  it("adds ephemeral stream envelopes without retaining them", async () => {
    async function* source() {
      yield { type: "delta", sessionId: "session-1", turnId: "turn-1", delta: "a" } as never;
      yield { type: "done", sessionId: "session-1", turnId: "turn-1", messageId: "message-1" } as never;
    }

    const chunks = await collect(
      GatewayService.prototype.withEphemeralStreamEnvelope.call({} as never, source(), "run-1"),
    );

    expect(chunks).toEqual([
      expect.objectContaining({ type: "delta", sequence: 1, runId: "run-1" }),
      expect.objectContaining({ type: "done", sequence: 2, runId: "run-1" }),
    ]);
    expect(chunks[0]?.eventId).toEqual(expect.any(String));
    expect(chunks[1]?.eventId).toEqual(expect.any(String));
    expect(chunks[0]?.eventId).not.toBe(chunks[1]?.eventId);
  });

  it("applies Firecrawl defaults to docs ingest URL reads without touching unrelated requests", () => {
    const gateway = createGatewayHarness({
      config: {
        assistant: {
          web: {
            firecrawl: {
              enabled: true,
              baseUrl: "http://127.0.0.1:3002",
              apiKeyEnv: "FIRECRAWL_API_KEY",
              timeoutMs: 15_000,
              defaultReadBackend: "firecrawl",
              fallbackToNative: false,
            },
          },
        },
      },
    });

    const docsRequest = (GatewayService.prototype as any).applyRuntimeBrowserBackendDefaults.call(gateway, {
      toolName: "docs.ingest",
      args: { sourceType: "url", url: "https://example.com/docs" },
    });
    expect(docsRequest.args).toMatchObject({
      backend: "firecrawl",
      firecrawlBaseUrl: "http://127.0.0.1:3002",
      firecrawlTimeoutMs: 15_000,
      firecrawlApiKeyEnv: "FIRECRAWL_API_KEY",
    });
    expect(docsRequest.args).not.toHaveProperty("firecrawlFallbackToNative");

    const noArgs = { toolName: "browser.search" };
    expect((GatewayService.prototype as any).applyRuntimeBrowserBackendDefaults.call(gateway, noArgs)).toBe(noArgs);

    const unrelated = { toolName: "shell.exec", args: { command: "pwd" } };
    expect((GatewayService.prototype as any).applyRuntimeBrowserBackendDefaults.call(gateway, unrelated)).toBe(
      unrelated,
    );
  });

  it("uses chat session workspace metadata when evaluating tool access without explicit workspace", () => {
    const evaluateAccess = vi.fn((input: Record<string, unknown>) => ({ allowed: true, input }));
    const gateway = createGatewayHarness({
      policyEngine: { evaluateAccess },
      storage: {
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
      },
    });

    expect(
      GatewayService.prototype.evaluateToolAccess.call(gateway, {
        sessionId: "session-1",
        toolName: "browser.search",
        args: { q: "status" },
      } as never),
    ).toMatchObject({ allowed: true });
    expect(evaluateAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        toolName: "browser.search",
        workspaceId: "workspace-1",
      }),
    );
  });
});

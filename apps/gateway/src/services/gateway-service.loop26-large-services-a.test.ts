import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

function createGatewayHarness(overrides: Record<string, unknown> = {}) {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
  const storage = {
    chatMessages: { get: vi.fn() },
    chatSessionMeta: { get: vi.fn(() => undefined) },
    chatStreamEvents: {
      append: vi.fn(),
      getByEventId: vi.fn(),
      getLatestSequence: vi.fn(() => 0),
      listByTurn: vi.fn(() => []),
      purgeBefore: vi.fn(),
    },
    chatTurnTraces: { get: vi.fn() },
    durableRuns: { getRun: vi.fn() },
    workspaces: { find: vi.fn(() => ({ citadelId: "personal" })) },
  };
  const storageOverrides = overrides.storage as Record<string, unknown> | undefined;
  const restOverrides = { ...overrides };
  delete restOverrides.storage;
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
      ...storage,
      ...(storageOverrides ?? {}),
    },
  });
  Object.assign(gateway, restOverrides);
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

  it("replays memory citation provenance from persisted stream events", async () => {
    const gateway = createGatewayHarness({
      storage: {
        chatStreamEvents: {
          getByEventId: vi.fn(),
          listByTurn: vi.fn((_turnId: string, afterSequence: number) => {
            if (afterSequence === 0) {
              return [
                {
                  sequence: 1,
                  payload: {
                    type: "citation",
                    sessionId: "session-1",
                    eventId: "event-1",
                    sequence: 1,
                    turnId: "turn-1",
                    citation: {
                      citationId: "memory-1",
                      title: "Preference memory",
                      url: "memory://preference-1",
                      sourceType: "memory",
                      provenance: {
                        relationScope: "self",
                        freshness: "recent",
                        selectionReason: "selected by semantic-hint retrieval score 0.956",
                        retrievalStrategy: "semantic_hints",
                        matchSignals: {
                          lexicalScore: 0.4,
                          semanticHintScore: 0.2,
                          recencyScore: 0.3,
                          diversityScore: 0.056,
                          totalScore: 0.956,
                        },
                      },
                    },
                  },
                },
              ];
            }
            if (afterSequence === 1) {
              return [
                {
                  sequence: 2,
                  payload: {
                    type: "done",
                    sessionId: "session-1",
                    eventId: "event-2",
                    sequence: 2,
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

    expect(chunks[0]).toEqual(
      expect.objectContaining({
        type: "citation",
        citation: expect.objectContaining({
          sourceType: "memory",
          provenance: expect.objectContaining({
            selectionReason: "selected by semantic-hint retrieval score 0.956",
            retrievalStrategy: "semantic_hints",
          }),
        }),
      }),
    );
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
    expect(
      (GatewayService.prototype as any).isDurableTurnStillStreaming.call(gateway, "turn-1", {
        includeInterrupts: false,
      }),
    ).toBe(false);
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

  it("normalizes docs ingest file sources through the gateway invoke path before policy evaluation", () => {
    const gateway = createGatewayHarness({
      config: {
        rootDir: "F:/code/personal-ai",
        assistant: {
          workspaceDir: "workspace",
          web: {
            firecrawl: {
              enabled: false,
              baseUrl: "http://127.0.0.1:3002",
              apiKeyEnv: "FIRECRAWL_API_KEY",
              timeoutMs: 15_000,
              defaultReadBackend: "native",
              fallbackToNative: true,
            },
          },
        },
      },
      storage: {
        chatSessionProjects: {
          get: vi.fn(() => ({ projectId: "project-1" })),
        },
        chatProjects: {
          get: vi.fn(() => ({ workspacePath: "projects/app" })),
        },
      },
    });

    const request = {
      toolName: "docs.ingest",
      args: { sourceType: "file", source: "docs/source.md", namespace: "research" },
      agentId: "agent",
      sessionId: "session-1",
    };

    const resolved = (GatewayService.prototype as any).resolveToolInvokeRequestPaths.call(gateway, request);

    expect(resolved.args.source).toBe(
      path.resolve("F:/code/personal-ai", "workspace", "projects/app", "docs/source.md"),
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
        workspaces: {
          find: vi.fn(() => ({ citadelId: "company" })),
        },
        permissionProfiles: {
          resolveContext: vi.fn(() => ({ permissionProfile: { profileId: "safe" } })),
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
        citadelId: "company",
        policyContext: expect.objectContaining({ permissionProfileId: "safe" }),
      }),
    );
  });

  it("normalizes docs ingest file sources through access evaluation before policy checks", () => {
    const evaluateAccess = vi.fn((input: Record<string, unknown>) => ({ allowed: true, input }));
    const gateway = createGatewayHarness({
      config: {
        rootDir: "F:/code/personal-ai",
        assistant: {
          workspaceDir: "workspace",
          deploymentProfile: "local",
          web: {
            firecrawl: {
              enabled: false,
              baseUrl: "http://127.0.0.1:3002",
              apiKeyEnv: "FIRECRAWL_API_KEY",
              timeoutMs: 15_000,
              defaultReadBackend: "native",
              fallbackToNative: true,
            },
          },
        },
      },
      policyEngine: { evaluateAccess },
      storage: {
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
        chatSessionProjects: {
          get: vi.fn(() => ({ projectId: "project-1" })),
        },
        chatProjects: {
          get: vi.fn(() => ({ workspacePath: "projects/app" })),
        },
        permissionProfiles: {
          resolveContext: vi.fn(() => ({ permissionProfile: { profileId: "safe" } })),
        },
      },
    });

    GatewayService.prototype.evaluateToolAccess.call(gateway, {
      sessionId: "session-1",
      agentId: "agent",
      toolName: "docs.ingest",
      args: { sourceType: "file", source: "docs/source.md", namespace: "research" },
    } as never);

    expect(evaluateAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          source: path.resolve("F:/code/personal-ai", "workspace", "projects/app", "docs/source.md"),
        }),
      }),
    );
  });

  it("applies runtime browser defaults before tool access evaluation", () => {
    const evaluateAccess = vi.fn((input: Record<string, unknown>) => ({ allowed: true, input }));
    const gateway = createGatewayHarness({
      config: {
        assistant: {
          web: {
            firecrawl: {
              enabled: true,
              baseUrl: "https://firecrawl.example",
              apiKeyEnv: "FIRECRAWL_API_KEY",
              timeoutMs: 12_000,
              defaultReadBackend: "firecrawl",
              fallbackToNative: false,
            },
          },
        },
      },
      policyEngine: { evaluateAccess },
      storage: {
        chatSessionMeta: {
          get: vi.fn(() => ({ workspaceId: "workspace-1" })),
        },
        permissionProfiles: {
          resolveContext: vi.fn(() => ({ permissionProfile: { profileId: "safe" } })),
        },
      },
    });

    GatewayService.prototype.evaluateToolAccess.call(gateway, {
      sessionId: "session-1",
      toolName: "browser.search",
      args: { query: "status" },
    } as never);

    expect(evaluateAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          backend: "firecrawl",
          firecrawlBaseUrl: "https://firecrawl.example",
          firecrawlTimeoutMs: 12_000,
          firecrawlApiKeyEnv: "FIRECRAWL_API_KEY",
          firecrawlFallbackToNative: false,
        }),
      }),
    );
  });
});

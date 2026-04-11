import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord, DurableRunRecord } from "@goatcitadel/contracts";
import type { ChatTurnDispatchHost } from "./chat-turn-dispatch-service.js";

vi.mock("./gateway-service.js", () => ({
  dedupeChatCitations: (items: unknown[]) => items,
  isPersistableChatStreamChunk: () => true,
  splitIntoChunks: (value: string) => [value],
}));

const { launchPreparedAgentChatTurnStream, shouldUseDurableExecution } =
  await import("./chat-turn-dispatch-service.js");

describe("chat turn dispatch durable ownership", () => {
  it("treats shipped chat, cowork, and code surfaces as durable-owned when the 1.0 defaults are on", () => {
    const host = createHost();
    expect(shouldUseDurableExecution(host, createPrepared("chat"), { content: "hello" })).toBe(true);
    expect(shouldUseDurableExecution(host, createPrepared("cowork"), { content: "hello" })).toBe(true);
    expect(shouldUseDurableExecution(host, createPrepared("code"), { content: "hello" })).toBe(true);
  });

  it("registers the active stream against the durable run when one is created", () => {
    const durableRun = { runId: "run-1" } as DurableRunRecord;
    const host = createHost({
      beginDurableChatRun: vi.fn(() => durableRun),
    });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared("chat"),
      "chat_thread_turn_appended",
    );

    expect(host.registerActiveChatTurnStream).toHaveBeenCalledWith("session-1", "turn-1", "run-1");
    expect(host.backgroundTasks.size).toBe(0);
    expect(host.persistChatStreamChunk).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("fails closed instead of silently falling back to background execution when a shipped durable send cannot allocate a run", () => {
    const traceState = {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      status: "running",
      routing: {},
      startedAt: "2026-04-11T00:00:00.000Z",
    } as unknown as ChatTurnTraceRecord;
    const host = createHost({
      beginDurableChatRun: vi.fn(() => undefined),
      traceState,
    });

    launchPreparedAgentChatTurnStream(
      host,
      "session-1",
      { content: "hello", mode: "chat" },
      createPrepared("chat"),
      "chat_thread_turn_appended",
    );

    expect(host.backgroundTasks.size).toBe(0);
    expect(host.storage.chatTurnTraces.patch).toHaveBeenCalledWith(
      "turn-1",
      expect.objectContaining({
        status: "failed",
      }),
    );
    expect(host.persistChatStreamChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("durable_unavailable"),
      }),
    );
    expect(host.completeActiveChatTurnStream).toHaveBeenCalledWith("turn-1");
  });
});

function createHost(
  overrides: {
    beginDurableChatRun?: (...args: unknown[]) => DurableRunRecord | undefined;
    traceState?: ChatTurnTraceRecord;
  } = {},
): ChatTurnDispatchHost & {
  registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
  persistChatStreamChunk: ReturnType<typeof vi.fn>;
  completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
} {
  const traceState =
    overrides.traceState ??
    ({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      status: "running",
      routing: {},
      startedAt: "2026-04-11T00:00:00.000Z",
    } as unknown as ChatTurnTraceRecord);
  const registerActiveChatTurnStream = vi.fn();
  const persistChatStreamChunk = vi.fn();
  const completeActiveChatTurnStream = vi.fn();
  const closeActiveChatTurnStream = vi.fn();
  const beginDurableChatRun = overrides.beginDurableChatRun ?? vi.fn(() => undefined);
  const patchTrace = vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => ({ ...traceState, ...patch }));
  return {
    config: {
      assistant: {
        durable: {
          enabled: true,
          executionEnabled: true,
          chatAutoPromoteEnabled: true,
        },
      },
    },
    storage: {
      durableRuns: {
        getRun: vi.fn(() => ({ status: "running" })),
      },
      chatTurnTraces: {
        patch: patchTrace,
        get: vi.fn(() => traceState),
      },
    } as never,
    backgroundTasks: new Set(),
    isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
    streamPersistedChatTurnEvents: vi.fn(async function* () {}),
    persistChatStreamChunk,
    createHydratedChatTurnTrace: vi.fn((_turnId: string, trace: ChatTurnTraceRecord) => trace),
    finalizeDurableChatRun: vi.fn(),
    completeActiveChatTurnStream,
    closeActiveChatTurnStream,
    beginDurableChatRun,
    registerActiveChatTurnStream,
    ensureSessionInternalToolGrant: vi.fn(),
    requireExecutedToolResult: vi.fn(),
    commsSend: vi.fn(),
    ingestEvent: vi.fn(),
    updateActiveLeafOrThrow: vi.fn(),
    publishRealtime: vi.fn(),
  } as unknown as ChatTurnDispatchHost & {
    registerActiveChatTurnStream: ReturnType<typeof vi.fn>;
    persistChatStreamChunk: ReturnType<typeof vi.fn>;
    completeActiveChatTurnStream: ReturnType<typeof vi.fn>;
  };
}

function createPrepared(mode: "chat" | "cowork" | "code") {
  return {
    session: {
      sessionId: "session-1",
    },
    turnId: "turn-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    content: "hello",
    normalized: {
      mode,
    },
    prefs: {
      mode,
    },
    autonomy: {
      reflectionMode: "off",
    },
  } as never;
}

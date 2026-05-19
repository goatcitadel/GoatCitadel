/**
 * AbortSignal coverage for the three non-LLM dispatch branches of
 * `agentSendChatMessage`:
 *
 *   1. Integration transport (`sendPreparedIntegrationChatTurn`) -- forwards
 *      the signal into `commsSend` so HTTP requests cancel promptly.
 *   2. Mode orchestration (`consumePreparedAgentChatTurn` with a resolved
 *      `PreparedChatExecutionPlanResolution`) -- aborts the active turn
 *      controller registered by `streamPreparedAgentChatTurn` so the
 *      orchestration's inner LLM/delegated calls observe the abort.
 *   3. Durable execution (`consumePreparedAgentChatTurn` taking the durable
 *      branch) -- soft-cancels the durable run via `cancelDurableChatRun`
 *      while also aborting the local controller so the parent await loop
 *      bails out.
 *
 * Each test passes an `AbortSignal` via the third options arg, triggers
 * abort, and asserts that the branch's chokepoint observed the abort.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ChatSessionBindingRecord,
  ChatStreamChunkDraft,
  ChatTurnTraceRecord,
  DurableRunRecord,
} from "@goatcitadel/contracts";
import {
  consumePreparedAgentChatTurn,
  sendPreparedIntegrationChatTurn,
  type ChatTurnDispatchHost,
} from "./chat-turn-dispatch-service.js";

function createPrepared(mode: "chat" | "cowork" | "code" = "chat") {
  return {
    session: { sessionId: "session-1" },
    turnId: "turn-1",
    userEventId: "user-1",
    userMessage: {
      messageId: "user-1",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "hello",
      timestamp: "2026-05-16T00:00:00.000Z",
    },
    assistantMessageId: "assistant-1",
    parentTurnId: "turn-0",
    branchKind: "append",
    content: "hello",
    route: { provider: "openai", model: "gpt-5.4" },
    normalized: { mode },
    prefs: { mode, providerId: "openai", model: "gpt-5.4" },
    autonomy: { reflectionMode: "off", proactiveMode: "manual", lastProactiveRunId: undefined },
    effectiveToolAutonomy: "manual",
    retrievalTrace: undefined,
    workspaceId: "default",
    resolvedGuidance: {
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    },
  } as never;
}

function createBinding(): ChatSessionBindingRecord {
  return {
    sessionId: "session-1",
    workspaceId: "default",
    transport: "slack",
    target: "channel-x",
    connectionId: "conn-1",
    writable: true,
  } as ChatSessionBindingRecord;
}

function createIntegrationHost(
  overrides: { commsSend?: (input: { signal?: AbortSignal }) => Promise<unknown> } = {},
): ChatTurnDispatchHost & {
  commsSend: ReturnType<typeof vi.fn>;
  ingestEvent: ReturnType<typeof vi.fn>;
} {
  const trace = {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    status: "running",
    routing: {},
    startedAt: "2026-05-16T00:00:00.000Z",
  } as unknown as ChatTurnTraceRecord;
  const commsSend = vi.fn(
    overrides.commsSend ?? (async () => ({ outcome: "delivered", deliveryId: "msg-1", status: "sent" })),
  );
  return {
    config: {
      assistant: {
        durable: {
          enabled: false,
          executionEnabled: false,
          chatAutoPromoteEnabled: false,
        },
      },
    },
    storage: {
      chatTurnTraces: {
        create: vi.fn(() => trace),
        patch: vi.fn(() => trace),
        get: vi.fn(() => trace),
      },
    } as never,
    backgroundTasks: new Set(),
    isFeatureEnabled: vi.fn(() => false),
    streamPersistedChatTurnEvents: vi.fn(async function* () {}),
    persistChatStreamChunk: vi.fn(),
    createHydratedChatTurnTrace: vi.fn((_turnId: string, t: ChatTurnTraceRecord) => t),
    recordDevDiagnostic: vi.fn(),
    finalizeDurableChatRun: vi.fn(),
    completeActiveChatTurnStream: vi.fn(),
    closeActiveChatTurnStream: vi.fn(),
    beginDurableChatRun: vi.fn(() => undefined),
    registerActiveChatTurnStream: vi.fn(),
    ensureSessionInternalToolGrant: vi.fn(),
    requireExecutedToolResult: vi.fn((_name: string, value: unknown) => value as Record<string, unknown>),
    commsSend,
    ingestEvent: vi.fn(),
    updateActiveLeafOrThrow: vi.fn(),
    publishRealtime: vi.fn(),
    beginActiveChatTurnExecution: vi.fn(() => new AbortController()),
    endActiveChatTurnExecution: vi.fn(),
    getActiveChatTurnExecution: vi.fn(() => undefined),
    markChatTurnCancelled: vi.fn((_sessionId, turnId) => ({
      ...trace,
      turnId,
      status: "cancelled",
    })),
  } as unknown as ChatTurnDispatchHost & {
    commsSend: ReturnType<typeof vi.fn>;
    ingestEvent: ReturnType<typeof vi.fn>;
  };
}

describe("agentSendChatMessage abort signal coverage", () => {
  describe("integration transport branch", () => {
    it("forwards the AbortSignal into commsSend so the HTTP delivery can cancel", async () => {
      let observedSignal: AbortSignal | undefined;
      const host = createIntegrationHost({
        commsSend: vi.fn(async (input: { signal?: AbortSignal }) => {
          observedSignal = input.signal;
          return { outcome: "delivered", deliveryId: "msg-1", status: "sent" };
        }),
      });
      const controller = new AbortController();

      await sendPreparedIntegrationChatTurn(
        host,
        "session-1",
        { mode: "chat" },
        createPrepared("chat"),
        createBinding(),
        "chat_thread_turn_appended",
        { abortSignal: controller.signal },
      );

      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal).toBe(controller.signal);
      expect(host.commsSend).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "hello",
          signal: controller.signal,
        }),
      );
    });

    it("propagates an abort that fires during commsSend by causing the comms call to reject", async () => {
      const host = createIntegrationHost({
        commsSend: vi.fn(async (input: { signal?: AbortSignal }) => {
          return await new Promise((_resolve, reject) => {
            if (input.signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }),
      });
      const controller = new AbortController();
      const pending = sendPreparedIntegrationChatTurn(
        host,
        "session-1",
        { mode: "chat" },
        createPrepared("chat"),
        createBinding(),
        "chat_thread_turn_appended",
        { abortSignal: controller.signal },
      );
      setTimeout(() => controller.abort(), 5);

      await expect(pending).rejects.toThrow(/aborted/);
      expect(host.storage.chatTurnTraces.patch).toHaveBeenLastCalledWith(
        "turn-1",
        expect.objectContaining({ status: "failed" }),
      );
    });
  });

  describe("orchestration/durable dispatch branches via consumePreparedAgentChatTurn", () => {
    it("aborts the active turn controller when the external signal fires on the non-durable orchestration path", async () => {
      const activeController = new AbortController();
      const traceState = {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "running",
        routing: {},
        startedAt: "2026-05-16T00:00:00.000Z",
      } as unknown as ChatTurnTraceRecord;
      const cancelDurableChatRun = vi.fn();
      let resolveStream: (() => void) | undefined;
      const streamReady = new Promise<void>((resolve) => {
        resolveStream = resolve;
      });
      const host: ChatTurnDispatchHost & {
        cancelDurableChatRun: ReturnType<typeof vi.fn>;
        getActiveChatTurnExecution: ReturnType<typeof vi.fn>;
      } = {
        config: {
          assistant: {
            durable: { enabled: false, executionEnabled: false, chatAutoPromoteEnabled: false },
          },
        },
        storage: {
          chatTurnTraces: {
            create: vi.fn(() => traceState),
            patch: vi.fn(() => traceState),
            get: vi.fn(() => traceState),
          },
          durableRuns: { getRun: vi.fn(() => ({ status: "running" })) },
        } as never,
        backgroundTasks: new Set(),
        isFeatureEnabled: vi.fn(() => false),
        streamPersistedChatTurnEvents: vi.fn(async function* () {}),
        persistChatStreamChunk: vi.fn(),
        createHydratedChatTurnTrace: vi.fn((_turnId: string, t: ChatTurnTraceRecord) => t),
        recordDevDiagnostic: vi.fn(),
        finalizeDurableChatRun: vi.fn(),
        completeActiveChatTurnStream: vi.fn(),
        closeActiveChatTurnStream: vi.fn(),
        beginDurableChatRun: vi.fn(() => undefined),
        registerActiveChatTurnStream: vi.fn(),
        ensureSessionInternalToolGrant: vi.fn(),
        requireExecutedToolResult: vi.fn(),
        commsSend: vi.fn(),
        ingestEvent: vi.fn(),
        updateActiveLeafOrThrow: vi.fn(),
        publishRealtime: vi.fn(),
        // The orchestration path registers the active execution -- emulate
        // that registration so the abort listener can find it.
        beginActiveChatTurnExecution: vi.fn(() => activeController),
        endActiveChatTurnExecution: vi.fn(),
        getActiveChatTurnExecution: vi.fn(() => ({ sessionId: "session-1", controller: activeController })),
        markChatTurnCancelled: vi.fn((_sessionId, turnId) => ({
          ...traceState,
          turnId,
          status: "cancelled",
        })),
        cancelDurableChatRun,
        // Intercept the orchestration-path stream by patching the dispatch
        // call to stream a single trace_update before the abort fires.
        turnRuntime: { run: vi.fn(), runStream: vi.fn() },
      } as unknown as ChatTurnDispatchHost & {
        cancelDurableChatRun: ReturnType<typeof vi.fn>;
        getActiveChatTurnExecution: ReturnType<typeof vi.fn>;
      };

      // Mock streamPreparedAgentChatTurn to observe the controller behavior.
      // This is the inline orchestration's source -- the test asserts that
      // when the external signal fires, the active controller is aborted.
      const moduleUnderTest = await import("./chat-turn-stream-service.js");
      const spy = vi.spyOn(moduleUnderTest, "streamPreparedAgentChatTurn");
      spy.mockImplementation(async function* () {
        // Register the active controller in the host (already wired).
        resolveStream?.();
        // Wait until the parent's controller is aborted by the abort listener,
        // then yield a final trace_update and exit cleanly.
        await new Promise<void>((resolve) => {
          if (activeController.signal.aborted) {
            resolve();
            return;
          }
          activeController.signal.addEventListener("abort", () => resolve());
        });
        yield {
          type: "trace_update",
          sessionId: "session-1",
          turnId: "turn-1",
          trace: { ...traceState, status: "cancelled" } as ChatTurnTraceRecord,
        } as ChatStreamChunkDraft;
      } as never);

      const controller = new AbortController();
      const pending = consumePreparedAgentChatTurn(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
        undefined,
        { abortSignal: controller.signal },
      );

      await streamReady;
      expect(activeController.signal.aborted).toBe(false);
      controller.abort();
      const result = await pending;

      expect(activeController.signal.aborted).toBe(true);
      // For the non-durable orchestration path, no durable runId exists so
      // cancelDurableChatRun should not be called.
      expect(cancelDurableChatRun).not.toHaveBeenCalled();
      expect(result.turnId).toBe("turn-1");
      spy.mockRestore();
    });

    it("soft-cancels the durable run AND aborts the active controller when running on the durable branch", async () => {
      const activeController = new AbortController();
      const traceState = {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "running",
        routing: {},
        startedAt: "2026-05-16T00:00:00.000Z",
      } as unknown as ChatTurnTraceRecord;
      const durableRun = { runId: "durable-run-1" } as DurableRunRecord;
      const cancelDurableChatRun = vi.fn();
      let resolveStream: (() => void) | undefined;
      const streamReady = new Promise<void>((resolve) => {
        resolveStream = resolve;
      });

      const host: ChatTurnDispatchHost & {
        cancelDurableChatRun: ReturnType<typeof vi.fn>;
      } = {
        config: {
          assistant: {
            durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true },
          },
        },
        storage: {
          chatTurnTraces: {
            create: vi.fn(() => traceState),
            patch: vi.fn(() => traceState),
            get: vi.fn(() => traceState),
          },
          durableRuns: { getRun: vi.fn(() => ({ status: "running" })) },
        } as never,
        backgroundTasks: new Set(),
        isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
        // eslint-disable-next-line require-yield -- intentionally yields nothing; emulates a stream that ends after abort
        streamPersistedChatTurnEvents: vi.fn(async function* () {
          resolveStream?.();
          // Wait for the abort signal to propagate to the active controller,
          // then close the stream.
          await new Promise<void>((resolve) => {
            if (activeController.signal.aborted) {
              resolve();
              return;
            }
            activeController.signal.addEventListener("abort", () => resolve());
          });
          // Streams typically yield events; here we just end to let the
          // for-await loop exit.
        }),
        persistChatStreamChunk: vi.fn(),
        createHydratedChatTurnTrace: vi.fn((_turnId: string, t: ChatTurnTraceRecord) => t),
        recordDevDiagnostic: vi.fn(),
        finalizeDurableChatRun: vi.fn(),
        completeActiveChatTurnStream: vi.fn(),
        closeActiveChatTurnStream: vi.fn(),
        beginDurableChatRun: vi.fn(() => durableRun),
        registerActiveChatTurnStream: vi.fn(),
        ensureSessionInternalToolGrant: vi.fn(),
        requireExecutedToolResult: vi.fn(),
        commsSend: vi.fn(),
        ingestEvent: vi.fn(),
        updateActiveLeafOrThrow: vi.fn(),
        publishRealtime: vi.fn(),
        beginActiveChatTurnExecution: vi.fn(() => activeController),
        endActiveChatTurnExecution: vi.fn(),
        getActiveChatTurnExecution: vi.fn(() => ({ sessionId: "session-1", controller: activeController })),
        markChatTurnCancelled: vi.fn((_sessionId, turnId) => ({
          ...traceState,
          turnId,
          status: "cancelled",
        })),
        cancelDurableChatRun,
        turnRuntime: { run: vi.fn(), runStream: vi.fn() },
      } as unknown as ChatTurnDispatchHost & { cancelDurableChatRun: ReturnType<typeof vi.fn> };

      const controller = new AbortController();
      const pending = consumePreparedAgentChatTurn(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
        undefined,
        { abortSignal: controller.signal },
      );

      await streamReady;
      expect(activeController.signal.aborted).toBe(false);
      controller.abort();
      await pending;

      // Durable branch: the abort listener must (a) call cancelDurableChatRun
      // with the runId allocated by beginDurableChatRun, and (b) abort the
      // local controller so the await-loop bails out promptly.
      expect(cancelDurableChatRun).toHaveBeenCalledWith("durable-run-1", "abort_signal");
      expect(activeController.signal.aborted).toBe(true);
    });

    it("fires the abort synchronously when the signal is already aborted before consumePreparedAgentChatTurn is invoked", async () => {
      const activeController = new AbortController();
      const traceState = {
        turnId: "turn-1",
        sessionId: "session-1",
        userMessageId: "user-1",
        status: "running",
        routing: {},
        startedAt: "2026-05-16T00:00:00.000Z",
      } as unknown as ChatTurnTraceRecord;
      const cancelDurableChatRun = vi.fn();
      const host: ChatTurnDispatchHost & {
        cancelDurableChatRun: ReturnType<typeof vi.fn>;
      } = {
        config: {
          assistant: { durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true } },
        },
        storage: {
          chatTurnTraces: {
            create: vi.fn(() => traceState),
            patch: vi.fn(() => traceState),
            get: vi.fn(() => traceState),
          },
          durableRuns: { getRun: vi.fn(() => ({ status: "running" })) },
        } as never,
        backgroundTasks: new Set(),
        isFeatureEnabled: vi.fn((flag: string) => flag === "durableKernelV1Enabled"),
        streamPersistedChatTurnEvents: vi.fn(async function* () {
          // The active controller should already be aborted by the time
          // the stream starts; emit nothing and close.
        }),
        persistChatStreamChunk: vi.fn(),
        createHydratedChatTurnTrace: vi.fn((_turnId: string, t: ChatTurnTraceRecord) => t),
        recordDevDiagnostic: vi.fn(),
        finalizeDurableChatRun: vi.fn(),
        completeActiveChatTurnStream: vi.fn(),
        closeActiveChatTurnStream: vi.fn(),
        beginDurableChatRun: vi.fn(() => ({ runId: "durable-run-2" }) as DurableRunRecord),
        registerActiveChatTurnStream: vi.fn(),
        ensureSessionInternalToolGrant: vi.fn(),
        requireExecutedToolResult: vi.fn(),
        commsSend: vi.fn(),
        ingestEvent: vi.fn(),
        updateActiveLeafOrThrow: vi.fn(),
        publishRealtime: vi.fn(),
        beginActiveChatTurnExecution: vi.fn(() => activeController),
        endActiveChatTurnExecution: vi.fn(),
        getActiveChatTurnExecution: vi.fn(() => ({ sessionId: "session-1", controller: activeController })),
        markChatTurnCancelled: vi.fn((_sessionId, turnId) => ({ ...traceState, turnId, status: "cancelled" })),
        cancelDurableChatRun,
        turnRuntime: { run: vi.fn(), runStream: vi.fn() },
      } as unknown as ChatTurnDispatchHost & { cancelDurableChatRun: ReturnType<typeof vi.fn> };

      const controller = new AbortController();
      controller.abort();

      await consumePreparedAgentChatTurn(
        host,
        "session-1",
        { content: "hello", mode: "chat" },
        createPrepared("chat"),
        "chat_thread_turn_appended",
        undefined,
        { abortSignal: controller.signal },
      );

      expect(cancelDurableChatRun).toHaveBeenCalledWith("durable-run-2", "abort_signal");
      expect(activeController.signal.aborted).toBe(true);
    });
  });
});

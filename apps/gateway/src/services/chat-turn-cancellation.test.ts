import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { markChatTurnCancelled, type ChatTurnCancellationDeps } from "./chat-turn-cancellation.js";

describe("markChatTurnCancelled terminal ownership", () => {
  it("preserves a completion that wins between the cancellation read and compare-and-set", () => {
    let trace = createTrace("running");
    const deps = createDeps({
      get: vi.fn(() => trace),
      patchIfStatus: vi.fn(() => {
        trace = createTrace("completed");
        return undefined;
      }),
    });

    const result = markChatTurnCancelled(deps, "session-1", "turn-1", "operator");

    expect(result.status).toBe("completed");
    expect(deps.recordDevDiagnostic).not.toHaveBeenCalled();
    expect(deps.publishRealtime).not.toHaveBeenCalled();
  });

  it("retries when another active-state transition wins before cancellation", () => {
    let trace = createTrace("running");
    let attempts = 0;
    const patchIfStatus = vi.fn(
      (_turnId: string, _expected: readonly ChatTurnTraceRecord["status"][], input: Partial<ChatTurnTraceRecord>) => {
        attempts += 1;
        if (attempts === 1) {
          trace = createTrace("waiting_for_tool");
          return undefined;
        }
        trace = { ...trace, ...input } as ChatTurnTraceRecord;
        return trace;
      },
    );
    const deps = createDeps({
      get: vi.fn(() => trace),
      patchIfStatus,
    });

    const result = markChatTurnCancelled(deps, "session-1", "turn-1", "operator");

    expect(result.status).toBe("cancelled");
    expect(patchIfStatus).toHaveBeenCalledTimes(2);
    expect(deps.recordDevDiagnostic).toHaveBeenCalledTimes(1);
    expect(deps.publishRealtime).toHaveBeenCalledTimes(1);
  });

  it("preserves the admitted assistant identity when reconstructing a missing active trace", () => {
    const createdTrace = createTrace("running");
    const create = vi.fn(() => createdTrace);
    const patchIfStatus = vi.fn(
      (_turnId: string, _expected: readonly ChatTurnTraceRecord["status"][], input: Partial<ChatTurnTraceRecord>) =>
        ({ ...createdTrace, ...input }) as ChatTurnTraceRecord,
    );
    const deps: ChatTurnCancellationDeps = {
      storage: {
        chatTurnTraces: {
          get: vi.fn(() => {
            throw new NotFoundError({ entity: "Chat turn", id: "turn-1" });
          }),
          create,
          patchIfStatus,
        },
        durableRuns: {
          getRun: vi.fn(() => ({ runId: "run-1", status: "running" })),
        },
        chatSessionPrefs: { get: vi.fn(() => undefined) },
      } as never,
      getActiveChatTurnStream: vi.fn(() => ({
        registrationId: "registration-1",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        startedAt: "2026-07-10T00:00:00.000Z",
      })),
      parseDurableChatTurnPayload: vi.fn(
        () =>
          ({
            sessionId: "session-1",
            turnId: "turn-1",
            userMessageId: "user-1",
            assistantMessageId: "assistant-1",
            branchKind: "append",
            request: {},
          }) as never,
      ),
      createHydratedChatTurnTrace: vi.fn((_turnId, trace) => trace),
      recordDevDiagnostic: vi.fn(),
      publishRealtime: vi.fn(() => ({}) as never),
    };

    expect(markChatTurnCancelled(deps, "session-1", "turn-1", "operator").status).toBe("cancelled");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ assistantMessageId: "assistant-1" }));
  });
});

function createDeps(
  chatTurnTraces: Pick<ChatTurnCancellationDeps["storage"]["chatTurnTraces"], "get" | "patchIfStatus">,
): ChatTurnCancellationDeps {
  return {
    storage: {
      chatTurnTraces,
      durableRuns: {} as never,
      chatSessionPrefs: {} as never,
    } as never,
    getActiveChatTurnStream: vi.fn(() => undefined),
    parseDurableChatTurnPayload: vi.fn(() => undefined),
    createHydratedChatTurnTrace: vi.fn((_turnId, trace) => trace),
    recordDevDiagnostic: vi.fn(),
    publishRealtime: vi.fn(() => ({}) as never),
  };
}

function createTrace(status: ChatTurnTraceRecord["status"]): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    branchKind: "append",
    status,
    mode: "chat",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    routing: {},
    startedAt: "2026-07-10T00:00:00.000Z",
  } as ChatTurnTraceRecord;
}

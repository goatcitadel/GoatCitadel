import { describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type { ChatTurnTraceRecord, DurableRunRecord } from "@goatcitadel/contracts";
import {
  answerChatUserInputPrompt,
  getChatThread,
  getTurnContextManifestForSession,
  selectChatBranchTurn,
  type ChatMessageRouteRuntimeHost,
} from "./chat-message-route-runtime.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";

describe("chat-message-route-runtime", () => {
  it("builds chat threads and records branch selection realtime truth", async () => {
    const state = createThreadState();
    const runtime = createRuntime({ state });

    const thread = await getChatThread(runtime, "sess-1");
    expect(thread.activeLeafTurnId).toBe("turn-child-a");
    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-a"]);

    const selected = await selectChatBranchTurn(runtime, "sess-1", "turn-root");

    expect(runtime.storage.chatSessionBranchState.setActiveLeaf).toHaveBeenCalledWith("sess-1", "turn-child-b");
    expect(runtime.publishRealtime).toHaveBeenCalledWith(
      "chat_thread_updated",
      "chat",
      expect.objectContaining({
        type: "chat_thread_branch_selected",
        sessionId: "sess-1",
        turnId: "turn-root",
        activeLeafTurnId: "turn-child-b",
      }),
      expect.objectContaining({
        eventAuthority: "retained_stream",
      }),
    );
    expect(selected.activeLeafTurnId).toBe("turn-child-b");
    expect(selected.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-b"]);
  });

  it("limits generated-artifact lookup to renderable thread turns", async () => {
    const state = createThreadState();
    state.messagesById.delete("user-b");
    state.messagesById.delete("assistant-b");
    const runtime = createRuntime({ state });

    const thread = await getChatThread(runtime, "sess-1");

    expect(thread.turns.map((turn) => turn.turnId)).toEqual(["turn-root", "turn-child-a"]);
    expect(runtime.storage.chatGeneratedArtifacts.listByTurnIds).toHaveBeenCalledWith(["turn-root", "turn-child-a"]);
  });

  it("validates context manifest session and turn identifiers", () => {
    const runtime = createRuntime({
      trace: createTrace({
        turnId: "turn-1",
        sessionId: "sess-1",
      }),
      contextManifest: { manifestId: "manifest-1" },
    });

    expect(() => getTurnContextManifestForSession(runtime, " ", "turn-1")).toThrow(ValidationError);
    expect(() => getTurnContextManifestForSession(runtime, "sess-1", " ")).toThrow(ValidationError);
    expect(() => getTurnContextManifestForSession(runtime, "sess-2", "turn-1")).toThrow("does not belong to session");
    expect(getTurnContextManifestForSession(runtime, "sess-1", "turn-1")).toEqual({ manifestId: "manifest-1" });
  });

  it("rejects inactive or mismatched user-input prompts before waking durable execution", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        status: "completed",
        pendingUserInput: {
          promptId: "prompt-1",
          kind: "text",
          question: "Need detail?",
        },
      }),
    });

    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-1", { kind: "text", text: "details" }),
    ).rejects.toThrow(ValidationError);

    runtime.trace = createTrace({
      status: "waiting_for_user_input",
      pendingUserInput: {
        promptId: "prompt-1",
        kind: "single_select",
        question: "Pick one",
        options: [{ optionId: "a", label: "A" }],
      },
    });

    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "missing", { kind: "single_select", optionId: "a" }),
    ).rejects.toThrow("is not active");
    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-1", { kind: "text", text: "details" }),
    ).rejects.toThrow("expects a single_select response");
    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-1", {
        kind: "single_select",
        optionId: "z",
      }),
    ).rejects.toThrow("is not valid");

    runtime.trace = createTrace({
      status: "waiting_for_user_input",
      pendingUserInput: {
        promptId: "prompt-2",
        kind: "text",
        question: "Add detail",
      },
    });
    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-2", { kind: "text", text: "   " }),
    ).rejects.toThrow("requires non-empty text");
  });

  it("persists text prompt answers and wakes the linked durable chat turn", async () => {
    const runtime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-1" },
        pendingUserInput: {
          promptId: "prompt-text",
          kind: "text",
          title: "Missing input",
          question: "What should happen next?",
        },
      }),
      durableRun: createDurableRun("run-1", "waiting"),
      wakeResult: {
        outcome: "woke",
        run: createDurableRun("run-1", "queued"),
      },
    });

    const result = await answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-text", {
      kind: "text",
      text: "  Continue with the safe path.  ",
    });

    expect(result).toMatchObject({
      ok: true,
      resumed: true,
      resumedRunId: "run-1",
      resumedTurnId: "turn-1",
    });
    expect(runtime.storage.durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        expectedVersion: 3,
        payload: expect.objectContaining({
          userInputResponses: [
            expect.objectContaining({
              promptId: "prompt-text",
              response: { kind: "text", text: "Continue with the safe path." },
            }),
          ],
        }),
      }),
    );
    expect(runtime.durableRunService.wakeDurableRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        eventKey: "chat.user_input.resolved",
        correlationId: "prompt-text",
      }),
    );
    expect(runtime.storage.chatTurnTraces.patch).toHaveBeenCalledWith("turn-1", {
      status: "running",
      pendingUserInput: null,
    });
    expect(runtime.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "chat.user_input_prompt.answered",
        sessionId: "sess-1",
        turnId: "turn-1",
      }),
    );
  });

  it("records selected option details and treats queued durable updates as resumed", async () => {
    const updatedRun = createDurableRun("run-2", "queued");
    const runtime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-2" },
        pendingUserInput: {
          promptId: "prompt-choice",
          kind: "single_select",
          question: "Which branch?",
          options: [{ optionId: "safe", label: "Safe path", description: "Bounded continuation" }],
        },
      }),
      durableRun: createDurableRun("run-2", "waiting"),
      updatedRun,
      wakeResult: {
        outcome: "ignored",
        detail: "already queued",
        run: updatedRun,
      },
    });

    await expect(
      answerChatUserInputPrompt(runtime, "sess-1", "turn-1", "prompt-choice", {
        kind: "single_select",
        optionId: "safe",
      }),
    ).resolves.toMatchObject({ resumed: true });

    expect(runtime.storage.durableRuns.updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          userInputResponses: [
            expect.objectContaining({
              selectedOption: {
                optionId: "safe",
                label: "Safe path",
                description: "Bounded continuation",
              },
            }),
          ],
        }),
      }),
    );
  });

  it("raises conflicts for missing durable links, invalid payloads, and failed wakeups", async () => {
    const noRunRuntime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        pendingUserInput: {
          promptId: "prompt-1",
          kind: "text",
          question: "Continue?",
        },
      }),
    });

    await expect(
      answerChatUserInputPrompt(noRunRuntime, "sess-1", "turn-1", "prompt-1", { kind: "text", text: "yes" }),
    ).rejects.toThrow(ConflictError);

    const invalidPayloadRuntime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-invalid" },
        pendingUserInput: {
          promptId: "prompt-1",
          kind: "text",
          question: "Continue?",
        },
      }),
      durableRun: {
        ...createDurableRun("run-invalid", "waiting"),
        payload: { version: "other" },
      } as DurableRunRecord,
    });

    await expect(
      answerChatUserInputPrompt(invalidPayloadRuntime, "sess-1", "turn-1", "prompt-1", {
        kind: "text",
        text: "yes",
      }),
    ).rejects.toThrow("missing a valid chat turn payload");

    const failedWakeRuntime = createRuntime({
      trace: createTrace({
        status: "waiting_for_user_input",
        durable: { runId: "run-failed" },
        pendingUserInput: {
          promptId: "prompt-1",
          kind: "text",
          question: "Continue?",
        },
      }),
      durableRun: createDurableRun("run-failed", "waiting"),
      updatedRun: createDurableRun("run-failed", "waiting"),
      wakeResult: {
        outcome: "ignored",
        detail: "run is paused",
        run: createDurableRun("run-failed", "waiting"),
      },
    });

    await expect(
      answerChatUserInputPrompt(failedWakeRuntime, "sess-1", "turn-1", "prompt-1", {
        kind: "text",
        text: "yes",
      }),
    ).rejects.toThrow("run is paused");
  });
});

function createRuntime(input: {
  state?: ChatTurnSessionState;
  trace?: Partial<ChatTurnTraceRecord>;
  contextManifest?: Record<string, unknown>;
  durableRun?: DurableRunRecord;
  updatedRun?: DurableRunRecord;
  wakeResult?: Record<string, unknown>;
}): ChatMessageRouteRuntimeHost & { trace: ChatTurnTraceRecord } {
  const runtime = {
    trace: createTrace(input.trace),
    storage: {
      chatGeneratedArtifacts: {
        listByTurnIds: vi.fn(() => new Map()),
      },
      chatSessionBranchState: {
        setActiveLeaf: vi.fn(),
      },
      chatTurnTraces: {
        get: vi.fn(() => runtime.trace),
        patch: vi.fn(),
      },
      contextManifests: {
        maybeGetDetailByTurn: vi.fn(() => input.contextManifest),
      },
      durableRuns: {
        updateRun: vi.fn(() => input.updatedRun ?? createDurableRun("run-updated", "running")),
      },
    },
    durableRunService: {
      getDurableRun: vi.fn(() => input.durableRun ?? createDurableRun("run-1", "waiting")),
      wakeDurableRun: vi.fn(() => input.wakeResult ?? { outcome: "woke", run: createDurableRun("run-1", "queued") }),
    },
    getSession: vi.fn(),
    loadChatTurnSessionState: vi.fn(async () => input.state ?? createThreadState()),
    publishRealtime: vi.fn(),
    recordDevDiagnostic: vi.fn(),
  } as unknown as ChatMessageRouteRuntimeHost & { trace: ChatTurnTraceRecord };
  return runtime;
}

function createThreadState(): ChatTurnSessionState {
  const root = createTrace({
    turnId: "turn-root",
    startedAt: "2026-03-22T12:00:00.000Z",
    userMessageId: "user-root",
    assistantMessageId: "assistant-root",
  });
  const childA = createTrace({
    turnId: "turn-child-a",
    parentTurnId: "turn-root",
    startedAt: "2026-03-22T12:01:00.000Z",
    userMessageId: "user-a",
    assistantMessageId: "assistant-a",
  });
  const childB = createTrace({
    turnId: "turn-child-b",
    parentTurnId: "turn-root",
    startedAt: "2026-03-22T12:02:00.000Z",
    userMessageId: "user-b",
    assistantMessageId: "assistant-b",
  });
  return {
    session: { sessionId: "sess-1" },
    activeLeafTurnId: "turn-child-a",
    traces: [root, childA, childB],
    childrenByTurnId: new Map([["turn-root", ["turn-child-a", "turn-child-b"]]]),
    messagesById: new Map(
      ["user-root", "assistant-root", "user-a", "assistant-a", "user-b", "assistant-b"].map((messageId) => [
        messageId,
        {
          messageId,
          sessionId: "sess-1",
          role: messageId.startsWith("user") ? "user" : "assistant",
          content: messageId,
          timestamp: "2026-03-22T12:00:00.000Z",
        },
      ]),
    ),
  } as ChatTurnSessionState;
}

function createTrace(overrides: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
  return {
    turnId: "turn-1",
    sessionId: "sess-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    status: "completed",
    mode: "chat",
    model: "glm-5",
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    effectiveToolAutonomy: "safe_auto",
    routing: { liveDataIntent: false },
    toolRuns: [],
    citations: [],
    startedAt: "2026-03-22T12:00:00.000Z",
    updatedAt: "2026-03-22T12:00:00.000Z",
    ...overrides,
  } as ChatTurnTraceRecord;
}

function createDurableRun(runId: string, status: string): DurableRunRecord {
  return {
    runId,
    status,
    version: 3,
    payload: {
      version: "chat.turn.execute.v1",
      sessionId: "sess-1",
      turnId: "turn-1",
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "continue" },
    },
  } as DurableRunRecord;
}

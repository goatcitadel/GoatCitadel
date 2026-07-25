import { describe, expect, it } from "vitest";
import {
  isThreadMutatingStreamChunk,
  updateThreadFromStreamChunk,
  type PendingStreamTurnSeed,
} from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";

const sessionId = "session-1";

function userMessage(id = "user-1", content = "Plan the work") {
  return {
    messageId: id,
    sessionId,
    role: "user",
    actorType: "user",
    actorId: "operator",
    content,
    timestamp: "2026-05-04T12:00:00.000Z",
  };
}

function baseTurn(turnId = "turn-1") {
  return {
    turnId,
    userMessage: userMessage(`user-${turnId}`),
    assistantMessage: {
      messageId: `assistant-${turnId}`,
      sessionId,
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "Existing",
      timestamp: "2026-05-04T12:00:01.000Z",
    },
    trace: {
      turnId,
      sessionId,
      userMessageId: `user-${turnId}`,
      assistantMessageId: `assistant-${turnId}`,
      status: "completed",
      mode: "chat",
      toolRuns: [],
      citations: [],
      routing: {},
    },
    toolRuns: [],
    citations: [],
    branch: {
      siblingTurnIds: [turnId],
      activeSiblingIndex: 0,
      siblingCount: 1,
      isSelectedPath: true,
      newestLeafTurnId: turnId,
    },
  };
}

function baseThread() {
  return {
    sessionId,
    selectedTurnId: "turn-2",
    activeLeafTurnId: "turn-2",
    turns: [baseTurn("turn-1"), baseTurn("turn-2"), baseTurn("turn-3")],
  };
}

function seed(): PendingStreamTurnSeed {
  return {
    userMessage: userMessage("user-new", "New prompt"),
    parentTurnId: "turn-2",
    branchKind: "append",
    sourceTurnId: undefined,
    mode: "send",
  } as PendingStreamTurnSeed;
}

describe("chat-thread-reducer", () => {
  it("identifies only thread-mutating stream chunks", () => {
    for (const type of [
      "message_start",
      "delta",
      "message_done",
      "tool_start",
      "tool_result",
      "user_input_required",
      "trace_update",
      "capability_upgrade_suggestion",
      "citation",
    ]) {
      expect(isThreadMutatingStreamChunk({ type } as never)).toBe(true);
    }
    expect(isThreadMutatingStreamChunk({ type: "tool_activity" } as never)).toBe(false);
    expect(isThreadMutatingStreamChunk({ type: "heartbeat" } as never)).toBe(false);
  });

  it("ignores chunks for other sessions and starts optimistic turns from the seed", () => {
    const current = baseThread() as never;
    expect(
      updateThreadFromStreamChunk(
        current,
        { type: "message_start", sessionId: "other-session", turnId: "turn-new" } as never,
        seed(),
        sessionId,
        null,
      ),
    ).toBe(current);
    expect(
      updateThreadFromStreamChunk(
        current,
        { type: "message_start", sessionId, turnId: "turn-new" } as never,
        null,
        sessionId,
        null,
      ),
    ).toBe(current);

    const next = updateThreadFromStreamChunk(
      current,
      {
        type: "message_start",
        sessionId,
        turnId: "turn-new",
        messageId: "assistant-new",
        parentTurnId: "turn-2",
        branchKind: "append",
      } as never,
      seed(),
      sessionId,
      {
        mode: "code",
        providerId: "openai",
        model: "gpt-5.5",
        planningMode: "advisory",
        webMode: "manual",
        memoryMode: "workspace",
        thinkingLevel: "deep",
        speedMode: "fast",
        subagentPolicy: "always",
        toolAutonomy: "auto",
      } as never,
    )!;

    expect(next.turns.map((turn) => turn.turnId)).toEqual(["turn-1", "turn-2", "turn-new"]);
    expect(next.activeLeafTurnId).toBe("turn-new");
    expect(next.selectedTurnId).toBe("turn-new");
    expect(next.turns.at(-1)?.assistantMessage?.content).toBe("");
    expect(next.turns.at(-1)?.trace.mode).toBe("code");
    expect(next.turns.at(-1)?.trace.effectiveToolAutonomy).toBe("manual");
    expect(next.turns.at(-1)?.trace.routing).toMatchObject({
      primaryProviderId: "openai",
      effectiveModel: "gpt-5.5",
    });

    const appendedWithoutKnownParent = updateThreadFromStreamChunk(
      current,
      {
        type: "message_start",
        sessionId,
        turnId: "turn-orphan",
        messageId: "assistant-orphan",
        parentTurnId: "missing-parent",
        branchKind: "append",
      } as never,
      seed(),
      sessionId,
      null,
    )!;
    expect(appendedWithoutKnownParent.turns.map((turn) => turn.turnId)).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
      "turn-orphan",
    ]);
  });

  it("applies streamed deltas and final assistant content", () => {
    const started = updateThreadFromStreamChunk(
      null,
      {
        type: "message_start",
        sessionId,
        turnId: "turn-new",
        messageId: "assistant-new",
        branchKind: "retry",
        sourceTurnId: "turn-old",
      } as never,
      { ...seed(), parentTurnId: undefined, branchKind: "retry", sourceTurnId: "turn-old", mode: "retry" },
      sessionId,
      null,
    )!;
    const withDelta = updateThreadFromStreamChunk(
      started,
      { type: "delta", sessionId, turnId: "turn-new", messageId: "assistant-new", delta: "Hello" } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withDelta.turns[0]?.assistantMessage?.content).toBe("Hello");
    expect(
      updateThreadFromStreamChunk(
        withDelta,
        { type: "delta", sessionId, turnId: "turn-new", messageId: "assistant-new", delta: "" } as never,
        null,
        sessionId,
        null,
      ),
    ).toBe(withDelta);

    const done = updateThreadFromStreamChunk(
      withDelta,
      {
        type: "message_done",
        sessionId,
        turnId: "turn-new",
        messageId: "assistant-final",
        content: "Hello world",
        repaired: true,
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(done.turns[0]?.assistantMessage).toMatchObject({
      messageId: "assistant-final",
      content: "Hello world",
    });
    expect(done.turns[0]?.trace.completion).toMatchObject({
      repaired: true,
      status: "complete",
    });

    expect(
      updateThreadFromStreamChunk(
        done,
        {
          type: "message_done",
          sessionId,
          turnId: "turn-new",
          messageId: "assistant-final",
          content: "Hello world",
        } as never,
        null,
        sessionId,
        null,
      ),
    ).toBe(done);

    const doneWithExistingCompletion = updateThreadFromStreamChunk(
      {
        ...done,
        turns: [
          {
            ...done.turns[0]!,
            trace: {
              ...done.turns[0]!.trace,
              completion: { repaired: true, status: "complete", finishReason: "stop" },
            },
          },
        ],
      } as never,
      {
        type: "message_done",
        sessionId,
        turnId: "turn-new",
        messageId: "assistant-final",
        content: "Hello world",
        repaired: true,
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(doneWithExistingCompletion.turns[0]?.trace.completion).toMatchObject({
      repaired: true,
      finishReason: "stop",
    });
  });

  it("adds assistant messages when deltas and completion arrive before a placeholder exists", () => {
    const current = {
      sessionId,
      selectedTurnId: "turn-1",
      activeLeafTurnId: "turn-1",
      turns: [
        {
          ...baseTurn("turn-1"),
          assistantMessage: undefined,
        },
      ],
    };
    const withDelta = updateThreadFromStreamChunk(
      current as never,
      { type: "delta", sessionId, turnId: "turn-1", delta: "Partial" } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withDelta.turns[0]?.assistantMessage).toMatchObject({
      messageId: "assistant-turn-1",
      content: "Partial",
    });

    const withDone = updateThreadFromStreamChunk(
      { ...current, turns: [{ ...current.turns[0]!, assistantMessage: undefined }] } as never,
      {
        type: "message_done",
        sessionId,
        turnId: "turn-1",
        messageId: "assistant-done",
        content: "Complete",
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withDone.turns[0]?.assistantMessage).toMatchObject({
      messageId: "assistant-done",
      content: "Complete",
    });
  });

  it("replaces tool runs, dedupes citations, and merges trace updates", () => {
    const current = baseThread() as never;
    const toolRun = {
      toolRunId: "tool-1",
      turnId: "turn-2",
      toolName: "web.search",
      status: "running",
      startedAt: "2026-05-04T12:00:02.000Z",
    };
    const withTool = updateThreadFromStreamChunk(
      current,
      { type: "tool_start", sessionId, turnId: "turn-2", toolRun } as never,
      null,
      sessionId,
      null,
    )!;
    const withReplacedTool = updateThreadFromStreamChunk(
      withTool,
      {
        type: "tool_result",
        sessionId,
        turnId: "turn-2",
        toolRun: { ...toolRun, status: "completed", completedAt: "2026-05-04T12:00:03.000Z" },
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withReplacedTool.turns[1]?.toolRuns).toHaveLength(1);
    expect(withReplacedTool.turns[1]?.toolRuns[0]?.status).toBe("completed");

    const withCitation = updateThreadFromStreamChunk(
      withReplacedTool,
      {
        type: "citation",
        sessionId,
        turnId: "turn-2",
        citation: {
          citationId: "cite-1",
          url: " HTTPS://Example.test/Doc ",
          title: "Original title",
          sourceType: "web",
        },
      } as never,
      null,
      sessionId,
      null,
    )!;
    const withSecondCitation = updateThreadFromStreamChunk(
      withCitation,
      {
        type: "citation",
        sessionId,
        turnId: "turn-2",
        citation: {
          citationId: "cite-other",
          url: "https://example.test/other",
          title: "Other title",
          sourceType: "web",
        },
      } as never,
      null,
      sessionId,
      null,
    )!;
    const withMergedCitation = updateThreadFromStreamChunk(
      withSecondCitation,
      {
        type: "citation",
        sessionId,
        turnId: "turn-2",
        citation: {
          citationId: "cite-2",
          url: "https://example.test/doc",
          snippet: "Merged snippet",
          sourceType: "web",
        },
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withMergedCitation.turns[1]?.citations).toEqual([
      {
        citationId: "cite-1",
        url: " HTTPS://Example.test/Doc ",
        title: "Original title",
        snippet: "Merged snippet",
        sourceType: "web",
        knowledge: undefined,
      },
      {
        citationId: "cite-other",
        url: "https://example.test/other",
        title: "Other title",
        sourceType: "web",
      },
    ]);

    const withTrace = updateThreadFromStreamChunk(
      withMergedCitation,
      {
        type: "trace_update",
        sessionId,
        turnId: "turn-2",
        trace: {
          assistantMessageId: "assistant-trace",
          status: "running",
          toolRuns: withMergedCitation.turns[1]?.toolRuns,
          citations: [
            {
              citationId: "knowledge-1",
              url: "memory://one",
              title: "Memory",
              sourceType: "memory",
              knowledge: {
                attachmentId: "attachment-1",
                sourceRef: "source-1",
                retrievalMode: "semantic",
              },
            },
            {
              citationId: "knowledge-2",
              url: "memory://duplicate",
              sourceType: "memory",
              provenance: {
                relationScope: "self",
                freshness: "recent",
                selectionReason: "selected by semantic-hint retrieval score 0.956",
                retrievalStrategy: "semantic_hints",
              },
              knowledge: {
                attachmentId: "attachment-1",
                sourceRef: "source-1",
                retrievalMode: "semantic",
              },
            },
          ],
          routing: { fallbackUsed: true },
          capabilityUpgradeSuggestions: [{ suggestionId: "cap-1", title: "Use skill" }],
        },
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withTrace.turns[1]?.assistantMessage?.messageId).toBe("assistant-trace");
    expect(withTrace.turns[1]?.trace.routing).toEqual({ fallbackUsed: true });
    expect(withTrace.turns[1]?.citations).toHaveLength(1);
    expect(withTrace.turns[1]?.citations[0]?.provenance?.selectionReason).toBe(
      "selected by semantic-hint retrieval score 0.956",
    );

    const noAssistantTrace = updateThreadFromStreamChunk(
      {
        ...current,
        turns: [{ ...current.turns[0]!, assistantMessage: undefined }],
      } as never,
      {
        type: "trace_update",
        sessionId,
        turnId: "turn-1",
        trace: { assistantMessageId: "assistant-from-trace" },
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(noAssistantTrace.turns[0]?.assistantMessage).toBeUndefined();
    expect(noAssistantTrace.turns[0]?.trace.assistantMessageId).toBe("assistant-from-trace");
  });

  it("updates capability suggestions, user-input waits, and leaves unknown turn chunks unchanged", () => {
    const current = baseThread() as never;
    const withSuggestions = updateThreadFromStreamChunk(
      current,
      {
        type: "capability_upgrade_suggestion",
        sessionId,
        turnId: "turn-2",
        capabilityUpgradeSuggestions: [{ suggestionId: "cap-1", title: "Install helper" }],
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withSuggestions.turns[1]?.trace.capabilityUpgradeSuggestions).toEqual([
      { suggestionId: "cap-1", title: "Install helper" },
    ]);

    const withPrompt = updateThreadFromStreamChunk(
      withSuggestions,
      {
        type: "user_input_required",
        sessionId,
        turnId: "turn-2",
        prompt: { promptId: "prompt-1", message: "Need a decision" },
      } as never,
      null,
      sessionId,
      null,
    )!;
    expect(withPrompt.turns[1]?.trace.status).toBe("waiting_for_user_input");
    expect(withPrompt.turns[1]?.trace.pendingUserInput).toEqual({ promptId: "prompt-1", message: "Need a decision" });

    expect(
      updateThreadFromStreamChunk(
        withPrompt,
        { type: "delta", sessionId, turnId: "missing-turn", delta: "ignored" } as never,
        null,
        sessionId,
        null,
      ),
    ).toBe(withPrompt);
    expect(
      updateThreadFromStreamChunk(
        withPrompt,
        { type: "heartbeat", sessionId, turnId: "turn-2" } as never,
        null,
        sessionId,
        null,
      ),
    ).toBe(withPrompt);
    expect(
      updateThreadFromStreamChunk(null, { type: "delta", sessionId, delta: "ignored" } as never, null, sessionId, null),
    ).toBeNull();
  });

  it("updates the existing turn in place when a message_start is replayed with a parentTurnId", () => {
    const current = baseThread();
    const withToolRun = {
      ...current,
      turns: current.turns.map((turn) =>
        turn.turnId === "turn-2"
          ? {
              ...turn,
              trace: { ...turn.trace, status: "running" },
              toolRuns: [
                {
                  toolRunId: "tool-1",
                  toolName: "web.search",
                  status: "started",
                  startedAt: "2026-05-04T12:00:02.000Z",
                },
              ],
            }
          : turn,
      ),
    };

    const next = updateThreadFromStreamChunk(
      withToolRun as never,
      {
        type: "message_start",
        sessionId,
        turnId: "turn-2",
        messageId: "assistant-2b",
        parentTurnId: "turn-1",
        branchKind: "retry",
      } as never,
      null, // the replay path must not require a seed
      sessionId,
      null,
    );

    expect(next).not.toBeNull();
    // No parent-slice truncation and no duplicate append: same three turns.
    expect(next!.turns).toHaveLength(3);
    expect(next!.turns.filter((turn) => turn.turnId === "turn-2")).toHaveLength(1);
    const replayed = next!.turns.find((turn) => turn.turnId === "turn-2")!;
    // Accumulated tool runs survive the replay; the assistant slot resets.
    expect(replayed.toolRuns).toHaveLength(1);
    expect(replayed.toolRuns[0]).toMatchObject({ toolRunId: "tool-1" });
    expect(replayed.assistantMessage).toMatchObject({ messageId: "assistant-2b", content: "" });
    expect(replayed.trace).toMatchObject({ assistantMessageId: "assistant-2b", status: "running" });
    expect(replayed.userMessage).toEqual(withToolRun.turns[1]!.userMessage);
    // Untouched turns keep their identity.
    expect(next!.turns[0]).toBe(withToolRun.turns[0] as never);
    expect(next!.turns[2]).toBe(withToolRun.turns[2] as never);
    expect(next!.activeLeafTurnId).toBe("turn-2");
    expect(next!.selectedTurnId).toBe("turn-2");
  });

  it("does not append a duplicate turn when a message_start is replayed without a parentTurnId", () => {
    const current = baseThread();
    const next = updateThreadFromStreamChunk(
      current as never,
      { type: "message_start", sessionId, turnId: "turn-1", messageId: "assistant-1b" } as never,
      seed(),
      sessionId,
      null,
    );
    expect(next!.turns).toHaveLength(3);
    expect(next!.turns.filter((turn) => turn.turnId === "turn-1")).toHaveLength(1);
    expect(next!.turns.find((turn) => turn.turnId === "turn-1")!.assistantMessage?.messageId).toBe("assistant-1b");
  });
});

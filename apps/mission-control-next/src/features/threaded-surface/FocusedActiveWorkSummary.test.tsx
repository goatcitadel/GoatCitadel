import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { FocusedActiveWorkSummary, deriveFocusedActiveWorkState } from "./FocusedActiveWorkSummary";

describe("FocusedActiveWorkSummary", () => {
  it("turns a missing project folder into a human-first recovery path", () => {
    const state = deriveFocusedActiveWorkState({
      turn: failedFolderTurn(),
      streamStatus: "idle",
    });

    expect(state).toMatchObject({
      kind: "folder_failure",
      title: "I couldn’t access the selected project folder",
      detail: "Tell me the correct relative project folder, then retry the step.",
      canRetry: true,
    });
    expect(JSON.stringify(state)).not.toContain("ENOENT");
    expect(JSON.stringify(state)).not.toContain("F:\\\\code");
  });

  it("keeps an approval actionable without exposing diagnostics", () => {
    const state = deriveFocusedActiveWorkState({
      turn: failedFolderTurn(),
      streamStatus: "idle",
      pendingApproval: { reason: "This tool needs your confirmation." },
    });

    expect(state).toEqual({
      kind: "approval",
      title: "Waiting for your approval",
      detail: "This tool needs your confirmation.",
      turnId: "turn-1",
      canRetry: false,
      canStop: false,
    });
  });

  it("turns a transport error without a canonical failed turn into a human-first retry", () => {
    const onFocusComposer = vi.fn();
    const rawError = "Gateway stream dropped: ECONNRESET for request req-123";
    const state = deriveFocusedActiveWorkState({
      turn: null,
      streamStatus: "error",
      streamError: rawError,
    });

    expect(state).toMatchObject({
      kind: "stream_error",
      title: "I couldn’t complete that response",
      canRetry: false,
    });
    expect(JSON.stringify(state)).not.toContain("ECONNRESET");
    expect(JSON.stringify(state)).not.toContain("req-123");

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <FocusedActiveWorkSummary
          state={state}
          onFocusComposer={onFocusComposer}
          onOpenActivity={vi.fn()}
          onOpenApprovals={vi.fn()}
          onRetry={vi.fn()}
          onStop={vi.fn()}
        />,
      );
    });

    expect(buttonLabels(renderer)).toContain("Try again");
    expect(JSON.stringify(renderer.toJSON())).not.toContain(rawError);
    act(() => {
      findButton(renderer, "Try again").props.onClick();
    });
    expect(onFocusComposer).toHaveBeenCalledOnce();
  });

  it("keeps arbitrary tool recovery diagnostics out of the compact failure summary", () => {
    const turn = failedFolderTurn();
    turn.trace.failure = undefined;
    turn.toolRuns = [
      {
        toolRunId: "tool-1",
        toolName: "browser.navigate",
        status: "blocked",
        error: "host access denied",
        failureGuidance:
          "Host internal.example.test is not allowlisted; source path F:\\private\\project; effect truth: uncertain.",
      },
    ] as any;

    const state = deriveFocusedActiveWorkState({ turn, streamStatus: "idle" });

    expect(state).toMatchObject({
      kind: "failure",
      title: "That step is blocked",
      detail: "Review the required approval or access setting in Activity, then continue.",
    });
    expect(JSON.stringify(state)).not.toContain("internal.example.test");
    expect(JSON.stringify(state)).not.toContain("F:\\private");
    expect(JSON.stringify(state)).not.toContain("effect truth");
  });

  it("focuses the composer for an honest folder correction and keeps retry under More", () => {
    const onFocusComposer = vi.fn();
    const onRetry = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <FocusedActiveWorkSummary
          state={deriveFocusedActiveWorkState({ turn: failedFolderTurn(), streamStatus: "idle" })}
          onFocusComposer={onFocusComposer}
          onOpenActivity={vi.fn()}
          onOpenApprovals={vi.fn()}
          onRetry={onRetry}
          onStop={vi.fn()}
        />,
      );
    });

    expect(buttonLabels(renderer)).toContain("Tell me the correct folder");
    expect(buttonLabels(renderer)).toContain("View activity");
    expect(renderer.root.findByType("details").props.open).toBe(false);
    act(() => {
      findButton(renderer, "Tell me the correct folder").props.onClick();
    });
    expect(onFocusComposer).toHaveBeenCalledOnce();

    // Native <details> owns its own open state in the browser; the retry is
    // present in the closed disclosure and becomes available when More opens.
    findButton(renderer, "Retry").props.onClick();
    expect(onRetry).toHaveBeenCalledWith("turn-1");
  });

  it("closes More when a later folder recovery replaces the active turn", () => {
    const firstState = deriveFocusedActiveWorkState({ turn: failedFolderTurn(), streamStatus: "idle" });
    if (!firstState) throw new Error("Expected folder recovery state");
    const secondState = { ...firstState, turnId: "turn-2" };
    const callbacks = {
      onFocusComposer: vi.fn(),
      onOpenActivity: vi.fn(),
      onOpenApprovals: vi.fn(),
      onRetry: vi.fn(),
      onStop: vi.fn(),
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<FocusedActiveWorkSummary state={firstState} {...callbacks} />);
    });

    const more = renderer.root.findByType("details");
    act(() => {
      more.props.onToggle({ currentTarget: { open: true } });
    });
    expect(renderer.root.findByType("details").props.open).toBe(true);

    act(() => {
      renderer.update(<FocusedActiveWorkSummary state={secondState} {...callbacks} />);
    });
    expect(renderer.root.findByType("details").props.open).toBe(false);
  });
});

function failedFolderTurn(): ChatThreadTurnRecord {
  return {
    turnId: "turn-1",
    branchKind: "append",
    userMessage: { messageId: "message-1", role: "user", content: "List files", timestamp: "2026-08-15T00:00:00.000Z" },
    trace: {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      branchKind: "append",
      status: "failed",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-08-15T00:00:00.000Z",
      failure: {
        failureClass: "tool_failed",
        message: "ENOENT: no such file or directory, scandir 'F:\\code\\personal-ai\\workspace\\demo'",
        retryable: true,
      },
      toolRuns: [],
      citations: [],
      routing: {},
    },
    toolRuns: [],
    citations: [],
    branch: {
      siblingTurnIds: ["turn-1"],
      siblingCount: 1,
      activeSiblingIndex: 0,
      isSelectedPath: true,
    },
  } as unknown as ChatThreadTurnRecord;
}

function buttonLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType("button").map((button) => button.children.join(""));
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === label);
  if (!button) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

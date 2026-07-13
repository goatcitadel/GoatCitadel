// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadedTimeline } from "./ThreadedTimeline";

function buildProps(overrides: Record<string, unknown> = {}): any {
  const turn = {
    turnId: "turn-1",
    branchKind: "append",
    userMessage: {
      messageId: "user-1",
      sessionId: "session-1",
      role: "user",
      actorType: "operator",
      actorId: "operator",
      content: "Review this code path.",
      timestamp: "2026-05-15T00:00:00.000Z",
      attachments: [],
    },
    assistantMessage: {
      messageId: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "Initial answer.",
      timestamp: "2026-05-15T00:00:01.000Z",
    },
    trace: {
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      branchKind: "append",
      status: "completed",
      mode: "code",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-05-15T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      routing: {
        primaryProviderId: "openai",
        primaryModel: "gpt-5",
        effectiveProviderId: "anthropic",
        effectiveModel: "claude-sonnet-5",
        effectiveApiStyle: "messages",
        fallbackUsed: true,
      },
      capabilityUpgradeSuggestions: [{ title: "Enable repository tools" }],
    },
    toolRuns: [],
    citations: [],
    branch: {
      siblingTurnIds: ["turn-0", "turn-1", "turn-2"],
      siblingCount: 3,
      activeSiblingIndex: 1,
      isSelectedPath: true,
      newestLeafTurnId: "turn-2",
    },
  };

  return {
    mode: "code",
    loading: false,
    thread: {
      sessionId: "session-1",
      activeLeafTurnId: "turn-2",
      selectedTurnId: "turn-1",
      turns: [turn],
    },
    selectedTurnId: "turn-1",
    delegationRun: {
      label: "Code QA",
      objective: "Validate code branch rendering.",
      mode: "parallel",
      status: "failed",
      attachedTurnId: "turn-1",
      stitchedOutput: "## QA output\n\nNon-cowork stitched output.",
      steps: [
        {
          stepId: "step-1",
          role: "reviewer",
          label: "",
          status: "failed",
          index: 0,
          summary: "Reviewer found a failure.",
          error: "Static analysis failed.",
        },
        {
          stepId: "step-2",
          role: "qa",
          label: "Verification",
          status: "skipped",
          index: 1,
        },
      ],
    },
    notices: [],
    followOutput: false,
    streamStatus: "idle",
    queuedCount: 0,
    streamError: null,
    eventStreamStatus: { state: "open", reconnectAttempts: 0 },
    pendingApproval: null,
    pendingUserInput: null,
    workspaceId: "default",
    approvalPending: false,
    userInputPending: false,
    onRefreshThread: vi.fn(),
    onBottomStateChange: vi.fn(),
    onSelectTurn: vi.fn(),
    onSwitchBranch: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onOpenGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifact: vi.fn(),
    onCreateGeneratedArtifactVersion: vi.fn(),
    onApprovePending: vi.fn(),
    onDenyPending: vi.fn(),
    onSubmitUserInput: vi.fn(),
    ...overrides,
  };
}

function renderTimeline(props: any): string {
  return renderToStaticMarkup(createElement(ThreadedTimeline, { props }));
}

describe("ThreadedTimeline loop 25 branch tails", () => {
  it("renders non-cowork delegation status, fallback routing, branch switchers, and stitched output", () => {
    const markup = renderTimeline(buildProps());

    expect(markup).toContain("Code QA");
    expect(markup).toContain("failed");
    expect(markup).toContain("Reviewer");
    expect(markup).toContain("Static analysis failed.");
    expect(markup).toContain("Non-cowork stitched output.");
    expect(markup).toContain("used anthropic");
    expect(markup).toContain("requested openai");
    expect(markup).toContain("fallback used");
    expect(markup).toContain("Enable repository tools");
    expect(markup).toContain("2 / 3");
  });

  it("keeps the delegation summary absent when no active delegation run is attached", () => {
    const markup = renderTimeline(buildProps({ delegationRun: null }));

    expect(markup).not.toContain("Code QA");
    expect(markup).toContain("Initial answer.");
  });

  it("covers alternate delegation status tones without changing status copy", () => {
    const coworkProps = buildProps();
    coworkProps.mode = "cowork";
    if (!coworkProps.delegationRun || !coworkProps.delegationRun.steps[0]) {
      throw new Error("expected delegation fixture");
    }
    coworkProps.delegationRun.status = "partial";
    coworkProps.delegationRun.steps[0].status = "completed";
    const coworkMarkup = renderTimeline(coworkProps);
    expect(coworkMarkup).toContain("partial");
    expect(coworkMarkup).toContain("Agentic activity");

    const completedProps = buildProps();
    if (!completedProps.delegationRun) {
      throw new Error("expected delegation fixture");
    }
    completedProps.delegationRun.status = "completed";
    const completedMarkup = renderTimeline(completedProps);
    expect(completedMarkup).toContain("completed");
  });
});

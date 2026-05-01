import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadedTimeline } from "./ThreadedTimeline";

function buildProps(overrides: Partial<any> = {}) {
  return {
    mode: "cowork",
    loading: false,
    thread: {
      sessionId: "session-1",
      activeLeafTurnId: "turn-1",
      selectedTurnId: "turn-1",
      turns: [
        {
          turnId: "turn-1",
          userMessage: {
            messageId: "user-1",
            sessionId: "session-1",
            role: "user",
            actorType: "operator",
            actorId: "user",
            content: "Plan a cozy cyberpunk dinner party.",
            timestamp: "2026-04-30T00:00:00.000Z",
            attachments: [],
          },
          assistantMessage: {
            messageId: "assistant-1",
            sessionId: "session-1",
            role: "assistant",
            actorType: "agent",
            actorId: "assistant",
            content: "## Dinner Party Plan\n\nMain synthesized answer.",
            timestamp: "2026-04-30T00:00:01.000Z",
          },
          trace: {
            turnId: "turn-1",
            sessionId: "session-1",
            userMessageId: "user-1",
            branchKind: "append",
            status: "completed",
            mode: "cowork",
            webMode: "off",
            memoryMode: "off",
            thinkingLevel: "standard",
            startedAt: "2026-04-30T00:00:00.000Z",
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
            newestLeafTurnId: "turn-1",
          },
        },
      ],
    },
    selectedTurnId: "turn-1",
    delegationRun: {
      label: "Cowork",
      objective: "Plan a cozy cyberpunk dinner party.",
      mode: "sequential",
      status: "running",
      attachedTurnId: "turn-1",
      steps: [
        {
          stepId: "step-1",
          role: "worker",
          label: "Menu",
          status: "completed",
          index: 0,
          summary: "Menu section is ready.",
          output: "Full menu child output.",
        },
        {
          stepId: "step-2",
          role: "worker",
          label: "Atmosphere",
          status: "running",
          index: 1,
          summary: "Atmosphere section is in progress.",
        },
      ],
    },
    notices: [],
    followOutput: false,
    streamStatus: "streaming",
    queuedCount: 0,
    streamError: null,
    eventStreamStatus: "connected",
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

describe("ThreadedTimeline", () => {
  it("folds Cowork subagent activity behind an expandable card", () => {
    const markup = renderToStaticMarkup(<ThreadedTimeline props={buildProps() as any} />);

    expect(markup).toContain("Cowork activity");
    expect(markup).toContain("Now: Atmosphere");
    expect(markup).toContain("Open details");
    expect(markup).toContain("Menu");
    expect(markup).toContain("Show subagent output");
    expect(markup).not.toContain("<details open");
  });
});

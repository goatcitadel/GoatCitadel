import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hookMocks = vi.hoisted(() => ({
  useChatWorkbench: vi.fn(),
  useRefreshSubscription: vi.fn(),
}));

vi.mock("./useChatWorkbench", () => ({
  useChatWorkbench: hookMocks.useChatWorkbench,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: hookMocks.useRefreshSubscription,
}));

import { useChatDockWorkbenchController } from "./useChatDockWorkbenchController";

const workbenchReturn = {
  workbenchState: { worktree: null },
  workbenchTree: [{ path: "src/index.ts" }],
  selectedWorkbenchFile: "src/index.ts",
  selectedWorkbenchFileDiff: null,
  workbenchDraftContent: "draft",
  workbenchExpandedPaths: ["src"],
  workbenchDiff: "diff",
  workbenchOutput: "output",
  workbenchLoading: false,
  workbenchBusy: false,
  workbenchSaving: false,
  workbenchError: null,
  hasDirtyWorkbenchDraft: true,
  setWorkbenchDraftContent: vi.fn(),
  setWorkbenchExpandedPaths: vi.fn(),
  refreshWorkbench: vi.fn(),
  createWorkbenchWorktree: vi.fn(),
  openWorkbenchFile: vi.fn(),
  saveWorkbenchFile: vi.fn(),
  discardWorkbenchDraft: vi.fn(),
  runWorkbenchValidationCommand: vi.fn(),
  applyWorkbenchPatch: vi.fn(),
  exportWorkbenchPatch: vi.fn(),
  revertWorkbenchFile: vi.fn(),
  revertWorkbenchAll: vi.fn(),
};

const thread = {
  sessionId: "session-1",
  turns: [
    {
      turnId: "turn-1",
      userMessage: { messageId: "message-1", role: "user", content: "Plan", createdAt: "2026-05-01T00:00:00Z" },
      trace: { orchestration: null, status: "completed", toolRuns: [], routing: {} },
    },
    {
      turnId: "turn-2",
      userMessage: { messageId: "message-2", role: "user", content: "Run", createdAt: "2026-05-01T00:00:01Z" },
      assistantMessage: {
        messageId: "message-3",
        role: "assistant",
        content: "Working",
        createdAt: "2026-05-01T00:00:02Z",
      },
      trace: {
        status: "running",
        toolRuns: [],
        routing: {},
        orchestration: {
          runId: "run-1",
          status: "running",
          steps: [
            {
              stepId: "step-1",
              role: "Researcher",
              status: "running",
              summary: "Collecting sources",
              providerId: "openai",
              model: "gpt-5.5",
            },
          ],
        },
      },
    },
  ],
} as unknown as ChatThreadResponse;

let latest: ReturnType<typeof useChatDockWorkbenchController> | null = null;

function Harness(props: {
  messageMode?: "chat" | "cowork" | "code";
  selectedSessionId?: string | null;
  selectedTurn?: ChatThreadResponse["turns"][number] | null;
}) {
  const selectedSessionId = props.selectedSessionId === undefined ? "session-1" : props.selectedSessionId;
  latest = useChatDockWorkbenchController({
    messageMode: props.messageMode ?? "code",
    selectedSessionId,
    selectedSession: selectedSessionId ? { projectId: "project-1" } : null,
    selectedTurn: props.selectedTurn ?? null,
    thread,
    messages: [
      { messageId: "message-1", role: "user", content: "Plan", createdAt: "2026-05-01T00:00:00Z" },
      { messageId: "message-3", role: "assistant", content: "Working", createdAt: "2026-05-01T00:00:02Z" },
    ] as never,
    localNotices: [{ id: "notice-1", content: "Queued", tone: "warning" }] as never,
    dockSectionOrder: ["session", "trace", "workflow", "memory"] as never,
  });
  return null;
}

describe("useChatDockWorkbenchController", () => {
  beforeEach(() => {
    latest = null;
    hookMocks.useChatWorkbench.mockReset();
    hookMocks.useRefreshSubscription.mockReset();
    hookMocks.useChatWorkbench.mockReturnValue(workbenchReturn);
  });

  it("enables workbench hydration for a selected session in canonical Chat", async () => {
    await act(async () => {
      create(<Harness messageMode="chat" selectedSessionId="session-1" />);
    });

    expect(hookMocks.useChatWorkbench).toHaveBeenCalledWith({
      sessionId: "session-1",
      enabled: true,
    });
    expect(hookMocks.useRefreshSubscription).toHaveBeenCalledWith(
      "chat",
      expect.any(Function),
      expect.objectContaining({ enabled: false, coalesceMs: 800 }),
    );
    expect(latest!.workbenchTree).toEqual(workbenchReturn.workbenchTree);
    expect(latest!.activeWorkflowTurn?.turnId).toBe("turn-2");
    expect(latest!.latestOrchestration).toMatchObject({ runId: "run-1", status: "running" });
    expect(latest!.selectedSessionProjectValue).toBe("project-1");
    expect(latest!.dockSectionStyle("session" as never)).toEqual({ order: 0 });
    expect(latest!.dockSectionStyle("artifact" as never)).toEqual({ order: 0 });
    expect(latest!.coworkItems.length).toBeGreaterThan(0);

    await act(async () => {
      await hookMocks.useRefreshSubscription.mock.calls[0]?.[1]?.();
    });
    expect(latest!.orchestrationRun).toBeNull();
  });

  it("resets dock state when the message mode changes and disables workbench without a selected session", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness messageMode="code" selectedSessionId={null} />);
    });
    expect(hookMocks.useChatWorkbench).toHaveBeenLastCalledWith({
      sessionId: null,
      enabled: false,
    });

    act(() => {
      latest!.setDockOpen(true);
    });
    expect(latest!.dockOpen).toBe(true);

    await act(async () => {
      renderer.update(<Harness messageMode="chat" selectedSessionId={null} />);
    });
    expect(latest!.dockOpen).toBe(false);
    expect(latest!.orchestrationRun).toBeNull();
    expect(latest!.orchestrationCheckpoints).toEqual([]);
    expect(latest!.orchestrationLoading).toBe(false);
    expect(latest!.orchestrationError).toBeNull();
  });

  it("uses the selected orchestration turn ahead of the latest workflow turn", async () => {
    await act(async () => {
      create(
        <Harness
          messageMode="cowork"
          selectedTurn={{
            ...thread.turns[0],
            trace: {
              ...thread.turns[0]!.trace,
              orchestration: { runId: "selected-run", status: "completed", steps: [] },
            },
          }}
        />,
      );
    });

    expect(latest!.activeWorkflowTurn?.turnId).toBe("turn-1");
    expect(latest!.latestOrchestration).toMatchObject({ runId: "selected-run" });
  });
});

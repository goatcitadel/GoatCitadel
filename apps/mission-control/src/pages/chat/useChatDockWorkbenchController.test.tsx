import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { defaultDockOpenForMode } from "./surface-config";
import { useChatDockWorkbenchController } from "./useChatDockWorkbenchController";

const platformMocks = vi.hoisted(() => ({
  fetchOrchestrationRun: vi.fn(async () => ({
    runId: "orch-run-1",
    planId: "plan-1",
    status: "paused",
    startedAt: "2026-04-19T00:00:00.000Z",
    totalCostUsd: 0,
    totalIterations: 1,
    durableRunId: "durable-run-1",
    executionState: "paused_for_approval",
    worktreeStatus: "ready",
  })),
  fetchOrchestrationRunCheckpoints: vi.fn(async () => ({
    items: [
      {
        checkpointId: "cp-1",
        runId: "orch-run-1",
        planId: "plan-1",
        checkpointKind: "run_paused_for_approval",
        details: {},
        createdAt: "2026-04-19T00:00:01.000Z",
      },
    ],
  })),
}));

vi.mock("./useChatWorkbench", () => ({
  useChatWorkbench: vi.fn(() => ({
    workbenchState: { baseRef: "main" },
    workbenchTree: [],
    selectedWorkbenchFile: null,
    workbenchDiff: null,
    workbenchOutput: null,
    workbenchLoading: false,
    workbenchBusy: false,
    workbenchError: null,
    refreshWorkbench: vi.fn(),
    createWorkbenchWorktree: vi.fn(),
    openWorkbenchFile: vi.fn(),
  })),
}));

vi.mock("../../api/platform", () => ({
  fetchOrchestrationRun: platformMocks.fetchOrchestrationRun,
  fetchOrchestrationRunCheckpoints: platformMocks.fetchOrchestrationRunCheckpoints,
}));

let latest: ReturnType<typeof useChatDockWorkbenchController> | null = null;

function Harness(props: { mode: "chat" | "cowork" | "code" }) {
  latest = useChatDockWorkbenchController({
    messageMode: props.mode,
    selectedSessionId: "session-1",
    selectedSession: { projectId: "project-1" },
    selectedTurn: {
      turnId: "turn-1",
      trace: {
        orchestration: { phase: "active", runId: "orch-run-1", steps: [] },
      },
    } as any,
    thread: {
      turns: [],
    } as any,
    messages: [],
    localNotices: [],
    dockSectionOrder: ["workflow", "surface", "trace"],
  });
  return null;
}

describe("useChatDockWorkbenchController", () => {
  it("resets dock openness when the surface mode changes", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness mode="chat" />);
    });
    expect(latest?.dockOpen).toBe(false);

    await act(async () => {
      renderer.update(<Harness mode="code" />);
    });
    expect(latest?.dockOpen).toBe(defaultDockOpenForMode("code", undefined));
  });

  it("loads canonical orchestration truth for cowork mode", async () => {
    await act(async () => {
      create(<Harness mode="cowork" />);
    });

    expect(platformMocks.fetchOrchestrationRun).toHaveBeenCalledWith("orch-run-1");
    expect(platformMocks.fetchOrchestrationRunCheckpoints).toHaveBeenCalledWith("orch-run-1");
    expect(latest?.orchestrationRun?.durableRunId).toBe("durable-run-1");
    expect(latest?.orchestrationCheckpoints).toHaveLength(1);
    expect(latest?.orchestrationLoading).toBe(false);
  });
});

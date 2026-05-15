import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const refreshSubscriptionMocks = vi.hoisted(() => ({
  callback: null as
    | ((signal: { topic: "chat"; timestamp: number; reason: string; source?: string }) => Promise<void> | void)
    | null,
  options: null as { enabled?: boolean; coalesceMs?: number; staleMs?: number; pollIntervalMs?: number } | null,
  topic: null as string | null,
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

vi.mock("../../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: vi.fn((topic, callback, options) => {
    refreshSubscriptionMocks.topic = topic;
    refreshSubscriptionMocks.callback = callback;
    refreshSubscriptionMocks.options = options ?? null;
  }),
}));

let latest: ReturnType<typeof useChatDockWorkbenchController> | null = null;

function Harness(props: {
  mode: "chat" | "cowork" | "code";
  selectedSession?: { projectId?: string | null } | null;
  selectedTurn?: any;
  thread?: any;
  messages?: any[];
  localNotices?: any[];
  dockSectionOrder?: any[];
}) {
  latest = useChatDockWorkbenchController({
    messageMode: props.mode,
    selectedSessionId: "session-1",
    selectedSession: props.selectedSession === undefined ? { projectId: "project-1" } : props.selectedSession,
    selectedTurn:
      props.selectedTurn === undefined
        ? ({
            turnId: "turn-1",
            trace: {
              orchestration: { phase: "active", runId: "orch-run-1", steps: [] },
            },
          } as any)
        : props.selectedTurn,
    thread:
      props.thread === undefined
        ? ({
            turns: [],
          } as any)
        : props.thread,
    messages: props.messages ?? [],
    localNotices: props.localNotices ?? [],
    dockSectionOrder: props.dockSectionOrder ?? ["workflow", "surface", "trace"],
  });
  return null;
}

describe("useChatDockWorkbenchController", () => {
  beforeEach(() => {
    latest = null;
    refreshSubscriptionMocks.callback = null;
    refreshSubscriptionMocks.options = null;
    refreshSubscriptionMocks.topic = null;
    platformMocks.fetchOrchestrationRun.mockReset();
    platformMocks.fetchOrchestrationRun.mockResolvedValue({
      runId: "orch-run-1",
      planId: "plan-1",
      status: "paused",
      startedAt: "2026-04-19T00:00:00.000Z",
      totalCostUsd: 0,
      totalIterations: 1,
      durableRunId: "durable-run-1",
      executionState: "paused_for_approval",
      worktreeStatus: "ready",
    });
    platformMocks.fetchOrchestrationRunCheckpoints.mockReset();
    platformMocks.fetchOrchestrationRunCheckpoints.mockResolvedValue({
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
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("clears orchestration state outside cowork mode or without a canonical run", async () => {
    await act(async () => {
      create(<Harness mode="chat" />);
    });
    expect(latest?.orchestrationRun).toBeNull();
    expect(latest?.orchestrationCheckpoints).toEqual([]);
    expect(latest?.orchestrationError).toBeNull();
    expect(refreshSubscriptionMocks.options?.enabled).toBe(false);

    await act(async () => {
      create(
        <Harness
          mode="cowork"
          selectedTurn={{ turnId: "turn-empty", trace: {} }}
          thread={{ turns: [{ turnId: "turn-empty", trace: {} }] }}
        />,
      );
    });
    expect(platformMocks.fetchOrchestrationRun).not.toHaveBeenCalled();
    expect(latest?.orchestrationRun).toBeNull();
  });

  it("falls back to thread orchestration, cowork items, project defaults, and dock ordering", async () => {
    await act(async () => {
      create(
        <Harness
          mode="cowork"
          selectedSession={{ projectId: null }}
          selectedTurn={{ turnId: "turn-selected", trace: {} }}
          thread={{
            turns: [
              {
                turnId: "turn-latest",
                trace: {
                  orchestration: {
                    phase: "active",
                    runId: "orch-run-1",
                    steps: [{ id: "step-1", label: "Review", status: "running" }],
                  },
                },
              },
            ],
          }}
          messages={[{ messageId: "message-1", role: "assistant", content: "Working" }]}
          localNotices={[{ id: "notice-1", content: "Queued", tone: "neutral" }]}
          dockSectionOrder={["trace", "workflow"]}
        />,
      );
    });

    expect(latest?.activeWorkflowTurn?.turnId).toBe("turn-latest");
    expect(latest?.latestOrchestration?.runId).toBe("orch-run-1");
    expect(latest?.selectedSessionProjectValue).toBe("none");
    expect(latest?.dockSectionStyle("trace" as any)).toEqual({ order: 0 });
    expect(latest?.dockSectionStyle("surface" as any)).toEqual({ order: 0 });
    expect(latest?.coworkItems.length).toBeGreaterThan(0);
  });

  it("refreshes orchestration state on chat refresh events while cowork is active", async () => {
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Harness mode="cowork" />);
      });

      platformMocks.fetchOrchestrationRun.mockClear();
      platformMocks.fetchOrchestrationRunCheckpoints.mockClear();

      expect(refreshSubscriptionMocks.topic).toBe("chat");
      expect(refreshSubscriptionMocks.options?.enabled).toBe(true);
      expect(refreshSubscriptionMocks.options?.coalesceMs).toBe(800);
      expect(refreshSubscriptionMocks.options?.staleMs).toBe(20_000);
      expect(refreshSubscriptionMocks.options?.pollIntervalMs).toBe(15_000);

      await act(async () => {
        await refreshSubscriptionMocks.callback?.({
          topic: "chat",
          timestamp: Date.now(),
          reason: "unit-test",
          source: "test",
        });
      });

      expect(platformMocks.fetchOrchestrationRun).toHaveBeenCalledWith("orch-run-1");
      expect(platformMocks.fetchOrchestrationRunCheckpoints).toHaveBeenCalledWith("orch-run-1");
    } finally {
      renderer?.unmount();
    }
  });

  it("keeps the last known run visible when checkpoint refresh fails", async () => {
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Harness mode="cowork" />);
      });

      platformMocks.fetchOrchestrationRun.mockResolvedValue({
        runId: "orch-run-1",
        planId: "plan-1",
        status: "running",
        startedAt: "2026-04-19T00:00:00.000Z",
        totalCostUsd: 1.25,
        totalIterations: 2,
        durableRunId: "durable-run-1",
        executionState: "running",
        worktreeStatus: "ready",
      });
      platformMocks.fetchOrchestrationRunCheckpoints.mockRejectedValueOnce(new Error("checkpoint fetch failed"));

      await act(async () => {
        await refreshSubscriptionMocks.callback?.({
          topic: "chat",
          timestamp: Date.now(),
          reason: "unit-test",
          source: "test",
        });
      });

      expect(latest?.orchestrationRun?.status).toBe("running");
      expect(latest?.orchestrationCheckpoints).toHaveLength(1);
      expect(latest?.orchestrationError).toContain("checkpoints");
    } finally {
      renderer?.unmount();
    }
  });

  it("keeps the last known checkpoints visible when run refresh fails", async () => {
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<Harness mode="cowork" />);
      });

      platformMocks.fetchOrchestrationRun.mockRejectedValueOnce(new Error("run fetch failed"));
      platformMocks.fetchOrchestrationRunCheckpoints.mockResolvedValueOnce({
        items: [
          {
            checkpointId: "cp-2",
            runId: "orch-run-1",
            planId: "plan-1",
            checkpointKind: "run_progress",
            details: { step: "handoff" },
            createdAt: "2026-04-19T00:00:02.000Z",
          },
        ],
      });

      await act(async () => {
        await refreshSubscriptionMocks.callback?.({
          topic: "chat",
          timestamp: Date.now(),
          reason: "unit-test",
          source: "test",
        });
      });

      expect(latest?.orchestrationRun?.durableRunId).toBe("durable-run-1");
      expect(latest?.orchestrationCheckpoints).toEqual([
        expect.objectContaining({
          checkpointId: "cp-2",
          checkpointKind: "run_progress",
        }),
      ]);
      expect(latest?.orchestrationError).toContain("run data");
    } finally {
      renderer?.unmount();
    }
  });

  it("reports a full orchestration refresh failure when run and checkpoints fail together", async () => {
    await act(async () => {
      create(<Harness mode="cowork" />);
    });

    platformMocks.fetchOrchestrationRun.mockRejectedValueOnce(new Error("run fetch failed"));
    platformMocks.fetchOrchestrationRunCheckpoints.mockRejectedValueOnce(new Error("checkpoint fetch failed"));

    await act(async () => {
      await latest?.refreshOrchestrationRun();
    });

    expect(latest?.orchestrationError).toBe("Orchestration refresh failed while loading run data and checkpoints.");
    expect(latest?.orchestrationLoading).toBe(false);
  });
});

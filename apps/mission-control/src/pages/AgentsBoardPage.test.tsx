import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(async () => ({
    items: [
      {
        agentId: "agent-architect",
        roleId: "architect",
        status: "active",
        name: "Architect Goat",
        title: "Systems Architect",
        summary: "Design and planning agent",
        specialties: ["Architecture", "Planning"],
        defaultTools: ["browser.search"],
        aliases: ["architect"],
        isBuiltin: true,
        editable: false,
        lifecycleStatus: "active",
        sessionCount: 2,
        activeSessions: 1,
        lastUpdatedAt: new Date("2026-04-20T17:59:00.000Z").toISOString(),
        createdAt: new Date("2026-04-20T17:59:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-20T17:59:00.000Z").toISOString(),
      },
      {
        agentId: "agent-qa",
        roleId: "qa",
        status: "idle",
        name: "QA Goat",
        title: "Verification Lead",
        summary: "Quality verification agent",
        specialties: ["Testing", "Regression"],
        defaultTools: ["shell.exec"],
        aliases: ["qa"],
        isBuiltin: true,
        editable: false,
        lifecycleStatus: "active",
        sessionCount: 1,
        activeSessions: 0,
        lastUpdatedAt: new Date("2026-04-20T17:58:00.000Z").toISOString(),
        createdAt: new Date("2026-04-20T17:58:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-20T17:58:00.000Z").toISOString(),
      },
    ],
  })),
  fetchApprovals: vi.fn(async () => ({
    items: [
      {
        approvalId: "approval-architect",
        kind: "tool.invoke",
        riskLevel: "high",
        status: "pending",
        roleId: "architect",
        createdAt: new Date("2026-04-20T17:59:30.000Z").toISOString(),
      },
    ],
  })),
  fetchRealtimeEvents: vi.fn(async () => ({
    items: [
      {
        eventId: "evt-architect",
        sequence: 10,
        eventType: "activity_logged",
        source: "chat",
        timestamp: new Date("2026-04-20T18:00:00.000Z").toISOString(),
        links: {
          taskId: "task-architect",
          sessionId: "sess-architect",
          runId: "run-architect",
        },
        payload: {
          activity: {
            agentId: "architect",
            message: "Drafted fallback plan.",
          },
        },
      },
      {
        eventId: "evt-qa",
        sequence: 11,
        eventType: "session_event",
        source: "system",
        timestamp: new Date("2026-04-20T17:57:00.000Z").toISOString(),
        links: {
          taskId: "task-qa",
          sessionId: "sess-qa",
        },
        payload: {
          message: "Regression lane is queued.",
          roleId: "qa",
        },
      },
    ],
  })),
  fetchTasksByView: vi.fn(async () => ({
    view: "active",
    items: [
      {
        taskId: "task-architect",
        title: "Design board inspector",
        status: "review",
        priority: "high",
        assignedAgentId: "architect",
        createdAt: new Date("2026-04-20T17:50:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-20T17:59:00.000Z").toISOString(),
      },
      {
        taskId: "task-qa",
        title: "Prepare regression pass",
        status: "assigned",
        priority: "normal",
        assignedAgentId: "qa",
        createdAt: new Date("2026-04-20T17:40:00.000Z").toISOString(),
        updatedAt: new Date("2026-04-20T17:55:00.000Z").toISOString(),
      },
    ],
  })),
  fetchRuntimeLifecycle: vi.fn(async () => ({
    query: { taskId: "task-architect" },
    canonical: { taskId: "task-architect", sessionId: "sess-architect", runId: "run-architect" },
    linked: {
      sessionIds: ["sess-architect"],
      turnIds: ["turn-architect"],
      runIds: ["run-architect"],
      proactiveRunIds: [],
      approvalIds: ["approval-architect"],
      taskIds: ["task-architect"],
      workspaceIds: ["workspace-1"],
    },
    task: {
      taskId: "task-architect",
      title: "Design board inspector",
      status: "review",
      priority: "high",
      assignedAgentId: "architect",
      createdAt: new Date("2026-04-20T17:50:00.000Z").toISOString(),
      updatedAt: new Date("2026-04-20T17:59:00.000Z").toISOString(),
    },
    approval: {
      approvalId: "approval-architect",
      kind: "tool.invoke",
      riskLevel: "high",
      status: "pending",
      createdAt: new Date("2026-04-20T17:59:30.000Z").toISOString(),
    },
    turns: [
      {
        turnId: "turn-architect",
        sessionId: "sess-architect",
        parentTurnId: undefined,
        status: "completed",
        mode: "cowork",
        startedAt: new Date("2026-04-20T17:58:00.000Z").toISOString(),
        finishedAt: new Date("2026-04-20T17:59:00.000Z").toISOString(),
        userMessageId: "user-msg-1",
        assistantMessageId: "assistant-msg-1",
      },
    ],
    toolRuns: [
      {
        toolRunId: "tool-run-1",
        turnId: "turn-architect",
        sessionId: "sess-architect",
        toolName: "fetch_runtime_lifecycle",
        status: "completed",
        approvalId: "approval-architect",
        startedAt: new Date("2026-04-20T17:58:10.000Z").toISOString(),
        finishedAt: new Date("2026-04-20T17:58:12.000Z").toISOString(),
        reused: false,
      },
    ],
    executionPlans: [
      {
        planId: "plan-1",
        sessionId: "sess-architect",
        turnId: "turn-architect",
        mode: "cowork",
        planningMode: "guided",
        status: "running",
        source: "assistant",
        advisoryOnly: false,
        objective: "Build the board",
        summary: "Build the agent board",
        startedAt: new Date("2026-04-20T17:58:00.000Z").toISOString(),
        finishedAt: undefined,
        steps: [
          {
            stepId: "step-1",
            index: 0,
            objective: "Map lanes",
            status: "completed",
            delegatedRole: "architect",
          },
          {
            stepId: "step-2",
            index: 1,
            objective: "Wire trace inspector",
            status: "running",
            delegatedRole: "coder",
          },
        ],
      },
    ],
    delegationRuns: [
      {
        runId: "delegation-1",
        sessionId: "sess-architect",
        taskId: "task-architect",
        objective: "Implement board",
        roles: ["coder", "qa"],
        mode: "cowork",
        status: "running",
        executionPlanId: "plan-1",
        startedAt: new Date("2026-04-20T17:58:00.000Z").toISOString(),
        finishedAt: undefined,
      },
    ],
    delegationSteps: [
      {
        stepId: "delegation-step-1",
        runId: "delegation-1",
        role: "coder",
        status: "running",
        index: 0,
        summary: "Laying out the board.",
      },
    ],
  })),
  connectEventStream: vi.fn((onEvent: (event: unknown) => void, onStateChange?: (state: string) => void) => {
    onStateChange?.("open");
    onEvent({
      eventId: "evt-live-1",
      sequence: 12,
      eventType: "activity_logged",
      source: "chat",
      timestamp: new Date("2026-04-20T18:01:00.000Z").toISOString(),
      links: {
        taskId: "task-qa",
        sessionId: "sess-qa",
      },
      payload: {
        activity: {
          agentId: "qa",
          message: "Ran regression pass.",
        },
      },
    });
    return () => undefined;
  }),
}));

vi.mock("../api/client", () => ({
  fetchAgents: apiMocks.fetchAgents,
  fetchApprovals: apiMocks.fetchApprovals,
  fetchRealtimeEvents: apiMocks.fetchRealtimeEvents,
  fetchRuntimeLifecycle: apiMocks.fetchRuntimeLifecycle,
  fetchTasksByView: apiMocks.fetchTasksByView,
  connectEventStream: apiMocks.connectEventStream,
}));

import { AgentsBoardPage } from "./AgentsBoardPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function button(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType("button")
    .find((candidate) => rendererTextFromNode(candidate).includes(label));
  if (!node) {
    throw new Error(`Unable to find button ${label}`);
  }
  return node;
}

function rendererTextFromNode(node: { children?: unknown[] }): string {
  return (node.children ?? [])
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (child && typeof child === "object" && "children" in child) {
        return rendererTextFromNode(child as { children?: unknown[] });
      }
      return "";
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("AgentsBoardPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T18:02:00.000Z"));
    vi.clearAllMocks();
  });

  it("renders the multica-style board with a trace inspector fed by runtime lifecycle data", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsBoardPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Agent Board");
      expect(text).toContain("Backlog");
      expect(text).toContain("Todo");
      expect(text).toContain("In Progress");
      expect(text).toContain("In Review");
      expect(text).toContain("Done");
      expect(text).toContain("Architect Goat");
      expect(text).toContain("QA Goat");
      expect(text).toContain("High");
      expect(text).toContain("Medium");
      expect(text).toContain("Execution trace");
      expect(text).toContain("Messages");
      expect(text).toContain("Details");
      expect(text).toContain("Build the agent board");
      expect(text).toContain("fetch_runtime_lifecycle");
      expect(text).toContain("Drafted fallback plan.");
      expect(apiMocks.fetchAgents).toHaveBeenCalledWith("all", 300);
      expect(apiMocks.fetchApprovals).toHaveBeenCalledWith("pending");
      expect(apiMocks.fetchTasksByView).toHaveBeenCalledWith("active");
      expect(apiMocks.fetchRuntimeLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-architect" }),
      );
      expect(apiMocks.connectEventStream).toHaveBeenCalled();
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("shows loading, degraded stream, empty lanes, and the empty trace inspector", async () => {
    let resolveAgents: (value: { items: [] }) => void = () => undefined;
    apiMocks.fetchAgents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAgents = resolve;
        }),
    );
    apiMocks.fetchApprovals.mockResolvedValueOnce({ items: [] });
    apiMocks.fetchTasksByView.mockResolvedValueOnce({ view: "active", items: [] });
    apiMocks.fetchRealtimeEvents.mockResolvedValueOnce({ items: [] });
    apiMocks.connectEventStream.mockImplementationOnce((_onEvent, onStateChange) => {
      onStateChange?.("error");
      return () => undefined;
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsBoardPage />);
      });

      expect(rendererText(renderer)).not.toContain("Select a task");

      await act(async () => {
        resolveAgents({ items: [] });
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("0 tasks");
      expect(text).toContain("Stream degraded");
      expect(text).toContain("No tasks in this lane.");
      expect(text).toContain("Select a task");
      expect(text).toContain("Pick a card on the board to inspect its assignee");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("cycles priority filters, toggles density, refreshes the board, and reports lifecycle errors", async () => {
    apiMocks.fetchRuntimeLifecycle.mockRejectedValueOnce(new Error("runtime lineage unavailable"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsBoardPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("runtime lineage unavailable");

      await act(async () => {
        button(renderer, "All priorities").props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("Urgent only");
      expect(rendererText(renderer)).toContain("0 tasks");
      expect(rendererText(renderer)).toContain("Select a task");

      await act(async () => {
        button(renderer, "Urgent only").props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("High only");
      expect(rendererText(renderer)).toContain("Design board inspector");

      await act(async () => {
        button(renderer, "Comfortable").props.onClick();
      });
      expect(rendererText(renderer)).toContain("Compact");

      await act(async () => {
        button(renderer, "Refresh board").props.onClick();
      });
      await flush();

      expect(apiMocks.fetchAgents).toHaveBeenCalledWith("all", 300);
      expect(apiMocks.fetchTasksByView).toHaveBeenCalledWith("active");
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });
});

import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  connectEventStream: vi.fn(),
  fetchAgents: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchRealtimeEvents: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  fetchTasksByView: vi.fn(),
}));

vi.mock("../api/client", () => ({
  connectEventStream: apiMocks.connectEventStream,
  fetchAgents: apiMocks.fetchAgents,
  fetchApprovals: apiMocks.fetchApprovals,
  fetchRealtimeEvents: apiMocks.fetchRealtimeEvents,
  fetchRuntimeLifecycle: apiMocks.fetchRuntimeLifecycle,
  fetchTasksByView: apiMocks.fetchTasksByView,
}));

import { AgentsBoardPage } from "./AgentsBoardPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(" ");
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function nodeText(node: { children?: unknown[] }): string {
  return (node.children ?? [])
    .map((child) =>
      typeof child === "string" ? child : child && typeof child === "object" ? nodeText(child as any) : "",
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function button(renderer: ReactTestRenderer, label: string, occurrence = 0) {
  const found = renderer.root
    .findAll((node) => node.type === "button" && nodeText(node).includes(label))
    .at(occurrence);
  if (!found) {
    const available = renderer.root
      .findAllByType("button")
      .map((node) => nodeText(node))
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Button not found: ${label}. Available: ${available}`);
  }
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

const now = "2026-05-14T12:00:00.000Z";

function makeTask(
  taskId: string,
  title: string,
  status: string,
  priority: string,
  extra: Record<string, unknown> = {},
) {
  return {
    taskId,
    title,
    status,
    priority,
    createdAt: "2026-05-14T11:00:00.000Z",
    updatedAt: "2026-05-14T11:55:00.000Z",
    ...extra,
  };
}

describe("AgentsBoardPage loop 13 behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    vi.clearAllMocks();

    apiMocks.fetchAgents.mockResolvedValue({
      items: [
        {
          agentId: "agent-coder",
          roleId: "coder",
          status: "active",
          name: "Coder Goat",
          title: "Implementation",
          summary: "Builds changes",
          specialties: ["code"],
          defaultTools: [],
          aliases: ["builder"],
          isBuiltin: true,
          editable: false,
          lifecycleStatus: "active",
          sessionCount: 1,
          activeSessions: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          agentId: "agent-qa",
          roleId: "qa",
          status: "idle",
          name: "QA Goat",
          title: "Verification",
          summary: "Tests changes",
          specialties: ["test"],
          defaultTools: [],
          aliases: ["tester"],
          isBuiltin: true,
          editable: false,
          lifecycleStatus: "active",
          sessionCount: 1,
          activeSessions: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    apiMocks.fetchApprovals.mockResolvedValue({
      items: [
        {
          approvalId: "approval-blocked",
          kind: "tool.invoke",
          riskLevel: "danger",
          status: "pending",
          taskId: "very-long-task-id-1234567890",
          createdAt: now,
        },
      ],
    });
    apiMocks.fetchTasksByView.mockResolvedValue({
      view: "active",
      items: [
        makeTask("very-long-task-id-1234567890", "Blocked launch guard", "blocked", "urgent", {
          assignedAgentId: "missing-agent",
        }),
        makeTask("progress-task", "Run validation", "testing", "low", {
          assignedAgentId: "coder",
        }),
        makeTask("done-task", "Archive completed loop", "done", "high", {
          assignedAgentId: "qa",
          description:
            "This completed task intentionally carries a long description so the card summary truncation path is exercised by the board.",
        }),
        makeTask("inbox-task", "Collect intake notes", "inbox", "normal", {
          assignedAgentId: undefined,
        }),
      ],
    });
    apiMocks.fetchRealtimeEvents.mockResolvedValue({
      items: [
        {
          eventId: "event-approval-created",
          sequence: 1,
          eventType: "approval_created",
          source: "approvals",
          timestamp: "2026-05-14T11:58:00.000Z",
          links: { taskId: "very-long-task-id-1234567890", approvalId: "approval-blocked" },
          payload: { kind: "tool.invoke" },
        },
        {
          eventId: "event-tool-failed",
          sequence: 2,
          eventType: "tool_failed",
          source: "tools",
          timestamp: "2026-05-14T11:57:00.000Z",
          links: { taskId: "progress-task", sessionId: "session-progress" },
          payload: { summary: "Helper command failed." },
          traceId: "trace-progress",
        },
        {
          eventId: "event-approval-resolved",
          sequence: 3,
          eventType: "approval_resolved",
          source: "approvals",
          timestamp: "2026-05-14T11:56:00.000Z",
          links: { taskId: "done-task" },
          payload: { decision: "approved" },
        },
      ],
    });
    apiMocks.fetchRuntimeLifecycle.mockImplementation(async (query: { taskId?: string }) => ({
      query,
      canonical: { taskId: query.taskId },
      linked: {
        sessionIds: query.taskId === "inbox-task" ? [] : ["session-1"],
        turnIds: ["turn-1"],
        runIds: ["durable-failed"],
        proactiveRunIds: [],
        approvalIds: ["approval-blocked"],
        taskIds: [query.taskId ?? "unknown"],
        workspaceIds: ["default"],
      },
      resolution: { fallbackSources: query.taskId === "inbox-task" ? [] : ["event-links"] },
      task: makeTask(
        query.taskId ?? "task",
        query.taskId === "inbox-task" ? "Collect intake notes" : "Runtime task",
        "done",
        "low",
      ),
      approval:
        query.taskId === "very-long-task-id-1234567890"
          ? {
              approvalId: "approval-blocked",
              kind: "tool.invoke",
              riskLevel: "danger",
              status: "pending",
              createdAt: now,
            }
          : undefined,
      executionPlans: [
        {
          planId: "plan-failed",
          sessionId: "session-1",
          turnId: "turn-1",
          mode: "cowork",
          source: "planner",
          status: "failed",
          objective: "Recover launch guard",
          summary: "",
          steps: [{ stepId: "step-failed", index: 0, objective: "Run guard", status: "failed", delegatedRole: "qa" }],
        },
      ],
      delegationRuns: [
        {
          runId: "delegation-complete",
          sessionId: "session-1",
          taskId: query.taskId,
          objective: "",
          roles: ["qa"],
          mode: "serial",
          status: "completed",
        },
      ],
      delegationSteps: [
        {
          stepId: "delegation-step-failed",
          runId: "delegation-complete",
          role: "QA",
          status: "failed",
          index: 0,
          summary: "",
        },
      ],
      turns: [
        {
          turnId: "turn-1",
          sessionId: "session-1",
          mode: "code",
          status: "failed",
          startedAt: "2026-05-14T11:50:00.000Z",
          completion: { finishReason: "error" },
        },
      ],
      toolRuns: [
        {
          toolRunId: "tool-failed",
          turnId: "turn-1",
          sessionId: "session-1",
          toolName: "shell",
          status: "failed",
          reused: true,
        },
      ],
      durableRun: {
        runId: "durable-failed",
        workflowKey: "code.loop",
        status: "failed",
      },
    }));
    apiMocks.connectEventStream.mockImplementation(
      (onEvent: (event: unknown) => void, onStateChange?: (state: string) => void) => {
        onStateChange?.("connecting");
        onEvent({
          eventId: "event-live-task",
          sequence: 4,
          eventType: "task_updated",
          source: "tasks",
          timestamp: "2026-05-14T11:59:00.000Z",
          links: { taskId: "progress-task" },
          payload: { summary: "Validation moved forward." },
        });
        return () => undefined;
      },
    );
  });

  it("renders blocked, unassigned, lifecycle, event-detail, and scheduled-refresh states", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<AgentsBoardPage />);
      });
      await flush();

      let rendered = text(renderer);
      expect(rendered).toContain("Connecting");
      expect(rendered).toContain("Blocked launch guard");
      expect(rendered).toContain("Blocked");
      expect(rendered).toContain("Unassigned");
      expect(rendered).toContain("Urgent");
      expect(rendered).toContain("Archive completed loop");
      expect(rendered).toContain("Approval Created");
      expect(rendered).toContain("Durable run");
      expect(rendered).toContain("shell");

      await act(async () => {
        vi.advanceTimersByTime(650);
      });
      await flush();
      expect(apiMocks.fetchTasksByView).toHaveBeenCalledTimes(2);

      await act(async () => {
        button(renderer, "Approval Created").props.onClick();
      });
      rendered = text(renderer);
      expect(rendered).toContain("tool.invoke is waiting for a decision.");
      expect(rendered).toContain("approval-blocked");

      await act(async () => {
        button(renderer, "Durable run").props.onClick();
      });
      expect(text(renderer)).toContain("failed durable execution state.");

      await act(async () => {
        button(renderer, "Collect intake notes").props.onClick();
      });
      await flush();

      rendered = text(renderer);
      expect(rendered).toContain("This task is the current anchor for runtime lifecycle inspection.");
      expect(rendered).toContain("No recent events linked to this task.");
      expect(apiMocks.fetchRuntimeLifecycle).toHaveBeenCalledWith(expect.objectContaining({ taskId: "inbox-task" }));
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });
});

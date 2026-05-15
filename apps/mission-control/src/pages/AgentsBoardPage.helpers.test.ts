import { describe, expect, it, vi } from "vitest";
import {
  avatarInitials,
  buildAgentHints,
  buildAgentLookup,
  buildEventMeta,
  buildTaskHints,
  buildTraceNodes,
  buildTraceQuery,
  collectStrings,
  compactId,
  countTraceLinks,
  deriveTaskLane,
  describeBoardEvent,
  describeTaskSignal,
  eventTone,
  formatEventLabel,
  formatRelativeTime,
  formatTaskIdentifier,
  isActiveEvent,
  matchesHints,
  mergeHintSets,
  mergeRealtimeEvents,
  nextPriorityFilter,
  normalizeToken,
  priorityFilterLabel,
  priorityLabel,
  readFirstString,
  resolveAssignedAgent,
  safeJson,
  selectionScore,
  shouldRefreshBoardFromEvent,
  sortTaskCards,
  streamLabel,
  streamTone,
  taskCardTone,
  taskPriorityLevel,
  taskStatusTone,
  truncateText,
} from "./AgentsBoardPage";

vi.mock("../api/client", () => ({
  connectEventStream: vi.fn(),
  fetchAgents: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchRealtimeEvents: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  fetchTasksByView: vi.fn(),
}));

const agent = {
  agentId: "agent-coder",
  roleId: "coder",
  runtimeAgentId: "runtime-coder",
  runtimeName: "Runtime Coder",
  name: "Coder Goat",
  title: "Implementation Lead",
  aliases: ["Builder"],
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-long-identifier-1234567890",
    title: "Ship launch guard",
    status: "assigned",
    priority: "normal",
    assignedAgentId: "coder",
    proactiveContext: { sessionId: "session-1", durableRunId: "run-1" },
    updatedAt: "2026-05-14T11:58:00.000Z",
    createdAt: "2026-05-14T11:00:00.000Z",
    ...overrides,
  } as any;
}

function event(eventType: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: `event-${eventType}`,
    eventType,
    source: "chat",
    timestamp: "2026-05-14T11:59:00.000Z",
    payload: {},
    links: {},
    ...overrides,
  } as any;
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    task: task(),
    shortId: "GC-12345678",
    laneId: "todo",
    priorityLevel: "medium",
    priorityLabel: "Medium",
    assignee: agent,
    approvals: [],
    recentEvents: [],
    latestEvent: undefined,
    signal: "Assigned and ready to start.",
    ...overrides,
  } as any;
}

describe("AgentsBoardPage helper behavior", () => {
  it("normalizes agent, task, and hint matching inputs", () => {
    const lookup = buildAgentLookup([agent as any]);

    expect(buildAgentHints(agent as any)).toEqual(
      new Set(["agent coder", "coder", "coder goat", "implementation lead", "runtime coder", "builder"]),
    );
    expect([...buildTaskHints(task({ title: "Coder / QA handoff" }))]).toEqual(
      expect.arrayContaining(["task long identifier 1234567890", "coder", "session 1", "run 1", "coder qa handoff"]),
    );
    expect(resolveAssignedAgent(task({ assignedAgentId: "coder" }), lookup)?.name).toBe("Coder Goat");
    expect(resolveAssignedAgent(task({ assignedAgentId: "role:coder:primary" }), lookup)?.name).toBe("Coder Goat");
    expect(resolveAssignedAgent(task({ assignedAgentId: "missing" }), lookup)).toBeUndefined();
    expect(matchesHints(new Set(["coder"]), new Set(["qa", "coder"]))).toBe(true);
    expect(matchesHints(new Set(), new Set(["coder"]))).toBe(false);
    expect(collectStrings({ primary: " Alpha ", nested: ["Beta!", { deep: { ignored: "too deep" } }] })).toEqual(
      new Set(["alpha", "beta"]),
    );
    expect(mergeHintSets(new Set(["a"]), new Set(["b", "a"]))).toEqual(new Set(["a", "b"]));
    expect(normalizeToken(" Role: Coder.Primary ")).toBe("role coder primary");
  });

  it("derives board labels, lanes, ordering, and signal summaries", () => {
    expect(taskPriorityLevel("urgent" as any)).toBe("urgent");
    expect(taskPriorityLevel("high" as any)).toBe("high");
    expect(taskPriorityLevel("low" as any)).toBe("low");
    expect(taskPriorityLevel("normal" as any)).toBe("medium");
    expect(priorityLabel("urgent" as any)).toBe("Urgent");
    expect(priorityFilterLabel("all" as any)).toBe("All priorities");
    expect(priorityFilterLabel("high" as any)).toBe("High only");
    expect(nextPriorityFilter("all" as any)).toBe("urgent");
    expect(nextPriorityFilter("low" as any)).toBe("all");

    expect(deriveTaskLane(task({ status: "done" }))).toBe("done");
    expect(deriveTaskLane(task({ status: "blocked" }))).toBe("review");
    expect(deriveTaskLane(task({ status: "testing" }))).toBe("progress");
    expect(deriveTaskLane(task({ status: "assigned" }))).toBe("todo");
    expect(deriveTaskLane(task({ status: "inbox" }))).toBe("backlog");

    expect(formatTaskIdentifier("abc-123")).toBe("ABC-123");
    expect(formatTaskIdentifier("task-long-identifier-1234567890")).toBe("GC-34567890");
    expect(describeTaskSignal(task({ status: "blocked" }), undefined, 0)).toBe(
      "This task is blocked and needs intervention.",
    );
    expect(describeTaskSignal(task({ status: "review" }), undefined, 0)).toBe("This task is waiting in review.");
    expect(describeTaskSignal(task({ status: "in_progress" }), undefined, 0)).toBe(
      "This task is actively running through the runtime.",
    );
    expect(describeTaskSignal(task({ status: "assigned" }), undefined, 2)).toBe(
      "2 approvals waiting on an operator decision.",
    );
    expect(describeTaskSignal(task({ status: "queued" }), undefined, 0)).toBe("No recent task traffic yet.");

    expect(selectionScore(card({ laneId: "review", priorityLevel: "urgent", approvals: Array(12).fill({}) }))).toBe(
      549,
    );
    expect(sortTaskCards(card({ laneId: "backlog" }), card({ laneId: "done" }))).toBeLessThan(0);
  });

  it("builds trace queries and trace nodes across lifecycle sources", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    const linkedEvent = event("tool_failed", {
      links: { taskId: "task-1", approvalId: "approval-1", sessionId: "session-1", turnId: "turn-1", runId: "run-1" },
    });
    const selectedCard = card({ recentEvents: [linkedEvent], approvals: [], latestEvent: linkedEvent });
    expect(buildTraceQuery(selectedCard)).toMatchObject({
      taskId: "task-long-identifier-1234567890",
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    });
    expect(countTraceLinks(buildTraceQuery(selectedCard))).toBe(5);
    expect(countTraceLinks(null)).toBe(0);
    expect(buildTraceNodes(null, null)).toEqual([]);

    const nodes = buildTraceNodes(selectedCard, {
      task: task({ taskId: "task-1", title: "Runtime task", status: "testing", priority: "high" }),
      approval: { approvalId: "approval-1", kind: "tool.invoke", status: "pending", riskLevel: "danger" },
      executionPlans: [
        {
          planId: "plan-1",
          status: "failed",
          mode: "cowork",
          source: "planner",
          objective: "Recover",
          summary: "",
          steps: [{ stepId: "step-1", index: 0, objective: "Run tests", status: "completed", delegatedRole: "qa" }],
        },
      ],
      delegationRuns: [{ runId: "delegation-1", objective: "", roles: ["qa"], status: "running" }],
      delegationSteps: [{ stepId: "delegation-step-1", role: "QA", status: "failed", index: 1, summary: "" }],
      turns: [
        {
          turnId: "turn-1",
          mode: "code",
          status: "failed",
          startedAt: "2026-05-14T11:30:00.000Z",
          completion: { finishReason: "error" },
        },
      ],
      toolRuns: [{ toolRunId: "tool-1", toolName: "shell", status: "executed", reused: true }],
      durableRun: { runId: "durable-1", workflowKey: "code.loop", status: "completed" },
      linked: { sessionIds: ["s1"], taskIds: ["task-1"], approvalIds: ["approval-1"] },
      canonical: { taskId: "task-1" },
      resolution: { fallbackSources: ["event-links"] },
    } as any);

    expect(nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "trace:overview",
        "trace:task:task-1",
        "trace:approval:approval-1",
        "trace:plan:plan-1",
        "trace:plan-step:step-1",
        "trace:delegation:delegation-1",
        "trace:delegation-step:delegation-step-1",
        "trace:turn:turn-1",
        "trace:tool:tool-1",
        "trace:durable:durable-1",
        "trace:linked",
      ]),
    );
    vi.useRealTimers();
  });

  it("formats event stream, detail, and defensive utility branches", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));

    expect(shouldRefreshBoardFromEvent(event("approval_created"))).toBe(true);
    expect(shouldRefreshBoardFromEvent(event("noise", { links: { sessionId: "session-1" } }))).toBe(true);
    expect(shouldRefreshBoardFromEvent(event("noise"))).toBe(false);
    expect(
      mergeRealtimeEvents(
        [event("old", { eventId: "same", timestamp: "2026-05-14T11:00:00.000Z" })],
        [
          event("new", { eventId: "same", timestamp: "2026-05-14T12:00:00.000Z" }),
          event("other", { eventId: "other", timestamp: "2026-05-14T11:30:00.000Z" }),
        ],
      ).map((item) => item.eventId),
    ).toEqual(["other", "same"]);

    expect(formatRelativeTime("2026-05-14T12:00:00.000Z")).toBe("just now");
    expect(formatRelativeTime("2026-05-14T11:45:00.000Z")).toBe("15m ago");
    expect(formatRelativeTime("2026-05-14T09:00:00.000Z")).toBe("3h ago");
    expect(formatRelativeTime("2026-05-12T12:00:00.000Z")).toBe("2d ago");

    expect(taskCardTone(card({ approvals: [{}] }))).toBe("critical");
    expect(taskCardTone(card({ laneId: "progress" }))).toBe("live");
    expect(taskCardTone(card({ laneId: "done" }))).toBe("success");
    expect(taskStatusTone("blocked" as any)).toBe("critical");
    expect(taskStatusTone("review" as any)).toBe("warning");
    expect(taskStatusTone("in_progress" as any)).toBe("live");
    expect(taskStatusTone("done" as any)).toBe("success");
    expect(taskStatusTone("assigned" as any)).toBe("muted");
    expect(eventTone(event("approval_created"))).toBe("critical");
    expect(eventTone(event("tool_failed"))).toBe("critical");
    expect(eventTone(event("task_updated"))).toBe("success");
    expect(eventTone(event("activity_logged"))).toBe("live");
    expect(eventTone(event("noise"))).toBe("muted");

    expect(describeBoardEvent(event("activity_logged", { payload: { activity: { message: "Worked" } } }))).toBe(
      "Worked",
    );
    expect(describeBoardEvent(event("session_event", { payload: { event: "Session resumed" } }))).toBe(
      "Session resumed",
    );
    expect(describeBoardEvent(event("approval_created", { payload: { kind: "tool.invoke" } }))).toBe(
      "tool.invoke is waiting for a decision.",
    );
    expect(describeBoardEvent(event("approval_resolved", { payload: { decision: "approved" } }))).toBe(
      "approved was resolved.",
    );
    expect(isActiveEvent(undefined)).toBe(false);
    expect(isActiveEvent(event("orchestration_event"))).toBe(true);
    expect(formatEventLabel("approval_created")).toBe("Approval Created");
    expect(
      buildEventMeta(
        event("tool_failed", {
          eventId: "event-1234567890",
          source: "tools",
          links: { taskId: "task-1234567890", sessionId: "session-1234567890" },
          traceId: "trace-1234567890",
        }),
      ),
    ).toEqual(["event 34567890", "source tools", "task 34567890", "session 34567890", "trace 34567890"]);
    expect(readFirstString({ a: " ", b: " value " }, ["a", "b"])).toBe("value");
    expect(readFirstString(null, ["a"])).toBeUndefined();
    expect(truncateText("abcdefghij", 6)).toBe("abcde…");
    expect(truncateText("abc", 6)).toBe("abc");
    expect(avatarInitials("coder goat")).toBe("CG");
    expect(streamTone("open" as any)).toBe("success");
    expect(streamTone("connecting" as any)).toBe("warning");
    expect(streamTone("error" as any)).toBe("muted");
    expect(streamLabel("open" as any)).toBe("Stream live");
    expect(streamLabel("connecting" as any)).toBe("Connecting");
    expect(streamLabel("error" as any)).toBe("Stream degraded");
    expect(streamLabel("closed" as any)).toBe("Stream idle");
    expect(compactId(undefined)).toBe("unknown");
    expect(compactId("short")).toBe("short");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeJson({ ok: true })).toContain('"ok": true');
    expect(safeJson(circular)).toBe("[object Object]");

    vi.useRealTimers();
  });
});

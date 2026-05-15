import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  addTaskActivity: vi.fn(),
  addTaskDeliverable: vi.fn(),
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDurableRun: vi.fn(),
  fetchDurableRunTimeline: vi.fn(),
  fetchRuntimeLifecycle: vi.fn(),
  fetchSessions: vi.fn(),
  fetchTaskActivities: vi.fn(),
  fetchTaskDeliverables: vi.fn(),
  fetchTasksByView: vi.fn(),
  fetchTaskSubagents: vi.fn(),
  registerTaskSubagent: vi.fn(),
  restoreTask: vi.fn(),
  resumeDurableRun: vi.fn(),
  updateTask: vi.fn(),
  updateTaskSubagent: vi.fn(),
  wakeDurableRun: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);
vi.mock("../hooks/useAction", () => ({
  useAction: () => ({
    pending: false,
    run: async <T,>(work: () => Promise<T>) => work(),
  }),
}));
vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      {primary}
      {secondary}
    </div>
  ),
}));
vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({ primary, inspector }: { primary?: React.ReactNode; inspector?: React.ReactNode }) => (
    <div>
      {primary}
      {inspector}
    </div>
  ),
}));
vi.mock("../components/PageHeader", () => ({
  PageHeader: ({
    title,
    subtitle,
    actions,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
vi.mock("../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    actions,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {actions}
      {children}
    </section>
  ),
}));
vi.mock("../components/SelectOrCustom", () => ({
  SelectOrCustom: ({
    value,
    customLabel,
    onChange,
  }: {
    value?: string;
    customLabel?: string;
    onChange?: (value: string) => void;
  }) => (
    <label>
      {customLabel}
      <input aria-label={customLabel} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} />
    </label>
  ),
}));
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }) =>
    open ? (
      <div>
        {title}
        {message}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
      </div>
    ) : null,
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/TableSkeleton", () => ({
  TableSkeleton: () => <div>Loading tasks…</div>,
}));
vi.mock("../components/ui", () => ({
  GCSelect: ({
    value,
    options,
    onChange,
  }: {
    value?: string;
    options: Array<{ value: string; label: string }>;
    onChange?: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onChange?.(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("../components/ui/GCEmptyState", () => ({
  GCEmptyState: ({
    title,
    subtitle,
    description,
    action,
    primaryAction,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
    primaryAction?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <p>{description ?? subtitle}</p>
      {primaryAction ?? action}
    </section>
  ),
}));
vi.mock("../content/copy", () => ({
  pageCopy: {
    tasks: {
      title: "Tasks",
      subtitle: "Track operator work.",
    },
  },
}));

import { TasksPage } from "./TasksPage";

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

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map((child) => instanceText(child)).join(" ");
}

async function clickButton(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];

  if (!button) {
    const available = renderer.root
      .findAll((node) => node.type === "button")
      .map((node) => instanceText(node).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Button not found: ${label}. Available: ${available}`);
  }

  await act(async () => {
    button.props.onClick();
  });
}

async function changeInput(renderer: ReactTestRenderer, label: string, value: string, occurrence = 0): Promise<void> {
  const input = renderer.root.findAll((node) => node.type === "input" && node.props["aria-label"] === label)[
    occurrence
  ];

  if (!input) {
    throw new Error(`Input not found: ${label}`);
  }

  await act(async () => {
    input.props.onChange({ target: { value } });
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("TasksPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchTasksByView.mockResolvedValue({
      items: [
        {
          taskId: "task-1",
          workspaceId: "default",
          title: "Ship the runtime fix",
          description: "Keep the delegation spine truthful.",
          status: "in_progress",
          priority: 2,
          proactiveContext: {
            sessionId: "session-1",
            originSurface: "cowork",
            proactiveRunId: "proactive-1",
            durableRunId: "durable-parent-1",
          },
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchTaskActivities.mockResolvedValue({ items: [] });
    apiMocks.fetchTaskDeliverables.mockResolvedValue({ items: [] });
    apiMocks.fetchTaskSubagents.mockResolvedValue({ items: [] });
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue({
      query: { taskId: "task-1" },
      linked: {
        sessionIds: ["session-1"],
        turnIds: ["turn-1"],
        runIds: ["durable-parent-1", "durable-child-1"],
        proactiveRunIds: ["proactive-1"],
        approvalIds: [],
        taskIds: ["task-1"],
        workspaceIds: ["default"],
      },
      resolution: {
        taskIdSource: "query",
        runIdSource: "execution_plan",
        fallbackSources: ["fallback_preview"],
      },
      turns: [],
      toolRuns: [],
      executionPlans: [
        {
          planId: "plan-1",
          sessionId: "session-1",
          turnId: "turn-1",
          mode: "cowork",
          planningMode: "advisory",
          status: "running",
          source: "planner",
          advisoryOnly: false,
          objective: "Ship the runtime fix",
          summary: "Plan in motion.",
          startedAt: "2026-04-10T00:00:10.000Z",
          steps: [],
        },
      ],
      delegationRuns: [
        {
          runId: "delegate-1",
          sessionId: "session-1",
          taskId: "task-1",
          objective: "Ship the runtime fix",
          roles: ["Architect", "Coder"],
          mode: "parallel",
          status: "partial",
          executionPlanId: "plan-1",
          startedAt: "2026-04-10T00:00:11.000Z",
        },
      ],
      delegationSteps: [
        {
          stepId: "delegate-step-1",
          runId: "delegate-1",
          role: "Architect",
          status: "completed",
          index: 0,
          childSessionId: "child-session-1",
          childTurnId: "child-turn-1",
          durableRunId: "durable-child-1",
        },
        {
          stepId: "delegate-step-2",
          runId: "delegate-1",
          role: "Coder",
          status: "skipped",
          index: 1,
          error: "Skipped because dependency failed.",
        },
      ],
    });
    apiMocks.fetchSessions.mockResolvedValue({ items: [] });
    apiMocks.fetchAgents.mockResolvedValue({ items: [] });
    apiMocks.createTask.mockResolvedValue({
      taskId: "task-created",
      workspaceId: "default",
      title: "Created task",
      status: "inbox",
      priority: 3,
      updatedAt: "2026-04-10T00:01:00.000Z",
    });
    apiMocks.updateTask.mockResolvedValue({ ok: true });
    apiMocks.addTaskActivity.mockResolvedValue({ ok: true });
    apiMocks.addTaskDeliverable.mockResolvedValue({ ok: true });
    apiMocks.registerTaskSubagent.mockResolvedValue({ ok: true });
    apiMocks.updateTaskSubagent.mockResolvedValue({ ok: true });
    apiMocks.fetchDurableRun.mockResolvedValue({
      runId: "durable-parent-1",
      status: "waiting",
      updatedAt: "2026-04-10T00:02:00.000Z",
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({
      items: [
        {
          eventId: "timeline-1",
          eventType: "run_waiting",
          stepKey: "operator-check",
          payload: { stepKey: "operator-check", reason: "Need manual wake" },
          createdAt: "2026-04-10T00:02:00.000Z",
        },
      ],
    });
    apiMocks.resumeDurableRun.mockResolvedValue({ runId: "durable-parent-1", status: "running" });
    apiMocks.wakeDurableRun.mockResolvedValue({ outcome: "woke" });
    apiMocks.deleteTask.mockResolvedValue({ ok: true });
    apiMocks.restoreTask.mockResolvedValue({ ok: true });
  });

  it("renders execution-lineage summaries for the selected task", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(apiMocks.fetchRuntimeLifecycle).toHaveBeenCalledWith({ taskId: "task-1" });
      expect(text).toContain("Execution spine");
      expect(text).toContain("Execution plans 1");
      expect(text).toContain("Delegation runs 1");
      expect(text).toContain("Delegation steps 2");
      expect(text).toContain("Session child-session-1");
      expect(text).toContain("Durable durable-child-1");
      expect(text).toContain("Skipped because dependency failed.");
      expect(text).toContain("Diagnostics: fallback_preview");
    } finally {
      renderer.unmount();
    }
  });

  it("drives task creation, status, detail, and durable recovery controls", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      await changeInput(renderer, "Task title", "Created task");
      await clickButton(renderer, "Create task");
      await flush();

      await clickButton(renderer, "testing");
      await flush();

      await changeInput(renderer, "Activity message", "Validated acceptance criteria");
      await clickButton(renderer, "Add Activity");
      await flush();

      await changeInput(renderer, "Deliverable title", "Verification logs");
      await changeInput(renderer, "Deliverable path", "tests/results.md");
      await clickButton(renderer, "Add Deliverable");
      await flush();

      await changeInput(renderer, "Session id", "child-session-2");
      await clickButton(renderer, "Add Subagent");
      await flush();

      await clickButton(renderer, "Load run");
      await flush();
      await clickButton(renderer, "Resume from checkpoint");
      await flush();
      await clickButton(renderer, "Wake waiting run");
      await flush();

      expect(apiMocks.createTask).toHaveBeenCalledWith({ workspaceId: "default", title: "Created task" });
      expect(apiMocks.updateTask).toHaveBeenCalledWith("task-1", { status: "testing" });
      expect(apiMocks.addTaskActivity).toHaveBeenCalledWith("task-1", {
        activityType: "comment",
        message: "Validated acceptance criteria",
      });
      expect(apiMocks.addTaskDeliverable).toHaveBeenCalledWith("task-1", {
        title: "Verification logs",
        deliverableType: "file",
        path: "tests/results.md",
      });
      expect(apiMocks.registerTaskSubagent).toHaveBeenCalledWith("task-1", {
        agentSessionId: "child-session-2",
        agentName: "Architect Goat",
      });
      expect(apiMocks.fetchDurableRun).toHaveBeenCalledWith("durable-parent-1");
      expect(apiMocks.fetchDurableRunTimeline).toHaveBeenCalledWith("durable-parent-1", 200);
      expect(apiMocks.resumeDurableRun).toHaveBeenCalledWith("durable-parent-1", "operator");
      expect(apiMocks.wakeDurableRun).toHaveBeenCalledWith("durable-parent-1", { eventKey: "manual.resume" });
      expect(rendererText(renderer)).toContain('Wake event "manual.resume" sent.');
    } finally {
      renderer.unmount();
    }
  });

  it("moves active tasks to trash and can permanently delete after confirmation", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      await clickButton(renderer, "Ship the runtime fix");
      await flush();
      await clickButton(renderer, "Move to Trash");
      await flush();
      await clickButton(renderer, "Move to Trash", 1);
      await flush();

      await clickButton(renderer, "Delete Permanently");
      await flush();
      await clickButton(renderer, "Delete Permanently", 1);
      await flush();

      expect(apiMocks.deleteTask).toHaveBeenCalledWith("task-1", {
        mode: "soft",
        deletedBy: "mission-control",
        deleteReason: "Operator requested cleanup",
      });
      expect(apiMocks.deleteTask).toHaveBeenCalledWith("task-1", {
        mode: "hard",
        confirmToken: "PERMANENT_DELETE",
      });
    } finally {
      renderer.unmount();
    }
  });

  it("restores trashed tasks, completes active subagents, and guards unloaded durable actions", async () => {
    apiMocks.fetchTasksByView.mockImplementation(async (view: string) => ({
      view,
      items:
        view === "trash"
          ? [
              {
                taskId: "task-trash",
                workspaceId: "default",
                title: "Restore archived task",
                status: "blocked",
                priority: 2,
                deletedAt: "2026-04-10T00:03:00.000Z",
                deleteReason: "Superseded during triage",
                updatedAt: "2026-04-10T00:03:00.000Z",
              },
            ]
          : [
              {
                taskId: "task-1",
                workspaceId: "default",
                title: "Ship the runtime fix",
                status: "in_progress",
                priority: 1,
                updatedAt: "2026-04-10T00:00:00.000Z",
              },
            ],
    }));
    apiMocks.fetchTaskSubagents.mockResolvedValue({
      items: [
        {
          subagentSessionId: "subagent-1",
          taskId: "task-1",
          agentSessionId: "child-session-1",
          agentName: "QA Goat",
          status: "active",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      await clickButton(renderer, "Mark Completed");
      await flush();
      expect(apiMocks.updateTaskSubagent).toHaveBeenCalledWith("child-session-1", { status: "completed" });
      expect(rendererText(renderer)).toContain("Subagent marked completed.");

      await clickButton(renderer, "Resume from checkpoint");
      await flush();
      expect(rendererText(renderer)).toContain("Load durable status first so we can resume from the exact checkpoint.");
      expect(apiMocks.resumeDurableRun).not.toHaveBeenCalled();

      const viewSelect = renderer.root.findByProps({ id: "taskView" });
      await act(async () => {
        viewSelect.props.onChange("trash");
      });
      await flush();

      expect(rendererText(renderer)).toContain("Restore archived task");
      expect(rendererText(renderer)).toContain("Superseded during triage");

      await clickButton(renderer, "Restore", 1);
      await flush();
      expect(apiMocks.restoreTask).toHaveBeenCalledWith("task-trash");
      expect(rendererText(renderer)).toContain("Task restored.");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces empty-state guards, loading failures, and task detail failures", async () => {
    apiMocks.fetchTasksByView.mockResolvedValueOnce({ view: "active", items: [] });
    apiMocks.fetchSessions.mockRejectedValueOnce(new Error("sessions unavailable"));
    apiMocks.fetchAgents.mockResolvedValueOnce({
      items: [
        {
          roleId: "qa",
          name: "QA Goat",
          title: "Release tester",
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("No tasks in this view yet");
      expect(rendererText(renderer)).toContain("sessions unavailable");

      await clickButton(renderer, "Create task");
      await flush();
      expect(rendererText(renderer)).toContain("Enter a task title before creating a task.");

      const viewSelect = renderer.root.findByProps({ id: "taskView" });
      apiMocks.fetchTasksByView.mockResolvedValueOnce({ view: "trash", items: [] });
      await act(async () => {
        viewSelect.props.onChange("trash");
      });
      await flush();
      expect(rendererText(renderer)).toContain("No trashed tasks right now");

      apiMocks.fetchTasksByView.mockRejectedValueOnce(new Error("task load failed"));
      await clickButton(renderer, "Return to active tasks");
      await flush();
      expect(rendererText(renderer)).toContain("task load failed");
    } finally {
      renderer.unmount();
    }

    apiMocks.fetchTasksByView.mockResolvedValueOnce({
      items: [
        {
          taskId: "task-detail-error",
          workspaceId: "default",
          title: "Detail failure task",
          status: "inbox",
          priority: 3,
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchTaskActivities.mockRejectedValueOnce(new Error("detail load failed"));

    renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Detail failure task");
      expect(rendererText(renderer)).toContain("detail load failed");
    } finally {
      renderer.unmount();
    }
  });

  it("reports durable action failures without losing the selected task", async () => {
    apiMocks.fetchDurableRun.mockRejectedValueOnce(new Error("durable load failed"));
    apiMocks.resumeDurableRun.mockRejectedValueOnce(new Error("resume failed"));
    apiMocks.wakeDurableRun.mockRejectedValueOnce(new Error("wake failed"));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      await clickButton(renderer, "Load run");
      await flush();
      expect(rendererText(renderer)).toContain("durable load failed");

      apiMocks.fetchDurableRun.mockResolvedValueOnce({
        runId: "durable-parent-1",
        status: "waiting",
        updatedAt: "2026-04-10T00:02:00.000Z",
      });
      await clickButton(renderer, "Load run");
      await flush();

      await clickButton(renderer, "Resume from checkpoint");
      await flush();
      expect(rendererText(renderer)).toContain("resume failed");

      await clickButton(renderer, "Wake waiting run");
      await flush();
      expect(rendererText(renderer)).toContain("wake failed");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps the selected task visible while surfacing task action failures", async () => {
    apiMocks.createTask.mockRejectedValueOnce(new Error("create failed"));
    apiMocks.updateTask.mockRejectedValueOnce(new Error("status failed"));
    apiMocks.addTaskActivity.mockRejectedValueOnce(new Error("activity failed"));
    apiMocks.addTaskDeliverable.mockRejectedValueOnce(new Error("deliverable failed"));
    apiMocks.registerTaskSubagent.mockRejectedValueOnce(new Error("subagent failed"));
    apiMocks.updateTaskSubagent.mockRejectedValueOnce(new Error("complete failed"));
    apiMocks.fetchTaskSubagents.mockResolvedValue({
      items: [
        {
          subagentSessionId: "subagent-1",
          taskId: "task-1",
          agentSessionId: "child-session-1",
          agentName: "QA Goat",
          status: "active",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        },
      ],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      await changeInput(renderer, "Task title", "Will fail");
      await clickButton(renderer, "Create task");
      await flush();
      expect(rendererText(renderer)).toContain("create failed");

      await clickButton(renderer, "testing");
      await flush();
      expect(rendererText(renderer)).toContain("status failed");

      await changeInput(renderer, "Activity message", "Failure note");
      await clickButton(renderer, "Add Activity");
      await flush();
      expect(rendererText(renderer)).toContain("activity failed");

      await changeInput(renderer, "Deliverable title", "Failure artifact");
      await clickButton(renderer, "Add Deliverable");
      await flush();
      expect(rendererText(renderer)).toContain("deliverable failed");

      await changeInput(renderer, "Session id", "child-session-2");
      await clickButton(renderer, "Add Subagent");
      await flush();
      expect(rendererText(renderer)).toContain("subagent failed");

      await clickButton(renderer, "Mark Completed");
      await flush();
      expect(rendererText(renderer)).toContain("complete failed");
      expect(rendererText(renderer)).toContain("Ship the runtime fix");
    } finally {
      renderer.unmount();
    }
  });
});

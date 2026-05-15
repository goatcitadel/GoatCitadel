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
  DataToolbar: ({
    primary,
    secondary,
  }: {
    primary?: React.ReactNode;
    center?: React.ReactNode;
    secondary?: React.ReactNode;
  }) => (
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
  PageHeader: ({ actions, subtitle, title }: { actions?: React.ReactNode; subtitle?: string; title?: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));
vi.mock("../components/Panel", () => ({
  Panel: ({
    actions,
    children,
    subtitle,
    title,
  }: {
    actions?: React.ReactNode;
    children?: React.ReactNode;
    subtitle?: React.ReactNode;
    title?: React.ReactNode;
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
    customLabel,
    onChange,
    value,
  }: {
    customLabel?: string;
    onChange?: (value: string) => void;
    value?: string;
  }) => (
    <label>
      {customLabel}
      <input aria-label={customLabel} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} />
    </label>
  ),
}));
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({
    confirmLabel,
    message,
    onCancel,
    onConfirm,
    open,
    title,
  }: {
    confirmLabel?: string;
    message?: string;
    onCancel?: () => void;
    onConfirm?: () => void;
    open?: boolean;
    title?: string;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));
vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/TableSkeleton", () => ({
  TableSkeleton: () => <div>Loading tasks</div>,
}));
vi.mock("../components/ui", () => ({
  GCSelect: ({
    id,
    onChange,
    options,
    value,
  }: {
    id?: string;
    onChange?: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    value?: string;
  }) => (
    <select id={id} value={value} onChange={(event) => onChange?.(event.target.value)}>
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
    description,
    primaryAction,
    title,
  }: {
    description?: React.ReactNode;
    primaryAction?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <p>{description}</p>
      {primaryAction}
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
    throw new Error(`Button not found: ${label}`);
  }
  return found;
}

function input(renderer: ReactTestRenderer, label: string) {
  const found = renderer.root.findAll((node) => node.type === "input" && node.props["aria-label"] === label).at(0);
  if (!found) {
    throw new Error(`Input not found: ${label}`);
  }
  return found;
}

function control(renderer: ReactTestRenderer, id: string) {
  const found = renderer.root
    .findAll((node) => (node.type === "input" || node.type === "select") && node.props.id === id)
    .at(0);
  if (!found) {
    throw new Error(`Control not found: ${id}`);
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

async function click(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  await act(async () => {
    button(renderer, label, occurrence).props.onClick();
  });
  await flush();
}

const activeTask = {
  taskId: "task-active",
  workspaceId: "default",
  title: "Coordinate release fix",
  description: "",
  status: "in_progress",
  priority: 2,
  updatedAt: "2026-05-14T00:00:00.000Z",
};

const trashTask = {
  taskId: "task-trash",
  workspaceId: "default",
  title: "Old duplicate task",
  description: "No longer needed",
  status: "done",
  priority: 1,
  deletedAt: "2026-05-14T00:01:00.000Z",
  deleteReason: "Duplicate",
  updatedAt: "2026-05-14T00:00:00.000Z",
};

describe("TasksPage loop 13 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchTasksByView.mockImplementation(async (view: string) => ({
      view,
      items: view === "trash" ? [trashTask] : [activeTask],
    }));
    apiMocks.fetchTaskActivities.mockResolvedValue({ items: [] });
    apiMocks.fetchTaskDeliverables.mockResolvedValue({ items: [] });
    apiMocks.fetchTaskSubagents.mockResolvedValue({
      items: [
        {
          subagentSessionId: "subagent-1",
          taskId: "task-active",
          agentSessionId: "session-existing",
          agentName: "Existing Subagent",
          status: "active",
        },
      ],
    });
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue(null);
    apiMocks.fetchSessions.mockResolvedValue({ items: [{ sessionId: "session-existing" }] });
    apiMocks.fetchAgents.mockResolvedValue({
      items: [
        { roleId: "architect", name: "Architect Goat", title: "Architecture" },
        { roleId: "qa", name: "QA Goat", title: "Verification" },
      ],
    });
    apiMocks.createTask.mockResolvedValue({ ...activeTask, taskId: "task-created", title: "Created" });
    apiMocks.updateTask.mockResolvedValue({});
    apiMocks.addTaskActivity.mockResolvedValue({});
    apiMocks.addTaskDeliverable.mockResolvedValue({});
    apiMocks.registerTaskSubagent.mockResolvedValue({});
    apiMocks.updateTaskSubagent.mockResolvedValue({});
    apiMocks.restoreTask.mockResolvedValue({});
    apiMocks.deleteTask.mockResolvedValue({});
    apiMocks.fetchDurableRun.mockResolvedValue({
      runId: "durable-manual",
      status: "waiting",
      updatedAt: "2026-05-14T00:03:00.000Z",
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({
      items: [
        {
          eventId: "timeline-1",
          eventType: "run_paused",
          stepKey: "operator-review",
          payload: {},
          createdAt: "2026-05-14T00:03:00.000Z",
        },
      ],
    });
    apiMocks.resumeDurableRun.mockResolvedValue({});
    apiMocks.wakeDurableRun.mockResolvedValue({ outcome: "already_completed" });
  });

  it("shows empty active/trash states and returns from trash empty state", async () => {
    apiMocks.fetchTasksByView.mockResolvedValue({ view: "active", items: [] });
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      expect(text(renderer)).toContain("No tasks in this view yet");
      expect(text(renderer)).toContain("Select a task to inspect details");
      await act(async () => {
        control(renderer, "taskView").props.onChange({ target: { value: "trash" } });
      });
      await flush();

      expect(apiMocks.fetchTasksByView).toHaveBeenCalledWith("trash", undefined, "default");
      expect(text(renderer)).toContain("No trashed tasks right now");

      await click(renderer, "Return to active tasks");
      expect(apiMocks.fetchTasksByView).toHaveBeenCalledWith("active", undefined, "default");
    } finally {
      renderer.unmount();
    }
  });

  it("covers blocked controls, subagent completion, manual durable recovery, and restore", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      await click(renderer, "Add Activity");
      expect(text(renderer)).toContain("Enter or select an activity message first.");

      await click(renderer, "Load run");
      expect(text(renderer)).toContain("Enter a durable run ID first.");

      await act(async () => {
        control(renderer, "taskDurableRunId").props.onChange({ target: { value: "durable-manual" } });
      });
      await click(renderer, "Load run");
      expect(apiMocks.fetchDurableRun).toHaveBeenCalledWith("durable-manual");
      expect(text(renderer)).toContain("Blocked step: operator-review");

      await click(renderer, "Resume from checkpoint");
      expect(apiMocks.resumeDurableRun).toHaveBeenCalledWith("durable-manual", "operator");

      await click(renderer, "Wake waiting run");
      expect(apiMocks.wakeDurableRun).toHaveBeenCalledWith("durable-manual", { eventKey: "manual.resume" });
      expect(text(renderer)).toContain('Wake event "manual.resume" skipped: already_completed.');

      await click(renderer, "Mark Completed");
      expect(apiMocks.updateTaskSubagent).toHaveBeenCalledWith("session-existing", { status: "completed" });

      await act(async () => {
        input(renderer, "Role id").props.onChange({ target: { value: "qa" } });
      });
      await act(async () => {
        input(renderer, "Session id").props.onChange({ target: { value: "session-new" } });
      });
      await click(renderer, "Add Subagent");
      expect(apiMocks.registerTaskSubagent).toHaveBeenCalledWith("task-active", {
        agentSessionId: "session-new",
        agentName: "QA Goat",
      });

      await act(async () => {
        control(renderer, "taskView").props.onChange({ target: { value: "trash" } });
      });
      await flush();
      expect(text(renderer)).toContain("Old duplicate task");
      expect(text(renderer)).toContain("In Trash since");

      await click(renderer, "Restore");
      expect(apiMocks.restoreTask).toHaveBeenCalledWith("task-trash");

      await click(renderer, "Delete Permanently");
      await click(renderer, "Delete Permanently", 1);
      expect(apiMocks.deleteTask).toHaveBeenCalledWith("task-trash", {
        mode: "hard",
        confirmToken: "PERMANENT_DELETE",
      });
    } finally {
      renderer.unmount();
    }
  });
});

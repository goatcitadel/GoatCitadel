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

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let reject!: (error: Error) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

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

function text(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function nodeText(node: { children?: unknown[] }): string {
  return (node.children ?? [])
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (child && typeof child === "object") {
        return nodeText(child as { children?: unknown[] });
      }
      return "";
    })
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

async function click(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  await act(async () => {
    button(renderer, label, occurrence).props.onClick();
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

const taskOne = {
  taskId: "task-one",
  workspaceId: "default",
  title: "First task",
  description: "Initial task.",
  status: "in_progress",
  priority: 2,
  updatedAt: "2026-05-14T00:00:00.000Z",
};

const taskTwo = {
  taskId: "task-two",
  workspaceId: "default",
  title: "Second task",
  description: "Fresh task.",
  status: "review",
  priority: 1,
  updatedAt: "2026-05-14T00:01:00.000Z",
};

describe("TasksPage loop 35 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.fetchTasksByView.mockResolvedValue({ items: [taskOne, taskTwo] });
    apiMocks.fetchTaskActivities.mockResolvedValue({ items: [] });
    apiMocks.fetchTaskDeliverables.mockResolvedValue({ items: [] });
    apiMocks.fetchTaskSubagents.mockResolvedValue({ items: [] });
    apiMocks.fetchRuntimeLifecycle.mockResolvedValue(null);
    apiMocks.fetchSessions.mockResolvedValue({ items: [] });
    apiMocks.fetchAgents.mockResolvedValue({ items: [] });
    apiMocks.createTask.mockResolvedValue({ ...taskOne, taskId: "task-created" });
    apiMocks.updateTask.mockResolvedValue({});
    apiMocks.addTaskActivity.mockResolvedValue({});
    apiMocks.addTaskDeliverable.mockResolvedValue({});
    apiMocks.registerTaskSubagent.mockResolvedValue({});
    apiMocks.updateTaskSubagent.mockResolvedValue({});
    apiMocks.restoreTask.mockResolvedValue({});
    apiMocks.deleteTask.mockResolvedValue({});
    apiMocks.fetchDurableRun.mockResolvedValue({
      runId: "durable-waiting",
      status: "waiting",
      updatedAt: "2026-05-14T00:02:00.000Z",
    });
    apiMocks.fetchDurableRunTimeline.mockResolvedValue({ items: [] });
    apiMocks.resumeDurableRun.mockResolvedValue({});
    apiMocks.wakeDurableRun.mockResolvedValue({ outcome: "woke" });
  });

  it("ignores stale detail responses after the operator selects a different task", async () => {
    const firstActivities = deferred<{
      items: Array<{ activityId: string; activityType: string; message: string; createdAt: string }>;
    }>();
    const firstDeliverables = deferred<{ items: unknown[] }>();
    const firstSubagents = deferred<{ items: unknown[] }>();
    const firstLifecycle = deferred<null>();
    const secondActivities = deferred<{
      items: Array<{ activityId: string; activityType: string; message: string; createdAt: string }>;
    }>();
    const secondDeliverables = deferred<{ items: unknown[] }>();
    const secondSubagents = deferred<{ items: unknown[] }>();
    const secondLifecycle = deferred<null>();

    apiMocks.fetchTaskActivities.mockImplementation((taskId: string) =>
      taskId === "task-one" ? firstActivities.promise : secondActivities.promise,
    );
    apiMocks.fetchTaskDeliverables.mockImplementation((taskId: string) =>
      taskId === "task-one" ? firstDeliverables.promise : secondDeliverables.promise,
    );
    apiMocks.fetchTaskSubagents.mockImplementation((taskId: string) =>
      taskId === "task-one" ? firstSubagents.promise : secondSubagents.promise,
    );
    apiMocks.fetchRuntimeLifecycle.mockImplementation((query: { taskId: string }) =>
      query.taskId === "task-one" ? firstLifecycle.promise : secondLifecycle.promise,
    );

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      await click(renderer, "Second task");
      secondActivities.resolve({
        items: [
          {
            activityId: "activity-second",
            activityType: "comment",
            message: "Second detail loaded",
            createdAt: "2026-05-14T00:03:00.000Z",
          },
        ],
      });
      secondDeliverables.resolve({ items: [] });
      secondSubagents.resolve({ items: [] });
      secondLifecycle.resolve(null);
      await flush();

      firstActivities.resolve({
        items: [
          {
            activityId: "activity-first",
            activityType: "comment",
            message: "First stale detail",
            createdAt: "2026-05-14T00:04:00.000Z",
          },
        ],
      });
      firstDeliverables.resolve({ items: [] });
      firstSubagents.resolve({ items: [] });
      firstLifecycle.resolve(null);
      await flush();

      expect(text(renderer)).toContain("Second task");
      expect(text(renderer)).toContain("Second detail loaded");
      expect(text(renderer)).not.toContain("First stale detail");
    } finally {
      renderer.unmount();
    }
  });

  it("keeps the empty inspector navigation visible when there is no selected task", async () => {
    apiMocks.fetchTasksByView.mockResolvedValue({ items: [] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      expect(text(renderer)).toContain("No tasks in this view yet");
      expect(text(renderer)).toContain("Select a task to inspect details");

      await click(renderer, "Back to active tasks");
      expect(text(renderer)).toContain("No tasks in this view yet");
    } finally {
      renderer.unmount();
    }
  });

  it("uses builtin role metadata for advanced subagent details and cancels delete confirmation", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<TasksPage />);
      });
      await flush();

      expect(text(renderer)).toContain("No existing session IDs found yet.");
      await click(renderer, "Show advanced subagent details");
      expect(text(renderer)).toContain("Advanced mode lets you provide arbitrary session IDs");

      await act(async () => {
        input(renderer, "Role id").props.onChange({ target: { value: "coder" } });
      });
      await act(async () => {
        input(renderer, "Session id").props.onChange({ target: { value: "session-external" } });
      });
      await click(renderer, "Add Subagent");

      expect(apiMocks.registerTaskSubagent).toHaveBeenCalledWith("task-one", {
        agentName: "Coder Goat",
        agentSessionId: "session-external",
      });

      await click(renderer, "Move to Trash");
      expect(text(renderer)).toContain("Move Task To Trash");
      await click(renderer, "Cancel");

      expect(apiMocks.deleteTask).not.toHaveBeenCalled();
      expect(text(renderer)).not.toContain("Move Task To Trash");
    } finally {
      renderer.unmount();
    }
  });
});

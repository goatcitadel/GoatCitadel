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
  SelectOrCustom: ({ value, customLabel }: { value?: string; customLabel?: string }) => (
    <div>
      {customLabel}
      {value}
    </div>
  ),
}));
vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({ open, title, message }: { open?: boolean; title?: string; message?: string }) =>
    open ? (
      <div>
        {title}
        {message}
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
});

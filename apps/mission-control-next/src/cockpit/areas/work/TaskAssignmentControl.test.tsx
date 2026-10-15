// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentProfileRecord } from "@goatcitadel/contracts";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { fetchAgents } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { fetchTask, updateTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTaskMutationsForTests } from "../../../features/native-routes/ops/task-mutation-state";
import { TaskAssignmentControl } from "./TaskAssignmentControl";
import { TaskStatusControl } from "./TaskStatusControl";

vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({ fetchAgents: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTask: vi.fn(), updateTask: vi.fn() }));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "task-a",
  revision: 2,
  workspaceId: "workspace-a",
  title: "Scoped task",
  status: "review",
  priority: "normal",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T01:00:00.000Z",
  ...overrides,
});
const agent: AgentProfileRecord = {
  agentId: "agent-a",
  roleId: "coder",
  name: "Coder",
  title: "Coder",
  summary: "Implementation",
  specialties: [],
  defaultTools: [],
  aliases: [],
  isBuiltin: true,
  editable: false,
  lifecycleStatus: "active",
  status: "idle",
  sessionCount: 0,
  activeSessions: 0,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  __resetTaskMutationsForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchAgents).mockResolvedValue({ items: [agent] });
  vi.mocked(fetchTask).mockResolvedValue(task());
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

async function render(record = task()): Promise<void> {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskAssignmentControl task={record} workspaceId="workspace-a" />
      </QueryClientProvider>,
    ),
  );
  await act(async () =>
    vi.waitFor(() =>
      expect(
        container.querySelector("select") !== null ||
          container.textContent?.includes("task action outcome is unconfirmed"),
      ).toBe(true),
    ),
  );
}

async function chooseAgent(): Promise<void> {
  const select = container.querySelector("select");
  if (!select) throw new Error("Missing agent selector");
  await act(async () => {
    select.value = "agent-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
}

describe("cockpit task assignment", () => {
  it("saves a board assignment with fresh preflight and no risk dialog", async () => {
    const saved = task({ revision: 3, assignedAgentId: "agent-a" });
    vi.mocked(updateTask).mockResolvedValue(saved);
    vi.mocked(fetchTask).mockResolvedValueOnce(task()).mockResolvedValue(saved);
    await render();
    await chooseAgent();
    await click("Save task assignment");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith("task-a", {
        workspaceId: "workspace-a",
        expectedRevision: 2,
        assignedAgentId: "agent-a",
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("does not start a run"));
  });

  it("withholds assignment after the task revision changes", async () => {
    vi.mocked(fetchTask).mockResolvedValue(task({ revision: 3 }));
    await render();
    await chooseAgent();
    await click("Save task assignment");
    await vi.waitFor(() => expect(container.textContent).toContain("changed during review"));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("withholds assignment when the selected agent leaves the active catalog", async () => {
    vi.mocked(fetchAgents)
      .mockResolvedValueOnce({ items: [agent] })
      .mockResolvedValue({ items: [] });
    await render();
    await chooseAgent();
    await click("Save task assignment");
    await vi.waitFor(() => expect(container.textContent).toContain("no longer in the active catalog"));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("locks further assignment after an unconfirmed owner response", async () => {
    window.history.replaceState(
      { evidence: "retained-task-recovery" },
      "",
      "/work?workspaceId=old-workspace&citadelId=current-citadel&runId=run-a&sessionId=session-a&filter=retained&taskId=obsolete&shell=cockpit&shellScope=visit#task-evidence",
    );
    vi.mocked(updateTask).mockRejectedValue(new Error("Response lost"));
    await render();
    await chooseAgent();
    await click("Save task assignment");
    await vi.waitFor(() => expect(container.textContent).toContain("task action outcome is unconfirmed"));
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button")].some(
        (item) => item.textContent?.trim() === "Save task assignment",
      ),
    ).toBe(false);
    const recovery = container.querySelector<HTMLAnchorElement>('a[href^="/work/tasks/task-a?"]');
    expect(recovery).not.toBeNull();
    const destination = new URL(recovery!.href);
    expect(destination.pathname).toBe("/work/tasks/task-a");
    expect(destination.searchParams.get("workspaceId")).toBe("workspace-a");
    expect(destination.searchParams.get("citadelId")).toBe("current-citadel");
    expect(destination.searchParams.get("runId")).toBe("run-a");
    expect(destination.searchParams.get("sessionId")).toBe("session-a");
    expect(destination.searchParams.get("filter")).toBe("retained");
    expect(destination.searchParams.get("taskId")).toBeNull();
    expect(destination.searchParams.get("shell")).toBe("cockpit");
    expect(destination.searchParams.get("shellScope")).toBeNull();
    expect(destination.hash).toBe("#task-evidence");
    expect(window.history.state).toMatchObject({ evidence: "retained-task-recovery" });
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).toContain("task action outcome is unconfirmed");
    expect(updateTask).toHaveBeenCalledTimes(1);
  });
});

it("keeps an uncertain direct status mutation locked and offers its exact native record", async () => {
  vi.mocked(updateTask).mockRejectedValue(new Error("Response lost"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskStatusControl task={task()} workspaceId="workspace-a" canMarkDone={false} />
      </QueryClientProvider>,
    ),
  );
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Status"]');
  expect(select).not.toBeNull();
  await act(async () => {
    select!.value = "inbox";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Save task status");
  await vi.waitFor(() => expect(container.textContent).toContain("task action outcome is unconfirmed"));
  expect(updateTask).toHaveBeenCalledExactlyOnceWith("task-a", {
    workspaceId: "workspace-a",
    expectedRevision: 2,
    status: "inbox",
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('select[aria-label="Status"]')).toBeNull();
  const recovery = container.querySelector<HTMLAnchorElement>('a[href^="/work/tasks/task-a?"]');
  expect(recovery).not.toBeNull();
  expect(new URL(recovery!.href).searchParams.get("workspaceId")).toBe("workspace-a");
  await act(async () => root.render(null));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskStatusControl task={task()} workspaceId="workspace-a" canMarkDone={false} />
      </QueryClientProvider>,
    ),
  );
  expect(container.textContent).toContain("task action outcome is unconfirmed");
  expect(container.querySelector('select[aria-label="Status"]')).toBeNull();
  expect(updateTask).toHaveBeenCalledTimes(1);
});

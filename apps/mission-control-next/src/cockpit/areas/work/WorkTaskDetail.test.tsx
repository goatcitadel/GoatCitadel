// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchTask,
  fetchTaskActivities,
  fetchTaskDeliverables,
  updateTask,
} from "@goatcitadel/mission-control-shared/api/tasks";
import { fetchAgents } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { WorkTaskDetail } from "./WorkTaskDetail";
import { __resetTaskMutationsForTests } from "../../../features/native-routes/ops/task-mutation-state";

vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({
  fetchTask: vi.fn(),
  fetchTaskActivities: vi.fn(),
  fetchTaskDeliverables: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({ fetchAgents: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ navigate: vi.fn() }),
}));
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

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  __resetTaskMutationsForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchTaskActivities).mockResolvedValue({ items: [] });
  vi.mocked(fetchTaskDeliverables).mockResolvedValue({ items: [] });
  vi.mocked(fetchAgents).mockResolvedValue({ items: [] });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkTaskDetail taskId="task-a" />
      </QueryClientProvider>,
    ),
  );
}

describe("Work task detail", () => {
  it("withholds a foreign record and does not request its detail evidence", async () => {
    vi.mocked(fetchTask).mockResolvedValue(task({ workspaceId: "workspace-b", title: "PRIVATE TASK" }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Task outside this workspace"));
    expect(container.textContent).not.toContain("PRIVATE TASK");
    expect(fetchTaskActivities).not.toHaveBeenCalled();
    expect(fetchTaskDeliverables).not.toHaveBeenCalled();
  });

  it("rechecks the exact revision before changing a manually owned board status", async () => {
    vi.mocked(fetchTask)
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ revision: 3 }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Scoped task"));
    const select = container.querySelector("select");
    if (!select) throw new Error("Missing status selector");
    await act(async () => {
      select.value = "blocked";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review change");
    if (!review) throw new Error("Missing review control");
    await act(async () => review.click());
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm status change",
    );
    if (!confirm) throw new Error("Missing confirmation control");
    await act(async () => confirm.click());
    await vi.waitFor(() => expect(container.textContent).toContain("This task changed"));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("sends a confirmed scoped revision to the task owner", async () => {
    vi.mocked(fetchTask).mockResolvedValue(task());
    const saved = task({ revision: 3, status: "blocked" });
    vi.mocked(updateTask).mockImplementation(async () => {
      vi.mocked(fetchTask).mockResolvedValue(saved);
      return saved;
    });
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("Scoped task"));
    const select = container.querySelector("select");
    if (!select) throw new Error("Missing status selector");
    await act(async () => {
      select.value = "blocked";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const review = [...container.querySelectorAll("button")].find((button) => button.textContent === "Review change");
    if (!review) throw new Error("Missing review control");
    await act(async () => review.click());
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm status change",
    );
    if (!confirm) throw new Error("Missing confirmation control");
    await act(async () => confirm.click());
    await vi.waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith("task-a", {
        workspaceId: "workspace-a",
        expectedRevision: 2,
        status: "blocked",
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Gateway recorded blocked"));
  });

  it("keeps status mutation unavailable when a runtime execution owns the task", async () => {
    vi.mocked(fetchTask).mockResolvedValue(task({ agenticContext: { runId: "run-a" } }));
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("runtime execution owner"));
    expect(container.querySelector("select")).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
  });
});

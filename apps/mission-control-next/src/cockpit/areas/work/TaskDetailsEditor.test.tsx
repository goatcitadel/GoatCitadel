// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { fetchTask, updateTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTaskMutationsForTests } from "../../../features/native-routes/ops/task-mutation-state";
import { TaskDetailsEditor } from "./TaskDetailsEditor";
import { __resetSessionDraftsForTests, discardSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { taskDetailsDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

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
  title: "Original title",
  description: "Original description",
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
  __resetSessionDraftsForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchTask).mockResolvedValue(task());
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

async function render(record = task(), workspaceId = "workspace-a"): Promise<void> {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskDetailsEditor task={record} workspaceId={workspaceId} />
      </QueryClientProvider>,
    ),
  );
}

async function changeTitle(next: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error("Missing title input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing ${label} button`);
  await act(async () => button.click());
}

describe("cockpit task details editor", () => {
  it("saves only after confirmation using the current scoped revision", async () => {
    const saved = task({ revision: 3, title: "Updated title" });
    vi.mocked(updateTask).mockResolvedValue(saved);
    vi.mocked(fetchTask).mockResolvedValueOnce(task()).mockResolvedValue(saved);
    await render();
    await changeTitle("Updated title");
    await click("Review details");
    expect(updateTask).not.toHaveBeenCalled();
    await click("Confirm details");
    await vi.waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith("task-a", {
        workspaceId: "workspace-a",
        expectedRevision: 2,
        title: "Updated title",
        description: "Original description",
        priority: "normal",
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Gateway recorded the task details"));
  });

  it("withholds an edit when the owner revision changes during review", async () => {
    vi.mocked(fetchTask).mockResolvedValue(task({ revision: 3 }));
    await render();
    await changeTitle("Updated title");
    await click("Review details");
    await click("Confirm details");
    await vi.waitFor(() => expect(container.textContent).toContain("changed during review"));
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("locks another request after an unconfirmed edit outcome", async () => {
    vi.mocked(updateTask).mockRejectedValue(new Error("Response lost"));
    await render();
    await changeTitle("Updated title");
    await click("Review details");
    await click("Confirm details");
    await vi.waitFor(() => expect(container.textContent).toContain("task action outcome is unconfirmed"));
    expect(container.querySelector<HTMLInputElement>("input")).toBeNull();
    expect(container.querySelector('a[href="/ops/kanban?taskId=task-a&shell=classic"]')).not.toBeNull();
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).toContain("task action outcome is unconfirmed");
    expect(container.querySelector<HTMLInputElement>("input")).toBeNull();
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a review after its editor unmounts during preflight", async () => {
    let resolve!: (record: TaskRecord) => void;
    vi.mocked(fetchTask).mockReturnValue(
      new Promise<TaskRecord>((done) => {
        resolve = done;
      }),
    );
    await render();
    await changeTitle("Updated title");
    await click("Review details");
    await click("Confirm details");
    await act(async () => root.render(null));
    await act(async () => resolve(task()));
    expect(updateTask).not.toHaveBeenCalled();
    await render();
    expect(container.querySelector<HTMLInputElement>("input")).not.toBeNull();
  });

  it("does not edit runtime-owned task details", async () => {
    await render(task({ agenticContext: { runId: "run-a" } }));
    expect(container.textContent).toContain("A runtime execution owns this task");
    expect(container.querySelector<HTMLInputElement>("input")).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe("retained task detail input", () => {
  it("preserves the original comparison record across unmount and blocks a changed owner", async () => {
    await render(); await changeTitle("Unsent detail draft");
    await act(async () => root.render(null));
    const updated = task({ revision: 3, title: "Owner changed title" });
    await render(updated);
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Unsent detail draft");
    expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(container.textContent).toContain("The task changed while this editor was open.");
    await click("Load current details");
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Owner changed title");
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("isolates record drafts and discards only the exact task input", async () => {
    await render(); await changeTitle("Task A draft");
    const other = task({ taskId: "task-b", title: "Other task" });
    await render(other); await changeTitle("Task B draft");
    await render();
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Task A draft");
    await act(async () => discardSessionDraft(taskDetailsDraftKey(getGatewayApiBaseUrl(), "workspace-a", "task-a")));
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Original title");
    await render(other);
    expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("Task B draft");
    expect(updateTask).not.toHaveBeenCalled();
  });
});

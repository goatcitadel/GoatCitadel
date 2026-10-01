// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { fetchTask, updateTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetailsEditor } from "../../../cockpit/areas/work/TaskDetailsEditor";
import type { TaskDetailChange } from "./task-detail-mutation";
import { __resetTaskMutationsForTests, readTaskMutation, taskMutationKey } from "./task-mutation-state";
import { useTaskDetailReview } from "./use-task-detail-review";

vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://gateway-a",
}));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({
  fetchTask: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock("../../../cockpit/ui/Dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <section role="dialog">{children}</section> : null,
}));

const before: TaskRecord = {
  taskId: "task-a",
  workspaceId: "ws-a",
  revision: 2,
  title: "Original",
  description: "Context",
  priority: "normal",
  status: "review",
  assignedAgentId: "agent-a",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T01:00:00.000Z",
};
const change: TaskDetailChange = { kind: "details", title: "Edited", description: "Context", priority: "normal" };
const saved: TaskRecord = { ...before, revision: 3, title: "Edited" };
const key = taskMutationKey("http://gateway-a", "ws-a", "task-a");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let owner: ReturnType<typeof useTaskDetailReview>;
function Probe({ task, workspaceId }: { task: TaskRecord; workspaceId: string }) {
  owner = useTaskDetailReview(task, workspaceId);
  return null;
}
async function render(task = before, workspaceId = "ws-a") {
  await act(async () => {
    root.render(<Probe task={task} workspaceId={workspaceId} />);
  });
}
async function begin(changeToReview = change) {
  await act(async () => {
    owner.begin(before, changeToReview);
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetTaskMutationsForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchTask).mockResolvedValueOnce(before).mockResolvedValue(saved);
  vi.mocked(updateTask).mockResolvedValue(saved);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

describe("task review acknowledgement across owner refreshes", () => {
  it.each<{ label: string; change: TaskDetailChange; saved: TaskRecord }>([
    { label: "details", change, saved },
    {
      label: "status",
      change: { kind: "status", status: "blocked" },
      saved: { ...before, revision: 3, status: "blocked" },
    },
    {
      label: "assignment",
      change: { kind: "assignment", assignedAgentId: null },
      saved: { ...before, revision: 3, assignedAgentId: undefined },
    },
  ])("acknowledges confirmed $label after its own exact record arrives before PATCH settles", async (example) => {
    const patch = deferred<TaskRecord>();
    const confirmed = vi.fn();
    vi.mocked(updateTask).mockReturnValue(patch.promise);
    vi.mocked(fetchTask).mockReset().mockResolvedValueOnce(before).mockResolvedValue(example.saved);
    await render();
    await begin(example.change);
    let pending!: Promise<void>;
    await act(async () => {
      pending = owner.confirm(confirmed);
    });
    expect(updateTask).toHaveBeenCalledTimes(1);
    await render(example.saved);
    expect(owner.review).toBeNull();
    expect(confirmed).not.toHaveBeenCalled();
    await act(async () => {
      patch.resolve(example.saved);
      await pending;
    });
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(example.saved);
    expect(fetchTask).toHaveBeenCalledTimes(2);
    expect(readTaskMutation(key).phase).toBe("idle");
  });

  it.each(["newer record", "different same-revision record", "owner ABA"])(
    "does not replace the current view after a %s arrives during confirmed readback",
    async (scenario) => {
      const readback = deferred<TaskRecord>();
      const confirmed = vi.fn();
      vi.mocked(fetchTask).mockReset().mockResolvedValueOnce(before).mockReturnValueOnce(readback.promise);
      await render();
      await begin();
      let pending!: Promise<void>;
      await act(async () => {
        pending = owner.confirm(confirmed);
      });
      expect(fetchTask).toHaveBeenCalledTimes(2);
      await render({ ...saved, revision: scenario === "different same-revision record" ? 3 : 4, title: "Other edit" });
      if (scenario === "owner ABA") await render(saved);
      await act(async () => {
        readback.resolve(saved);
        await pending;
      });
      expect(confirmed).not.toHaveBeenCalled();
      expect(readTaskMutation(key).phase).toBe("idle");
      expect(owner.uncertain).toBe(false);
    },
  );

  it("preserves user input ABA even when the own exact record arrives", async () => {
    const patch = deferred<TaskRecord>();
    const confirmed = vi.fn();
    vi.mocked(updateTask).mockReturnValue(patch.promise);
    await render();
    await begin();
    let pending!: Promise<void>;
    await act(async () => {
      pending = owner.confirm(confirmed);
    });
    // The editor calls invalidate for every input edit, even an edit back to its original value.
    await act(async () => {
      owner.invalidate();
    });
    await act(async () => {
      owner.invalidate();
    });
    await render(saved);
    await act(async () => {
      patch.resolve(saved);
      await pending;
    });
    expect(confirmed).not.toHaveBeenCalled();
    expect(readTaskMutation(key).phase).toBe("idle");
  });

  it("suppresses a confirmed callback after workspace navigation away and back", async () => {
    const patch = deferred<TaskRecord>();
    const confirmed = vi.fn();
    vi.mocked(updateTask).mockReturnValue(patch.promise);
    await render();
    await begin();
    let pending!: Promise<void>;
    await act(async () => {
      pending = owner.confirm(confirmed);
    });
    await render({ ...before, workspaceId: "ws-b" }, "ws-b");
    await render(saved);
    await act(async () => {
      patch.resolve(saved);
      await pending;
    });
    expect(confirmed).not.toHaveBeenCalled();
    expect(readTaskMutation(key).phase).toBe("idle");
  });

  it("still cancels preflight on an owner change, even if its value returns before dispatch", async () => {
    const preflight = deferred<TaskRecord>();
    const confirmed = vi.fn();
    vi.mocked(fetchTask).mockReset().mockReturnValueOnce(preflight.promise);
    await render();
    await begin();
    let pending!: Promise<void>;
    await act(async () => {
      pending = owner.confirm(confirmed);
    });
    await render(saved);
    await render(before);
    await act(async () => {
      preflight.resolve(before);
      await pending;
    });
    expect(updateTask).not.toHaveBeenCalled();
    expect(confirmed).not.toHaveBeenCalled();
    expect(readTaskMutation(key).phase).toBe("idle");
  });

  it("clears the details editor's self-save stale banner only after receipt and readback agree", async () => {
    const patch = deferred<TaskRecord>();
    vi.mocked(updateTask).mockReturnValue(patch.promise);
    const renderEditor = async (task: TaskRecord) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <TaskDetailsEditor task={task} workspaceId="ws-a" />
          </QueryClientProvider>,
        );
      });
    };
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
      if (!button) throw new Error(`Missing ${label}`);
      await act(async () => {
        button.click();
      });
    };
    await renderEditor(before);
    const input = container.querySelector("input");
    if (!input) throw new Error("Missing task title");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Edited");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Review details");
    await click("Confirm details");
    expect(updateTask).toHaveBeenCalledTimes(1);
    await renderEditor(saved);
    expect(container.textContent).toContain("The task changed while this editor was open");
    expect(container.textContent).not.toContain("Gateway recorded the task details");
    await act(async () => {
      patch.resolve(saved);
    });
    expect(container.textContent).toContain("Gateway recorded the task details");
    expect(container.textContent).not.toContain("The task changed while this editor was open");
    expect(container.querySelector("input")?.value).toBe("Edited");
    expect(container.querySelector("input")?.disabled).toBe(false);
  });
});

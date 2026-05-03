import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { NativeRoutePages } from "./NativeRoutePages";

const mocks = vi.hoisted(() => ({
  fetchTasksByView: vi.fn(async (view: "active" | "trash") => ({
    view,
    items:
      view === "active"
        ? [
            {
              taskId: "task-1",
              title: "Review release notes",
              description: "Confirm the current 1.0 evidence.",
              status: "planning",
              priority: "normal",
              createdAt: "2026-05-02T18:00:00.000Z",
              updatedAt: "2026-05-02T18:00:00.000Z",
            },
          ]
        : [],
  })),
  fetchOperators: vi.fn(async () => ({ items: [] })),
  fetchTaskDeliverables: vi.fn(async () => ({ items: [] })),
  createTask: vi.fn(async () => ({
    taskId: "task-2",
    title: "New task",
    status: "planning",
    priority: "high",
    createdAt: "2026-05-02T18:10:00.000Z",
    updatedAt: "2026-05-02T18:10:00.000Z",
  })),
  updateTask: vi.fn(async () => ({
    taskId: "task-1",
    title: "Review release notes",
    status: "done",
    priority: "high",
    createdAt: "2026-05-02T18:00:00.000Z",
    updatedAt: "2026-05-02T18:15:00.000Z",
  })),
  addTaskDeliverable: vi.fn(async () => ({
    deliverableId: "deliverable-1",
    taskId: "task-1",
    deliverableType: "artifact",
    title: "Release evidence",
    createdAt: "2026-05-02T18:20:00.000Z",
  })),
  deleteTask: vi.fn(async () => ({ deleted: true, taskId: "task-1", mode: "soft" })),
  restoreTask: vi.fn(async () => ({ restored: true, taskId: "task-1" })),
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@goatcitadel/mission-control-shared/api/client")>(
    "@goatcitadel/mission-control-shared/api/client",
  );
  return {
    ...actual,
    addTaskDeliverable: mocks.addTaskDeliverable,
    createTask: mocks.createTask,
    deleteTask: mocks.deleteTask,
    fetchOperators: mocks.fetchOperators,
    fetchTaskDeliverables: mocks.fetchTaskDeliverables,
    fetchTasksByView: mocks.fetchTasksByView,
    restoreTask: mocks.restoreTask,
    updateTask: mocks.updateTask,
  };
});

describe("NativeRoutePages Cowork task board", () => {
  it("creates, updates, adds deliverables, and soft-deletes tasks through task APIs", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderCoworkTasks();
    });

    await act(async () => {
      findInputByPlaceholder(renderer!.root, "Write release notes").props.onChange({ target: { value: "New task" } });
      findFieldControl(renderer!.root, "Priority", "select").props.onChange({ target: { value: "high" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Create task").props.onClick();
    });
    expect(mocks.createTask).toHaveBeenCalledWith({
      workspaceId: "default",
      title: "New task",
      description: undefined,
      priority: "high",
    });

    await act(async () => {
      findFieldControl(renderer!.root, "Status", "select").props.onChange({ target: { value: "done" } });
    });
    await act(async () => {
      findButton(renderer!.root, "Save task").props.onClick();
    });
    expect(mocks.updateTask).toHaveBeenCalledWith("task-1", expect.objectContaining({ status: "done" }));

    await act(async () => {
      findFieldControl(renderer!.root, "Deliverable title", "input").props.onChange({
        target: { value: "Release evidence" },
      });
    });
    await act(async () => {
      findButton(renderer!.root, "Add deliverable").props.onClick();
    });
    expect(mocks.addTaskDeliverable).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ title: "Release evidence", deliverableType: "artifact" }),
    );

    await act(async () => {
      findButton(renderer!.root, "Move to trash").props.onClick();
    });
    expect(mocks.deleteTask).toHaveBeenCalledWith("task-1", { mode: "soft", deletedBy: "operator" });
  });

  it("restores deleted tasks when the trash view returns a selected task", async () => {
    mocks.fetchTasksByView.mockImplementation(
      async (view: "active" | "trash") =>
        ({
          view,
          items:
            view === "trash"
              ? [
                  {
                    taskId: "task-1",
                    title: "Review release notes",
                    status: "planning",
                    priority: "normal",
                    deletedAt: "2026-05-02T18:30:00.000Z",
                    createdAt: "2026-05-02T18:00:00.000Z",
                    updatedAt: "2026-05-02T18:00:00.000Z",
                  },
                ]
              : [],
        }) as any,
    );
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderCoworkTasks();
    });
    await act(async () => {
      findButton(renderer!.root, "Restore").props.onClick();
    });

    expect(mocks.restoreTask).toHaveBeenCalledWith("task-1");
  });
});

function renderCoworkTasks(): ReactTestRenderer {
  return create(
    <NativeRoutePages
      route={{ area: "cowork", section: "tasks", theme: "ops" } as any}
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={0}
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findInputByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll(
    (node) =>
      node.type === "input" && typeof node.props?.placeholder === "string" && node.props.placeholder === placeholder,
  )[0];
  if (!match) {
    throw new Error(`Unable to find input: ${placeholder}`);
  }
  return match;
}

function findFieldControl(root: ReactTestInstance, label: string, control: "input" | "select"): ReactTestInstance {
  const field = root.findAll((node) => node.type === "label" && collectText(node).includes(label))[0];
  if (!field) {
    throw new Error(`Unable to find field: ${label}`);
  }
  return field.findByType(control);
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}

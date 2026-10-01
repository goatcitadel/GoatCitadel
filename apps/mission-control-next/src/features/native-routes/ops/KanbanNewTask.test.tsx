import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { createTask, fetchTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetTaskMutationsForTests } from "./task-mutation-state";
import { KanbanNewTask } from "./KanbanNewTask";

vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ createTask: vi.fn(), fetchTask: vi.fn() }));
const task = (): TaskRecord => ({
  taskId: "created",
  workspaceId: "ws-a",
  revision: 1,
  title: "Review release",
  status: "inbox",
  priority: "normal",
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z",
});
const onCreated = vi.fn<(task: TaskRecord) => void>();
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetTaskMutationsForTests();
  vi.mocked(createTask).mockResolvedValue(task());
  vi.mocked(fetchTask).mockResolvedValue(task());
});
async function mount() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<KanbanNewTask workspaceId="ws-a" onCreated={onCreated} />);
  });
  return renderer;
}
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map((child) => text(child as ReactTestInstance | string)).join("");
async function fill(renderer: ReactTestRenderer, value = "Review release") {
  await act(async () => renderer.root.findByType("input").props.onChange({ target: { value } }));
}
async function review(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }));
}
async function confirm(renderer: ReactTestRenderer) {
  const button = renderer.root.findAllByType("button").find((item) => text(item) === "Confirm create task");
  if (!button) throw new Error("Missing exact task review");
  await act(async () => button.props.onClick());
}

describe("classic task creation owner", () => {
  it("reviews exact input then acknowledges its original draft and navigates after owner readback", async () => {
    const renderer = await mount();
    await fill(renderer);
    await review(renderer);
    expect(createTask).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain("Create Review release in workspace ws-a");
    await confirm(renderer);
    expect(createTask).toHaveBeenCalledWith({ workspaceId: "ws-a", title: "Review release", priority: "normal" });
    expect(onCreated).toHaveBeenCalledWith(task());
    expect(renderer.root.findByType("input").props.value).toBe("");
  });

  it("retains an uncertain create after closing and reopening the classic form", async () => {
    vi.mocked(createTask).mockRejectedValue(new Error("lost after commit"));
    let renderer = await mount();
    await fill(renderer);
    await review(renderer);
    await confirm(renderer);
    await act(async () => renderer.unmount());
    renderer = await mount();
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(true);
    expect(renderer.root.findByType("input").props.value).toBe("Review release");
    expect(text(renderer.root)).toContain("create outcome is unconfirmed");
    await review(renderer);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("acknowledges late origin success without overwriting newer retained input or navigating", async () => {
    let resolve!: (task: TaskRecord) => void;
    vi.mocked(createTask).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    let renderer = await mount();
    await fill(renderer);
    await review(renderer);
    await confirm(renderer);
    // A late event from the origin editor must remain protected even after it leaves the document.
    await fill(renderer, "Newer retained note");
    await act(async () => renderer.unmount());
    await act(async () => {
      resolve(task());
      await Promise.resolve();
      await Promise.resolve();
    });
    renderer = await mount();
    expect(renderer.root.findByType("input").props.value).toBe("Newer retained note");
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
  });
});

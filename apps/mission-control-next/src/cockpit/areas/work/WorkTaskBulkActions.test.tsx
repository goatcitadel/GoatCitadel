// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { commitTaskBulkAction } from "../../../features/native-routes/ops/task-bulk-operation";
import { WorkTaskBulkActions } from "./WorkTaskBulkActions";

vi.mock("../../../features/native-routes/ops/task-bulk-operation", () => ({ commitTaskBulkAction: vi.fn() }));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));

const task = (taskId: string, status = "blocked", revision = 3) =>
  ({
    taskId,
    workspaceId: "ws",
    title: `Task ${taskId}`,
    status,
    revision,
    priority: "normal",
    createdAt: "x",
    updatedAt: "x",
  }) as TaskRecord;
let root: Root, container: HTMLDivElement;
const onSettled = vi.fn(),
  onClear = vi.fn(),
  onRefresh = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (selected: TaskRecord[]) =>
  act(async () =>
    root.render(
      <WorkTaskBulkActions
        workspaceId="ws"
        selected={selected}
        onSettled={onSettled}
        onClear={onClear}
        onRefresh={onRefresh}
      />,
    ),
  );
const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const dialog = () => container.querySelector('[role="dialog"]');

it("reviews exactly the selected tasks, sends nothing on Cancel and one request on Confirm", async () => {
  vi.mocked(commitTaskBulkAction).mockResolvedValue({ kind: "confirmed", tasks: [], changed: 2, matched: 0 });
  await render([task("a"), task("b")]);
  expect(container.textContent).toContain("2 tasks selected");
  expect(container.textContent).toContain("Runtime runs are not affected");
  await act(async () => button("Unblock…")!.click());
  for (const text of ["Task a", "Task b", "revision 3", "Returns each task to assigned", "nothing is applied"])
    expect(dialog()?.textContent).toContain(text);
  await act(async () => button("Cancel")!.click());
  expect(dialog()).toBeNull();
  expect(commitTaskBulkAction).not.toHaveBeenCalled();
  await act(async () => button("Close…")!.click());
  expect(dialog()?.textContent).toContain("refuses the whole batch if any task has no deliverable");
  await act(async () => button("Close 2 tasks")!.click());
  expect(commitTaskBulkAction).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ action: "close", workspaceId: "ws", reviewed: [task("a"), task("b")] }),
  );
  expect(onSettled).toHaveBeenCalledWith("2 tasks updated.");
  expect(dialog()).toBeNull();
});

it("keeps the selection and refreshes when the tasks changed or conflicted", async () => {
  vi.mocked(commitTaskBulkAction).mockResolvedValue({
    kind: "conflict",
    message: "One or more selected tasks changed on the Gateway.",
  });
  await render([task("a")]);
  await act(async () => button("Retry…")!.click());
  expect(dialog()?.textContent).toContain("Records one retry attempt");
  await act(async () => button("Retry 1 task")!.click());
  expect(dialog()?.textContent).toContain("One or more selected tasks changed");
  expect(onRefresh).toHaveBeenCalled();
  expect(onClear).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
  expect(button("Retry 1 task")).toBeUndefined();
});

it("reports a refusal or an unconfirmed outcome without claiming success", async () => {
  vi.mocked(commitTaskBulkAction).mockResolvedValue({ kind: "uncertain", message: "socket hang up" });
  await render([task("a")]);
  await act(async () => button("Close…")!.click());
  await act(async () => button("Close 1 task")!.click());
  expect(dialog()?.textContent).toContain("socket hang up");
  expect(onSettled).not.toHaveBeenCalled();
});

it("offers no action without a selection", async () => {
  await render([]);
  expect(button("Unblock…")?.disabled).toBe(true);
  expect(button("Close…")?.disabled).toBe(true);
});

import { beforeEach, expect, it, vi } from "vitest";
import { fetchTask, deleteTask, restoreTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { performTaskArchiveAction } from "./task-archive-operation";
import { __resetTaskMutationsForTests, readTaskMutation, taskMutationKey } from "./task-mutation-state";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ fetchTask: vi.fn(), deleteTask: vi.fn(), restoreTask: vi.fn() }));
const task = { taskId: "task", revision: 1, title: "Legacy default task", status: "done" as const, priority: "normal" as const, createdAt: "2026-10-06", updatedAt: "2026-10-06" };
beforeEach(() => { vi.resetAllMocks(); __resetTaskMutationsForTests(); });
it("archives and restores default-scope tasks using revision fences and independent records", async () => {
  const archived = { ...task, revision: 2, deletedAt: "2026-10-06" };
  vi.mocked(fetchTask).mockResolvedValueOnce(task).mockResolvedValueOnce(archived);
  vi.mocked(deleteTask).mockResolvedValue({ deleted: true, taskId: task.taskId, mode: "soft" });
  expect(await performTaskArchiveAction(task, "default", "archive", () => true)).toEqual(archived);
  expect(deleteTask).toHaveBeenCalledWith("task", { expectedRevision: 1, workspaceId: "default", mode: "soft" });
  vi.mocked(fetchTask).mockResolvedValueOnce(archived).mockResolvedValueOnce({ ...task, revision: 3 });
  vi.mocked(restoreTask).mockResolvedValue({ restored: true, taskId: task.taskId });
  expect(await performTaskArchiveAction(archived, "default", "restore", () => true)).toEqual({ ...task, revision: 3 });
  expect(restoreTask).toHaveBeenCalledWith("task", 2, "default");
});
it("withholds stale or cancelled review without a mutation", async () => {
  vi.mocked(fetchTask).mockResolvedValue({ ...task, revision: 2 });
  await expect(performTaskArchiveAction(task, "default", "archive", () => true)).rejects.toThrow("task changed");
  expect(await performTaskArchiveAction(task, "default", "archive", () => false)).toBeUndefined(); expect(deleteTask).not.toHaveBeenCalled();
});
it("locks an uncertain request across shells", async () => {
  vi.mocked(fetchTask).mockResolvedValue(task); vi.mocked(deleteTask).mockRejectedValue(new Error("Lost response"));
  await expect(performTaskArchiveAction(task, "default", "archive", () => true)).rejects.toThrow("Lost response");
  expect(readTaskMutation(taskMutationKey(getGatewayApiBaseUrl(), "default", "task")).phase).toBe("uncertain");
});

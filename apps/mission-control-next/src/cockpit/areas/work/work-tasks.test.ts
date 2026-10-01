import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { projectWorkTasks, sameTaskEvidence, taskMatchesWorkspace } from "./work-tasks";

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: "task-a", revision: 2, workspaceId: "workspace-a", title: "Review result", status: "review",
  priority: "normal", createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T01:00:00.000Z",
  ...overrides,
});

describe("workspace task projection", () => {
  it("shows only scoped active tasks and keeps review work waiting", () => {
    const projected = projectWorkTasks([
      task(), task({ taskId: "foreign", workspaceId: "workspace-b" }),
      task({ taskId: "unknown", workspaceId: undefined }),
      task({ taskId: "deleted", deletedAt: "2026-09-29T02:00:00.000Z" }),
      task({ taskId: "done", status: "done" }),
    ], "workspace-a");
    expect(projected.waiting.map((item) => item.taskId)).toEqual(["task-a"]);
    expect(projected.done.map((item) => item.taskId)).toEqual(["done"]);
    expect(projected.running).toEqual([]);
    expect(taskMatchesWorkspace(task({ workspaceId: undefined }), "workspace-a")).toBe(false);
  });

  it("requires the exact reviewed revision and action fields before a status change", () => {
    expect(sameTaskEvidence(task(), task())).toBe(true);
    expect(sameTaskEvidence(task(), task({ revision: 3 }))).toBe(false);
    expect(sameTaskEvidence(task(), task({ status: "done" }))).toBe(false);
    expect(sameTaskEvidence(task(), task({ assignedAgentId: "agent-b" }))).toBe(false);
  });

  it("keeps only the latest revision when paged owner results overlap", () => {
    const projected = projectWorkTasks([
      task({ status: "review", revision: 2 }),
      task({ status: "blocked", revision: 3, updatedAt: "2026-09-29T02:00:00.000Z" }),
    ], "workspace-a");
    expect(projected.waiting).toHaveLength(1);
    expect(projected.waiting[0]?.status).toBe("blocked");
  });
});

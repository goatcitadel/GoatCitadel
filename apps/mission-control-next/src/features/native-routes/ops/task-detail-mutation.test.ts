import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "@goatcitadel/contracts";
import { fetchTask, fetchTaskDeliverables, updateTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { fetchAgents } from "@goatcitadel/mission-control-shared/api/operators-agents-files";
import { commitTaskDetailReview } from "./task-detail-mutation";
import { __resetTaskMutationsForTests, readTaskMutation, taskMutationKey } from "./task-mutation-state";

const installation = vi.hoisted(() => ({ base: "http://gateway-a" }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => installation.base,
}));
vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({
  fetchTask: vi.fn(),
  fetchTaskDeliverables: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/operators-agents-files", () => ({ fetchAgents: vi.fn() }));
const task: TaskRecord = {
  taskId: "task-a",
  workspaceId: "ws-a",
  revision: 2,
  title: "Original",
  description: "Context",
  priority: "normal",
  status: "review",
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T01:00:00.000Z",
};
const saved: TaskRecord = { ...task, revision: 3, title: "Edited" };
const key = taskMutationKey("http://gateway-a", "ws-a", "task-a");
const review = (current = () => true) => ({
  task,
  workspaceId: "ws-a",
  base: "http://gateway-a",
  current,
  change: { kind: "details" as const, title: "Edited", description: "Context", priority: "normal" as const },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  __resetTaskMutationsForTests();
  vi.resetAllMocks();
  installation.base = "http://gateway-a";
  vi.mocked(fetchTask).mockResolvedValueOnce(task).mockResolvedValue(saved);
  vi.mocked(updateTask).mockResolvedValue(saved);
});

describe("shared task detail mutation evidence", () => {
  it("withholds Done when the fresh deliverable owner is empty", async () => {
    vi.mocked(fetchTaskDeliverables).mockResolvedValue({ items: [] });
    expect((await commitTaskDetailReview({ ...review(), change: { kind: "status", status: "done" } })).kind).toBe(
      "blocked",
    );
    expect(updateTask).not.toHaveBeenCalled();
  });
  it("rejects a foreign deliverable instead of treating it as Done evidence", async () => {
    vi.mocked(fetchTaskDeliverables).mockResolvedValue({
      items: [
        {
          deliverableId: "d-a",
          taskId: "foreign",
          deliverableType: "file",
          title: "Output",
          createdAt: task.createdAt,
        },
      ],
    });
    expect((await commitTaskDetailReview({ ...review(), change: { kind: "status", status: "done" } })).kind).toBe(
      "blocked",
    );
    expect(updateTask).not.toHaveBeenCalled();
  });
  it("confirms Done only from fresh same-task deliverables and independent task readback", async () => {
    vi.mocked(fetchTaskDeliverables).mockResolvedValue({
      items: [
        { deliverableId: "d-a", taskId: "task-a", deliverableType: "file", title: "Output", createdAt: task.createdAt },
      ],
    });
    const done = { ...task, revision: 3, status: "done" as const };
    vi.mocked(updateTask).mockResolvedValue(done);
    vi.mocked(fetchTask).mockReset().mockResolvedValueOnce(task).mockResolvedValue(done);
    expect(await commitTaskDetailReview({ ...review(), change: { kind: "status", status: "done" } })).toEqual({
      kind: "confirmed",
      task: done,
    });
    expect(fetchTaskDeliverables).toHaveBeenCalledWith(
      "task-a",
      "ws-a",
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("confirms the exact revision transition only after an independent read", async () => {
    expect(await commitTaskDetailReview(review())).toEqual({ kind: "confirmed", task: saved });
    expect(fetchTask).toHaveBeenCalledTimes(2);
    expect(updateTask).toHaveBeenCalledWith("task-a", {
      workspaceId: "ws-a",
      expectedRevision: 2,
      title: "Edited",
      description: "Context",
      priority: "normal",
    });
    expect(readTaskMutation(key).phase).toBe("idle");
  });
  it("cancels a stale view without an owner mutation", async () => {
    expect((await commitTaskDetailReview(review(() => false))).kind).toBe("cancelled");
    expect(fetchTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });
  it("cancels an input ABA while the preflight read is pending", async () => {
    const read = deferred<TaskRecord>();
    vi.mocked(fetchTask).mockReset().mockReturnValue(read.promise);
    let epoch = 1;
    const pending = commitTaskDetailReview(review(() => epoch === 1));
    epoch += 2;
    read.resolve(task);
    expect((await pending).kind).toBe("cancelled");
    expect(updateTask).not.toHaveBeenCalled();
    expect(readTaskMutation(key).phase).toBe("idle");
  });
  it.each([
    { revision: 3 },
    { description: "Changed" },
    { updatedAt: "2026-09-29T02:00:00.000Z" },
    { agenticContext: { runId: "run-a" } },
    { deletedAt: "2026-09-29T02:00:00.000Z" },
  ])("withholds changed or runtime-owned evidence %j", async (change) => {
    vi.mocked(fetchTask)
      .mockReset()
      .mockResolvedValue({ ...task, ...change });
    expect((await commitTaskDetailReview(review())).kind).toBe("blocked");
    expect(updateTask).not.toHaveBeenCalled();
    expect(readTaskMutation(key).phase).toBe("idle");
  });
  it("rechecks active catalog before assignment", async () => {
    vi.mocked(fetchAgents).mockResolvedValue({ items: [] });
    const assignment = { ...review(), change: { kind: "assignment" as const, assignedAgentId: "agent-a" } };
    expect((await commitTaskDetailReview(assignment)).kind).toBe("blocked");
    expect(updateTask).not.toHaveBeenCalled();
  });
  it("uses the same task lock for details and assignment", async () => {
    const read = deferred<TaskRecord>();
    vi.mocked(fetchTask).mockReset().mockReturnValue(read.promise);
    const pending = commitTaskDetailReview(review());
    expect(
      (await commitTaskDetailReview({ ...review(), change: { kind: "assignment", assignedAgentId: null } })).kind,
    ).toBe("blocked");
    read.resolve({ ...task, revision: 3 });
    await pending;
    expect(fetchTask).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
  });
  it.each([
    { taskId: "foreign" },
    { workspaceId: "other" },
    { revision: 4 },
    { priority: "urgent" as const },
    { assignedAgentId: "unreviewed-agent" },
  ])("retains unknown for a contradictory receipt %j", async (change) => {
    vi.mocked(updateTask).mockResolvedValue({ ...saved, ...change });
    expect((await commitTaskDetailReview(review())).kind).toBe("uncertain");
    expect(readTaskMutation(key).phase).toBe("uncertain");
    expect((await commitTaskDetailReview(review())).kind).toBe("blocked");
    expect(updateTask).toHaveBeenCalledTimes(1);
  });
  it("retains unknown after a lost response or contradictory independent read", async () => {
    vi.mocked(fetchTask)
      .mockReset()
      .mockResolvedValueOnce(task)
      .mockResolvedValue({ ...saved, revision: 4 });
    expect((await commitTaskDetailReview(review())).kind).toBe("uncertain");
    expect(readTaskMutation(key).phase).toBe("uncertain");
  });
  it("retains unknown after a transport rejection", async () => {
    vi.mocked(updateTask).mockRejectedValue(new Error("reply lost"));
    expect((await commitTaskDetailReview(review())).kind).toBe("uncertain");
    expect(readTaskMutation(key).phase).toBe("uncertain");
  });
  it("settles the dispatched origin even when its view leaves", async () => {
    const receipt = deferred<TaskRecord>();
    vi.mocked(updateTask).mockReturnValue(receipt.promise);
    let mounted = true;
    const pending = commitTaskDetailReview(review(() => mounted));
    await vi.waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1));
    mounted = false;
    receipt.resolve(saved);
    expect((await pending).kind).toBe("confirmed");
    expect(readTaskMutation(key).phase).toBe("idle");
  });
  it("keeps uncertainty on the original installation after a base change", async () => {
    vi.mocked(updateTask).mockImplementation(async () => {
      installation.base = "http://gateway-b";
      return saved;
    });
    expect((await commitTaskDetailReview(review())).kind).toBe("uncertain");
    expect(readTaskMutation(key).phase).toBe("uncertain");
    expect(readTaskMutation(taskMutationKey(installation.base, "ws-a", "task-a")).phase).toBe("idle");
  });
});

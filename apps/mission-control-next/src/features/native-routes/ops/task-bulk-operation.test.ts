import { beforeEach, expect, it, vi } from "vitest";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { bulkTaskAction, fetchTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { commitTaskBulkAction } from "./task-bulk-operation";
import { __resetTaskMutationsForTests, readTaskMutation, taskMutationKey } from "./task-mutation-state";

vi.mock("@goatcitadel/mission-control-shared/api/tasks", () => ({ bulkTaskAction: vi.fn(), fetchTask: vi.fn() }));

const task = (taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    taskId,
    workspaceId: "ws",
    title: `Task ${taskId}`,
    status: "blocked",
    priority: "normal",
    revision: 3,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  }) as TaskRecord;
const reviewed = [task("a"), task("b")];
const current = () => true;
const lock = (id: string) => readTaskMutation(taskMutationKey(getGatewayApiBaseUrl(), "ws", id)).phase;
const bulkError = (status: number) =>
  new ApiRequestError("refused", { kind: "http", status, method: "POST", path: "/api/v1/tasks/bulk" });

beforeEach(() => {
  vi.resetAllMocks();
  __resetTaskMutationsForTests();
  vi.mocked(fetchTask).mockImplementation(async (id) => reviewed.find((item) => item.taskId === id)!);
});

it("reads every reviewed task fresh, sends one revision-checked request and confirms by owner readback", async () => {
  const saved = reviewed.map((item) => ({ ...item, status: "assigned" as const, revision: 4 }));
  vi.mocked(bulkTaskAction).mockImplementation(async () => {
    vi.mocked(fetchTask).mockImplementation(async (id) => saved.find((item) => item.taskId === id)!);
    return { tasks: saved };
  });
  const result = await commitTaskBulkAction({ action: "unblock", reviewed, workspaceId: "ws", isCurrent: current });
  expect(result).toMatchObject({ kind: "confirmed", changed: 2, matched: 0 });
  expect(bulkTaskAction).toHaveBeenCalledExactlyOnceWith({
    action: "unblock",
    taskIds: ["a", "b"],
    expectedRevisionsByTaskId: { a: 3, b: 3 },
    workspaceId: "ws",
  });
  expect(lock("a")).toBe("idle");
});

it("sends nothing when a reviewed task changed before dispatch", async () => {
  vi.mocked(fetchTask).mockImplementation(async (id) =>
    id === "b" ? task("b", { revision: 4, status: "assigned" }) : reviewed[0]!,
  );
  const result = await commitTaskBulkAction({ action: "close", reviewed, workspaceId: "ws", isCurrent: current });
  expect(result).toMatchObject({ kind: "changed" });
  expect(bulkTaskAction).not.toHaveBeenCalled();
  expect(lock("b")).toBe("idle");
});

it("treats the Gateway's pre-commit refusals as refused, not uncertain", async () => {
  for (const status of [400, 404, 409]) {
    vi.mocked(bulkTaskAction).mockRejectedValueOnce(bulkError(status));
    const result = await commitTaskBulkAction({ action: "close", reviewed, workspaceId: "ws", isCurrent: current });
    expect(result).toMatchObject({ kind: status === 409 ? "conflict" : "refused" });
    expect(lock("a")).toBe("idle");
  }
});

it("locks the selected tasks when the outcome is unknown", async () => {
  vi.mocked(bulkTaskAction).mockRejectedValue(new Error("socket hang up"));
  const result = await commitTaskBulkAction({ action: "retry", reviewed, workspaceId: "ws", isCurrent: current });
  expect(result).toMatchObject({ kind: "uncertain" });
  expect(lock("a")).toBe("uncertain");
  expect(lock("b")).toBe("uncertain");
  expect(
    await commitTaskBulkAction({ action: "retry", reviewed, workspaceId: "ws", isCurrent: current }),
  ).toMatchObject({ kind: "locked" });
  expect(bulkTaskAction).toHaveBeenCalledOnce();
});

it("locks when the receipt does not match the reviewed tasks", async () => {
  vi.mocked(bulkTaskAction).mockResolvedValue({ tasks: [{ ...reviewed[0]!, revision: 4 }] });
  const result = await commitTaskBulkAction({ action: "retry", reviewed, workspaceId: "ws", isCurrent: current });
  expect(result).toMatchObject({ kind: "uncertain" });
  expect(lock("a")).toBe("uncertain");
});

it("counts tasks that already matched an idempotent action", async () => {
  const same = [task("a", { status: "done" }), task("b", { status: "blocked" })];
  const saved = [same[0]!, { ...same[1]!, status: "done" as const, revision: 4 }];
  vi.mocked(fetchTask).mockImplementation(async (id) => same.find((item) => item.taskId === id)!);
  vi.mocked(bulkTaskAction).mockImplementation(async () => {
    vi.mocked(fetchTask).mockImplementation(async (id) => saved.find((item) => item.taskId === id)!);
    return { tasks: saved };
  });
  const result = await commitTaskBulkAction({ action: "close", reviewed: same, workspaceId: "ws", isCurrent: current });
  expect(result).toMatchObject({ kind: "confirmed", changed: 1, matched: 1 });
});

it("stops before dispatch when the caller is no longer current", async () => {
  const result = await commitTaskBulkAction({ action: "close", reviewed, workspaceId: "ws", isCurrent: () => false });
  expect(result).toMatchObject({ kind: "cancelled" });
  expect(bulkTaskAction).not.toHaveBeenCalled();
  expect(lock("a")).toBe("idle");
});

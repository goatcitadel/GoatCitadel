import { expect, it, vi } from "vitest";
import { readRemoteWorkerChatUsage } from "./remote-worker-chat-execution-service.js";

function fixture() {
  const ref = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 2 };
  const record = { executionWorkspaceId: "workspace", sessionId: "session", turnId: "turn", durableRunId: "run",
    taskId: "task", workerId: "worker", operationId: "native-operation", dispatchGeneration: "dispatch" };
  const current = { ...record, workspaceId: record.executionWorkspaceId, eventId: "native-usage", transportStatus: "accepted",
    terminalOutcome: "completed", finishedAt: "2026-09-15T00:00:00.000Z", costUsd: 0.02 };
  const earlier = { ...current, eventId: "earlier-usage", operationId: "earlier-operation", costUsd: 0.01 };
  const storage = {
    modelUsageEvents: { findByEventId: vi.fn(async () => current), listRemoteWorkerAssignment: vi.fn(async () => [earlier, current]) },
    remoteWorkerBudgets: { getReservationForOperation: vi.fn(async () => ({ reservationId: "reservation" })),
      listRelatedAttempts: vi.fn(async () => []), reconcileToolAttempts: vi.fn(), listToolAttempts: vi.fn(async () => []) },
  };
  const sequence = { record, steps: [{ record, usageEventIds: [current.eventId] }], toolIntentIds: [] };
  const read = (includeHistory = true) => readRemoteWorkerChatUsage(storage as never, ref, sequence as never, includeHistory);
  return { ref, current, earlier, storage, read };
}

it("includes pre-native spending exactly once and keeps the ordinary sequence unchanged", async () => {
  const f = fixture();
  const events = await f.read();
  expect(events.map(event => event.eventId)).toEqual(["native-usage", "earlier-usage"]);
  expect(events.reduce((sum, event) => sum + event.costUsd!, 0)).toBeCloseTo(0.03);
  expect(f.storage.modelUsageEvents.listRemoteWorkerAssignment).toHaveBeenCalledWith("registry", "assignment", 2);
  f.storage.modelUsageEvents.listRemoteWorkerAssignment.mockClear();
  expect(await f.read(false)).toEqual([f.current]);
  expect(f.storage.modelUsageEvents.listRemoteWorkerAssignment).not.toHaveBeenCalled();
});

it.each([
  { transportStatus: "dispatch_unknown" }, { terminalOutcome: "in_flight" }, { finishedAt: undefined },
  { costUsd: undefined }, { workspaceId: "foreign" }, { workerId: "foreign" }, { durableRunId: "foreign" },
])("withholds completion when an earlier attempt is unresolved or out of scope: %j", async patch => {
  const f = fixture();
  Object.assign(f.earlier, patch);
  await expect(f.read()).rejects.toThrow("unresolved or mismatched model usage");
});

it("propagates a bounded read failure instead of publishing partial usage", async () => {
  const f = fixture();
  f.storage.modelUsageEvents.listRemoteWorkerAssignment.mockRejectedValue(new Error("usage read exceeds bound"));
  await expect(f.read()).rejects.toThrow("exceeds bound");
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRemoteWorkerTaskBoundDispatchLockPlan } from "./remote-worker-dispatch-lock-order.js";

describe("remote worker task-bound dispatch lock order", () => {
  it("acquires all shared roots once in the canonical cross-owner order", () => {
    const plan = buildRemoteWorkerTaskBoundDispatchLockPlan({
      sessionId: "session-a",
      executionWorkspaceId: "workspace-a",
      nodeId: "node-a",
      registryWorkspaceId: "registry-a",
      workerId: "worker-a",
      assignmentId: "assignment-a",
      assignmentGeneration: 3,
    });
    assert.deepEqual(
      plan.map((lock) => lock.namespace),
      [411, 411, 412, 501, 502, 505, 503, 504],
    );
    assert.deepEqual(
      plan.map((lock) => lock.key),
      [
        "session-a",
        "workspace-a",
        "workspace-a:node-a",
        "registry-a",
        "registry-a:worker-a",
        "registry-a:worker-a:workspace-a:node-a",
        "registry-a:assignment-a",
        "registry-a:assignment-a:3",
      ],
    );
    assert.ok(Object.isFrozen(plan));
    assert.ok(plan.every((lock) => Object.isFrozen(lock)));
  });

  it("sorts the shared session and workspace lock domain independently of caller identity order", () => {
    const plan = buildRemoteWorkerTaskBoundDispatchLockPlan({
      sessionId: "z-session",
      executionWorkspaceId: "a-workspace",
      nodeId: "node-a",
      registryWorkspaceId: "registry-a",
      workerId: "worker-a",
      assignmentId: "assignment-a",
      assignmentGeneration: 3,
    });
    assert.deepEqual(
      plan.slice(0, 2).map((lock) => [lock.namespace, lock.key]),
      [
        [411, "a-workspace"],
        [411, "z-session"],
      ],
    );
  });
});

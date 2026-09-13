import assert from "node:assert/strict";
import { remoteWorkerInferenceCanonicalSha256 as digest } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { TaskRepository } from "./task-repo.js";
import { RemoteWorkerChatTaskRepository } from "./remote-worker-chat-task-repo.js";
import { RemoteWorkerChatPlacementRepository } from "./remote-worker-chat-placement-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { RemoteWorkerChatContextRepository } from "./remote-worker-chat-context-repo.js";
import { prepareChatOfferFixture, CONNECTED_WORKER_CONTEXT_MESSAGES } from "./remote-worker-chat-offer-fixture.js";

/** Identical ordinary-Chat admission, rollback and lifecycle assertions on both
 * storage engines. Uses no native worker or external provider. */
export function verifyOrdinaryChatTaskAdmission(db: DatabaseClient): void {
  const runs = new DurableRunRepository(db);
  const tasks = new TaskRepository(db);
  const bindings = new RemoteWorkerChatTaskRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const countTasks = () => Number(db.prepare("SELECT COUNT(*) AS count FROM tasks").get<{ count: number }>()!.count);
  const initialTasks = countTasks();
  const seed = prepareChatOfferFixture(db, true, "-generic", { genericChat: true, subagentPolicy: "off" });
  const original = runs.getRun(seed.durableRunId);
  assert.equal(countTasks(), initialTasks, "admitting Chat alone creates no task");
  assert.equal(bindings.findForRun(original), undefined);
  assert.deepEqual(new RemoteWorkerChatContextRepository(db).findForRun(original.runId)?.messages,
    CONNECTED_WORKER_CONTEXT_MESSAGES);
  assert.equal((original.payload!.request as Record<string, unknown>).policyTaskId, undefined);

  assert.throws(() => assignments.scheduleTaskBoundChatOffer({ ...seed.offerInput, dispatchOwnerId: "stale-owner" }));
  assert.throws(() => assignments.scheduleTaskBoundChatOffer({ ...seed.offerInput,
    limits: { ...seed.offerInput.limits, maxOutputBytes: -1 } }));
  assert.equal(countTasks(), initialTasks, "failed offers roll back generated tasks");
  assert.equal(bindings.findForRun(original), undefined);

  const offered = assignments.scheduleTaskBoundChatOffer(seed.offerInput);
  const binding = bindings.findForRun(original)!;
  assert.ok(binding);
  assert.equal(offered.assignment.manifest.taskId, binding.taskId);
  assert.equal(offered.assignment.manifest.parentContextSha256, binding.parentContextSha256);
  assert.equal(countTasks(), initialTasks + 1);
  assert.deepEqual(runs.getRun(original.runId).payload, original.payload, "worker admission cannot rewrite the request");
  assert.deepEqual(tasks.get(binding.taskId).proactiveContext,
    { sessionId: seed.offerInput.sessionId, durableRunId: original.runId, originSurface: "chat" });
  assert.equal(tasks.get(binding.taskId).createdBy, "operator-a");
  assert.equal(tasks.get(binding.taskId).status, "in_progress");
  assert.equal(assignments.scheduleTaskBoundChatOffer({ ...seed.offerInput,
    durableRunVersion: runs.getRun(original.runId).version }).assignment.assignmentId, offered.assignment.assignmentId);
  assert.equal(countTasks(), initialTasks + 1, "replay reuses its task");
  assert.throws(() => bindings.findForRun({ ...original, payload: { ...original.payload, turnId: "other-turn" } }));
  assert.throws(() => bindings.findForRun({ ...original, payload: { ...original.payload,
    request: { ...(original.payload!.request as Record<string, unknown>), policyTaskId: binding.taskId } } }));
  for (const sql of ["UPDATE remote_worker_chat_tasks SET task_id = task_id WHERE durable_run_id = ?",
    "DELETE FROM remote_worker_chat_tasks WHERE durable_run_id = ?"])
    assert.throws(() => db.transaction("immediate", () => db.prepare(sql).run(original.runId)));

  let current = runs.getRun(original.runId);
  for (const [status, taskStatus] of [["waiting", "blocked"], ["queued", "in_progress"],
    ["running", "in_progress"], ["completed", "done"]] as const) {
    current = runs.updateRun({ runId: current.runId, status, expectedVersion: current.version });
    assert.equal(tasks.get(binding.taskId).status, taskStatus);
    assert.equal(digest(current.payload), digest(original.payload));
  }

  const local = prepareChatOfferFixture(db, true, "-generic-local", { genericChat: true });
  new RemoteWorkerChatPlacementRepository(db).claimLocal(runs.getRun(local.durableRunId));
  assert.throws(() => assignments.scheduleTaskBoundChatOffer(local.offerInput));
  assert.equal(bindings.findForRun(runs.getRun(local.durableRunId)), undefined);
  assert.equal(countTasks(), initialTasks + 1, "local placement never leaves a generated task");

  for (const status of ["cancelled", "failed", "dead_lettered"] as const) {
    const interrupted = prepareChatOfferFixture(db, true, `-generic-${status}`, { genericChat: true });
    assignments.scheduleTaskBoundChatOffer(interrupted.offerInput);
    const run = runs.getRun(interrupted.durableRunId);
    const taskId = bindings.findForRun(run)!.taskId;
    runs.updateRun({ runId: run.runId, status, expectedVersion: run.version });
    assert.equal(tasks.get(taskId).status, "blocked");
  }

  const atomic = prepareChatOfferFixture(db, true, "-generic-atomic", { genericChat: true });
  assignments.scheduleTaskBoundChatOffer(atomic.offerInput);
  const beforeAtomic = runs.getRun(atomic.durableRunId);
  const atomicTaskId = bindings.findForRun(beforeAtomic)!.taskId;
  const beforeTask = tasks.get(atomicTaskId);
  const updateTask = TaskRepository.prototype.updateWithRevision;
  try {
    TaskRepository.prototype.updateWithRevision = function (taskId, ...args) {
      if (taskId === atomicTaskId) throw new Error("task write unavailable");
      return updateTask.call(this, taskId, ...args);
    };
    assert.throws(() => runs.updateRun({ runId: beforeAtomic.runId, status: "completed",
      expectedVersion: beforeAtomic.version }), /task write unavailable/);
  } finally { TaskRepository.prototype.updateWithRevision = updateTask; }
  assert.deepEqual(runs.getRun(beforeAtomic.runId), beforeAtomic, "task failure rolls back the run transition");
  assert.deepEqual(tasks.get(atomicTaskId), beforeTask);
  assert.throws(() => runs.updateRun({ runId: beforeAtomic.runId, status: "completed",
    expectedVersion: beforeAtomic.version - 1 }));
  assert.deepEqual(tasks.get(atomicTaskId), beforeTask, "stale run claims cannot change task state");

  const userSelected = prepareChatOfferFixture(db, true, "-explicit-task");
  const explicit = assignments.scheduleTaskBoundChatOffer(userSelected.offerInput).assignment.manifest.taskId;
  const explicitBefore = tasks.get(explicit);
  const explicitRun = runs.getRun(userSelected.durableRunId);
  runs.updateRun({ runId: explicitRun.runId, status: "completed", expectedVersion: explicitRun.version });
  assert.deepEqual(tasks.get(explicit), explicitBefore, "existing task lifecycles keep their canonical owner");
  assert.equal(bindings.findForRun(runs.getRun(explicitRun.runId)), undefined);
}

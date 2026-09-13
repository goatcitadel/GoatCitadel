import {
  ConflictError,
  buildRemoteWorkerAssignmentParentContext,
  readDurableChatTurnExecutionPayloadAuthority,
  remoteWorkerAssignmentParentContextSha256,
  remoteWorkerInferenceCanonicalSha256,
  type DurableRunRecord,
  type TaskStatus,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { TaskRepository } from "./task-repo.js";

interface TaskBindingRow {
  durable_run_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  payload_sha256: string;
  task_id: string;
  parent_context_sha256: string;
}

type ChatRunIdentity = Pick<DurableRunRecord, "runId" | "workflowKey" | "payload">;

/** Internal assignment collaborator. A generated task is bound to the original
 * admitted payload, never inserted into or substituted for the caller request. */
export class RemoteWorkerChatTaskRepository {
  constructor(private readonly db: DatabaseClient) {}

  public findForRun(run: ChatRunIdentity) {
    const row = this.db.prepare("SELECT * FROM remote_worker_chat_tasks WHERE durable_run_id = ?")
      .get<TaskBindingRow>(run.runId);
    if (!row) return undefined;
    const payload = readDurableChatTurnExecutionPayloadAuthority({ workflowKey: run.workflowKey,
      durableRunId: run.runId, payload: run.payload });
    if (!payload || payload.request.policyTaskId !== undefined ||
      row.workspace_id !== payload.workspaceId || row.session_id !== payload.sessionId ||
      row.turn_id !== payload.turnId || row.payload_sha256 !== remoteWorkerInferenceCanonicalSha256(run.payload))
      throw conflict("Worker Chat task differs from its original admission.");
    const parentInput = { executionWorkspaceId: row.workspace_id, durableRunId: run.runId,
      taskId: row.task_id, sessionId: row.session_id, turnId: row.turn_id };
    const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
    if (row.parent_context_sha256 !== parentContextSha256)
      throw conflict("Worker Chat task parent binding changed.");
    return { taskId: row.task_id, parentContext: buildRemoteWorkerAssignmentParentContext(parentInput),
      parentContextSha256 };
  }

  /** Called inside the offer transaction, with the durable run and admission
   * roots locked. An offer failure rolls back both the task and this binding. */
  public createForOffer(run: DurableRunRecord) {
    const payload = readDurableChatTurnExecutionPayloadAuthority({ workflowKey: run.workflowKey,
      durableRunId: run.runId, payload: run.payload });
    if (!payload || payload.request.policyTaskId !== undefined || !run.leaseOwnerId)
      throw conflict("Worker Chat task requires its original unbound Chat admission.");
    new SessionMutationAdmissionRepository(this.db).assertActiveTurnWrite({
      admissionId: payload.admissionId, sessionIncarnationId: payload.sessionIncarnationId,
      workspaceId: payload.workspaceId, sessionId: payload.sessionId, turnId: payload.turnId,
      durableClaim: { durableRunId: run.runId, leaseOwnerId: run.leaseOwnerId, attemptCount: run.attemptCount },
      requireExactDurablePayloadIdentity: true,
    });
    const existing = this.findForRun(run);
    if (existing) return { ...existing, created: false };
    const task = new TaskRepository(this.db).create({ workspaceId: payload.workspaceId,
      title: "Chat worker execution", status: "in_progress", createdBy: payload.requestActor.actorId,
      proactiveContext: { sessionId: payload.sessionId, durableRunId: run.runId, originSurface: "chat" },
    });
    const parentContextSha256 = remoteWorkerAssignmentParentContextSha256({
      executionWorkspaceId: payload.workspaceId, durableRunId: run.runId, taskId: task.taskId,
      sessionId: payload.sessionId, turnId: payload.turnId,
    });
    this.db.prepare(`INSERT INTO remote_worker_chat_tasks
      (durable_run_id, workspace_id, session_id, turn_id, payload_sha256, task_id, parent_context_sha256, created_at)
      VALUES (@runId, @workspaceId, @sessionId, @turnId, @payloadSha256, @taskId, @parentSha256, @createdAt)`)
      .run({ runId: run.runId, workspaceId: payload.workspaceId, sessionId: payload.sessionId, turnId: payload.turnId,
        payloadSha256: remoteWorkerInferenceCanonicalSha256(run.payload), taskId: task.taskId,
        parentSha256: parentContextSha256, createdAt: task.createdAt });
    return { ...this.findForRun(run)!, created: true };
  }
}

/** The durable owner calls this in its transition transaction. Only generated
 * execution tasks follow Chat status; caller-selected task lifecycles stay with
 * their existing owners. Deleted tasks are never restored by background work. */
export function synchronizeRemoteWorkerChatTaskStatus(db: DatabaseClient, run: DurableRunRecord): void {
  const binding = new RemoteWorkerChatTaskRepository(db).findForRun(run);
  if (!binding) return;
  const tasks = new TaskRepository(db);
  const task = tasks.getForUpdate(binding.taskId);
  if (task.workspaceId !== run.payload?.workspaceId)
    throw conflict("Worker Chat task workspace changed.");
  if (task.deletedAt) return;
  const status: TaskStatus = run.status === "completed" ? "done" :
    ["waiting", "failed", "cancelled", "dead_lettered"].includes(run.status) ? "blocked" : "in_progress";
  if (task.status !== status) tasks.updateWithRevision(task.taskId, { status }, task.revision, run.updatedAt);
}

const conflict = (message: string) => new ConflictError({ message });

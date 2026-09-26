import {
  ConflictError,
  NotFoundError,
  type ChatDelegationRunRecord,
  type DurableRunRecord,
  type TaskRecord,
} from "@goatcitadel/contracts";

const DEFAULT_WORKSPACE_ID = "default";
const DELEGATION_RUN_SCAN_LIMIT = 500;

/** Canonical records that link a policy task or run id to a Chat session. */
export interface ChatPolicyScopeStorage {
  chatSessionMeta: { get(sessionId: string): Promise<{ workspaceId?: string } | undefined> };
  chatDelegationRuns: {
    get(runId: string): Promise<ChatDelegationRunRecord>;
    listBySession(sessionId: string, limit?: number): Promise<ChatDelegationRunRecord[]>;
  };
  durableRuns: { getRun(runId: string): Promise<DurableRunRecord> };
  tasks: { get(taskId: string): Promise<TaskRecord> };
}

export interface CallerPolicyScope {
  policyTaskId?: string;
  policyRunId?: string;
}

/**
 * Rejects a caller-supplied `policyTaskId` or `policyRunId` that does not
 * belong to the Chat session it is sent with. Tool policy matches task-scoped
 * grants on the task id and links approvals to the run id, so an unbound id
 * would let a caller borrow another task's grants or attach its approvals to
 * another run.
 *
 * A run id is accepted when it names a delegation run (a turn's orchestration
 * run is one) or a durable Chat run of this session. A task id is accepted
 * when it is the task of one of this session's delegation runs, or a task in
 * the session's workspace whose agentic context names this session. A missing
 * id and a foreign id are rejected with the same error.
 */
export async function assertCallerPolicyScopeBound(
  storage: ChatPolicyScopeStorage,
  sessionId: string,
  scope: CallerPolicyScope,
): Promise<void> {
  const runId = scope.policyRunId?.trim();
  const taskId = scope.policyTaskId?.trim();
  if (runId && !(await isRunBoundToSession(storage, sessionId, runId))) {
    throw new ConflictError({
      message: `policyRunId ${runId} does not belong to Chat session ${sessionId}.`,
      details: { sessionId, policyRunId: runId },
    });
  }
  if (taskId && !(await isTaskBoundToSession(storage, sessionId, taskId))) {
    throw new ConflictError({
      message: `policyTaskId ${taskId} does not belong to Chat session ${sessionId}.`,
      details: { sessionId, policyTaskId: taskId },
    });
  }
}

async function isRunBoundToSession(
  storage: ChatPolicyScopeStorage,
  sessionId: string,
  runId: string,
): Promise<boolean> {
  const delegation = await readIfFound(() => storage.chatDelegationRuns.get(runId));
  if (delegation) {
    return delegation.sessionId === sessionId;
  }
  const durable = await readIfFound(() => storage.durableRuns.getRun(runId));
  return durable?.payload?.sessionId === sessionId;
}

async function isTaskBoundToSession(
  storage: ChatPolicyScopeStorage,
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  const delegations = await storage.chatDelegationRuns.listBySession(sessionId, DELEGATION_RUN_SCAN_LIMIT);
  if (delegations.some((run) => run.taskId === taskId)) {
    return true;
  }
  const task = await readIfFound(() => storage.tasks.get(taskId));
  const context = task?.agenticContext;
  if (!task || (context?.parentSessionId !== sessionId && context?.childSessionId !== sessionId)) {
    return false;
  }
  const sessionWorkspaceId =
    (await storage.chatSessionMeta.get(sessionId))?.workspaceId?.trim() || DEFAULT_WORKSPACE_ID;
  return (task.workspaceId?.trim() || DEFAULT_WORKSPACE_ID) === sessionWorkspaceId;
}

async function readIfFound<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  }
}

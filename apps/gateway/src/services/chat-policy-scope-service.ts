import {
  ConflictError,
  NotFoundError,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatDelegationRunRecord,
  type DurableRunRecord,
  type TaskRecord,
} from "@goatcitadel/contracts";

const DEFAULT_WORKSPACE_ID = "default";

/** Canonical records that link a policy task or run id to a Chat session. */
export interface ChatPolicyScopeStorage {
  chatSessionMeta: { get(sessionId: string): Promise<{ workspaceId?: string } | undefined> };
  chatDelegationRuns: {
    get(runId: string): Promise<ChatDelegationRunRecord>;
    findLatestBySessionAndTask(sessionId: string, taskId: string): Promise<ChatDelegationRunRecord | undefined>;
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
 * run is one) of this session, or a durable Chat turn run whose verified
 * payload authority names this session and its workspace. A task id is
 * accepted when it is the task of one of this session's delegation runs, or a
 * task in the session's workspace whose agentic context names this session.
 * When both are sent they must name one delegation run and that run's own
 * task. A missing id and a foreign id are rejected with the same error.
 */
export async function assertCallerPolicyScopeBound(
  storage: ChatPolicyScopeStorage,
  sessionId: string,
  scope: CallerPolicyScope,
): Promise<void> {
  const runId = scope.policyRunId?.trim();
  const taskId = scope.policyTaskId?.trim();
  if (runId) {
    const run = await resolveSessionRun(storage, sessionId, runId);
    if (!run) {
      throw new ConflictError({
        message: `policyRunId ${runId} does not belong to Chat session ${sessionId}.`,
        details: { sessionId, policyRunId: runId },
      });
    }
    // The task selects grants and the run links approvals, so a pair must be
    // one delegation run and its own task; a durable Chat run has no task.
    if (taskId && run.delegation?.taskId !== taskId) {
      throw new ConflictError({
        message: `policyTaskId ${taskId} is not the task of policyRunId ${runId}.`,
        details: { sessionId, policyRunId: runId, policyTaskId: taskId },
      });
    }
    return;
  }
  if (taskId && !(await isTaskBoundToSession(storage, sessionId, taskId))) {
    throw new ConflictError({
      message: `policyTaskId ${taskId} does not belong to Chat session ${sessionId}.`,
      details: { sessionId, policyTaskId: taskId },
    });
  }
}

/** Resolves a run id to a delegation run or a durable Chat turn run of this session. */
async function resolveSessionRun(
  storage: ChatPolicyScopeStorage,
  sessionId: string,
  runId: string,
): Promise<{ delegation?: ChatDelegationRunRecord } | undefined> {
  const delegation = await readIfFound(() => storage.chatDelegationRuns.get(runId));
  if (delegation) {
    return delegation.sessionId === sessionId ? { delegation } : undefined;
  }
  const durable = await readIfFound(() => storage.durableRuns.getRun(runId));
  if (!durable) {
    return undefined;
  }
  // Durable run payloads can be written through the durable API; only a
  // verified chat.turn.execute payload is Chat turn authority.
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: durable.workflowKey,
    durableRunId: durable.runId,
    payload: durable.payload,
  });
  if (authority?.sessionId !== sessionId) {
    return undefined;
  }
  return authority.workspaceId.trim() === (await readSessionWorkspaceId(storage, sessionId)) ? {} : undefined;
}

async function isTaskBoundToSession(
  storage: ChatPolicyScopeStorage,
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  if (await storage.chatDelegationRuns.findLatestBySessionAndTask(sessionId, taskId)) {
    return true;
  }
  const task = await readIfFound(() => storage.tasks.get(taskId));
  const context = task?.agenticContext;
  if (!task || (context?.parentSessionId !== sessionId && context?.childSessionId !== sessionId)) {
    return false;
  }
  return (task.workspaceId?.trim() || DEFAULT_WORKSPACE_ID) === (await readSessionWorkspaceId(storage, sessionId));
}

async function readSessionWorkspaceId(storage: ChatPolicyScopeStorage, sessionId: string): Promise<string> {
  return (await storage.chatSessionMeta.get(sessionId))?.workspaceId?.trim() || DEFAULT_WORKSPACE_ID;
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

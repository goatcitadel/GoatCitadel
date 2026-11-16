import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";

/**
 * The durable run recorded on a task. Only a durable run id opens a run page: a Chat delegation's own `runId` is the
 * delegation's id, not a durable run, so it is never linked here.
 */
export function taskRunHref(task: TaskRecord): string | undefined {
  const runId = task.proactiveContext?.durableRunId ?? task.agenticContext?.durableRunId;
  return runId ? `/work/runs/${encodeURIComponent(runId)}` : undefined;
}

/** The conversation a runtime-owned task points at, when one was recorded. */
export function taskConversationId(task: TaskRecord): string | undefined {
  return (
    task.proactiveContext?.sessionId ?? task.agenticContext?.childSessionId ?? task.agenticContext?.parentSessionId
  );
}

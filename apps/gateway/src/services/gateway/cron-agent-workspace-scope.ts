import { PolicyViolationError, type CronJobRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { CronCitadelExecutionScope } from "./cron-citadel-scope.js";
/** Legacy specs retain their existing default-workspace behavior. An explicit
 * workspace is never a way to escape the job's citadel or a retired Chat. */
export async function resolveCronAgentWorkspaceScope(
  storage: Pick<AsyncStorage, "workspaces" | "chatSessionMeta" | "sessions">,
  job: Pick<CronJobRecord, "jobId" | "citadelId" | "actionConfig">,
  scope: CronCitadelExecutionScope,
): Promise<CronCitadelExecutionScope> {
  const config = job.actionConfig?.agentTurn;
  if (!config?.workspaceId) return scope;
  if (!scope.citadelId || scope.citadelId !== job.citadelId || !config.sessionId)
    throw new PolicyViolationError({
      message: "Explicit Chat schedules require a current session and an active citadel binding.",
    });
  const [workspace, meta, session] = await Promise.all([
    storage.workspaces.get(config.workspaceId),
    storage.chatSessionMeta.get(config.sessionId),
    storage.sessions.getBySessionId(config.sessionId),
  ]);
  if (
    workspace.workspaceId !== config.workspaceId ||
    workspace.lifecycleStatus !== "active" ||
    workspace.citadelId !== scope.citadelId ||
    meta?.workspaceId !== workspace.workspaceId ||
    meta.lifecycleStatus !== "active" ||
    meta.origin !== "operator" ||
    session.kind !== "dm"
  )
    throw new PolicyViolationError({
      message: "The scheduled Chat or workspace no longer belongs to this active citadel.",
    });
  return { ...scope, workspaceId: workspace.workspaceId };
}

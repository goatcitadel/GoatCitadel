import type { ToolInvokeRequest, ToolPolicyActorContext } from "@goatcitadel/contracts";

export interface ScheduleAgentToolExecutorHooks {
  scheduleManage?: (
    args: Record<string, unknown>,
    policyContext: ToolPolicyActorContext | undefined,
  ) => Promise<Record<string, unknown>>;
  subagentFanout?: (request: ToolInvokeRequest) => Promise<Record<string, unknown>>;
}

/**
 * Delegate `schedule.manage` back to the gateway runtime hook. The cron mutation
 * is impure (it touches the gateway's cron store + durable runtime), so this pure
 * package never performs it directly -- it only routes the call. Fails closed when
 * the hook is not wired so the tool can never silently no-op.
 */
export async function executeScheduleManage(
  request: ToolInvokeRequest,
  runtimeHooks: ScheduleAgentToolExecutorHooks,
): Promise<Record<string, unknown>> {
  if (!runtimeHooks.scheduleManage) {
    throw new Error("schedule.manage is not available in this runtime (no scheduleManage hook configured).");
  }
  return runtimeHooks.scheduleManage(request.args, request.policyContext);
}

/**
 * Delegate `agent.fanout` back to the gateway runtime hook (R3-8). Child-turn
 * spawning is impure (it creates chat sessions and runs delegated LLM turns),
 * so this pure package never performs it directly -- it only routes the call
 * after the engine has authorized execution. Fails closed when the hook is not
 * wired so the tool can never silently no-op.
 */
export async function executeSubagentFanout(
  request: ToolInvokeRequest,
  runtimeHooks: ScheduleAgentToolExecutorHooks,
): Promise<Record<string, unknown>> {
  if (!runtimeHooks.subagentFanout) {
    throw new Error("agent.fanout is not available in this runtime (no subagentFanout hook configured).");
  }
  return runtimeHooks.subagentFanout(request);
}

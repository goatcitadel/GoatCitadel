import {
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatToolRunRecord,
  type ChatTurnTraceRecord,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE } from "./chat-fanout-admission-reference.js";

/** Read current persisted completion evidence; never infer a waiting run from UI state. */
export async function readFanoutCompletionTrace(
  host: { storage: Pick<AsyncStorage, "chatTurnTraces" | "chatToolRuns"> },
  turnId: string,
): Promise<ChatTurnTraceRecord> {
  return {
    ...(await host.storage.chatTurnTraces.get(turnId)),
    toolRuns: await host.storage.chatToolRuns.listByTurn(turnId),
  };
}

/** Recovery evidence only: this does not grant dispatch or manufacture a claim. */
export async function hasDurableFanoutWaitingEvidence(
  storage: Pick<
    AsyncStorage,
    "chatFanoutInvocations" | "chatDelegationRuns" | "chatDelegationSteps" | "durableChildWatchers"
  >,
  run: DurableRunRecord,
  trace: ChatTurnTraceRecord,
  tools: ChatToolRunRecord[],
  options: { requireSettled?: boolean } = {},
): Promise<boolean> {
  if (trace.status !== "waiting_for_tool" || trace.durable?.runId !== run.runId) return false;
  const tool = [...tools]
    .reverse()
    .find(
      (item) =>
        item.toolName === "agent.fanout" &&
        item.status === "executed" &&
        item.turnId === trace.turnId &&
        item.sessionId === trace.sessionId &&
        item.result?.status === "waiting",
    );
  if (!tool || !storage.chatFanoutInvocations) return false;
  const invocation = await storage.chatFanoutInvocations.findByParentAndTool(run.runId, tool.toolRunId);
  if (
    !invocation ||
    invocation.invocationId !== tool.result?.fanoutInvocationId ||
    invocation.sessionId !== trace.sessionId ||
    tool.result?.parentRunId !== run.runId ||
    tool.result?.toolRunId !== tool.toolRunId ||
    !invocation.delegationRunId ||
    invocation.childCount < 1 ||
    invocation.childCount > 3
  )
    return false;
  if (options.requireSettled && !["completed", "partial", "failed", "cancelled", "blocked"].includes(invocation.status))
    return false;
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey,
    durableRunId: run.runId,
    payload: run.payload,
  });
  if (
    !authority ||
    authority.turnId !== trace.turnId ||
    authority.sessionId !== trace.sessionId ||
    authority.workspaceId !== invocation.workspaceId
  )
    return false;
  if (invocation.parentAdmission) {
    const binding = invocation.parentAdmission;
    if (
      authority.capabilityProfileId ||
      binding.admissionId !== authority.admissionId ||
      binding.sessionIncarnationId !== authority.sessionIncarnationId ||
      binding.materialSha256 !== authority.admissionMaterialSha256 ||
      binding.featureReferenceSha256 !== authority.featureReferenceSha256
    )
      return false;
  } else if (!authority.capabilityProfileId || authority.capabilityProfileHash !== invocation.capabilityProfileHash)
    return false;
  const delegation = await storage.chatDelegationRuns.get(invocation.delegationRunId);
  if (
    delegation.parentRunId !== run.runId ||
    delegation.sessionId !== trace.sessionId ||
    delegation.executionPlanId !== invocation.invocationId ||
    delegation.workflowTemplate !== CHAT_DURABLE_FANOUT_WORKFLOW_TEMPLATE
  )
    return false;
  const steps = await storage.chatDelegationSteps.listByRun(delegation.runId);
  if (steps.length !== invocation.childCount) return false;
  for (const step of steps) {
    if (options.requireSettled && !["completed", "failed", "cancelled", "skipped"].includes(step.status)) return false;
    if (!step.durableRunId) {
      if (!["failed", "cancelled", "skipped"].includes(step.status)) return false;
      continue;
    }
    const watcher = await storage.durableChildWatchers.get(`delegation-child:${step.stepId}`);
    // Watchers are observational cursors, not child settlement authority. The
    // exact delegation step carries settlement; the watcher proves its linkage.
    if (
      watcher.parentRunId !== run.runId ||
      watcher.childRunId !== step.durableRunId ||
      watcher.source !== "chat_delegation" ||
      watcher.metadata?.delegationRunId !== delegation.runId ||
      watcher.metadata.stepId !== step.stepId ||
      watcher.metadata.childSessionId !== step.childSessionId ||
      watcher.metadata.childTurnId !== step.childTurnId
    )
      return false;
  }
  return true;
}

import { buildApprovalEffectIdempotencyKey, type AsyncStorage } from "@goatcitadel/storage";
import {
  canonicalJsonString,
  type ApprovalEffectRecord,
  type ChatToolRunRecord,
  type PendingApprovalAction,
} from "@goatcitadel/contracts";

/** Validate the completed execution owner before linking the approval effect.
 * The caller must commit that effect and its Chat evidence in one transaction.
 * Result-body claims are never a substitute for the canonical owner event. */
export async function hasApprovedToolCompletionEvidence(
  storage: Pick<AsyncStorage, "approvalEvents" | "approvals" | "pendingApprovalActions">,
  input: {
    effect: ApprovalEffectRecord;
    pendingAction: PendingApprovalAction;
    toolRun: ChatToolRunRecord;
    inlineApproval: { approvalId: string; sessionId: string; turnId: string; toolName?: string };
    actionRecord: Record<string, unknown> | undefined;
  },
): Promise<boolean> {
  const { effect, pendingAction, toolRun, inlineApproval, actionRecord } = input;
  const request = pendingAction.request;
  if (
    effect.status !== "running" ||
    effect.effectKind !== "pending_action_execute" ||
    effect.targetKind !== "pending_action" ||
    effect.targetId !== effect.approvalId ||
    effect.idempotencyKey !== buildApprovalEffectIdempotencyKey(effect) ||
    pendingAction.approvalId !== effect.approvalId ||
    pendingAction.actionType !== "tool.invoke" ||
    toolRun.approvalId !== effect.approvalId ||
    inlineApproval.approvalId !== effect.approvalId ||
    !["approval_required", "executed"].includes(toolRun.status) ||
    Boolean(toolRun.error) ||
    (toolRun.status === "executed" &&
      (!toolRun.finishedAt ||
        canonicalJsonString(toolRun.result ?? null) !== canonicalJsonString(actionRecord?.result ?? null))) ||
    request.toolRunId !== toolRun.toolRunId ||
    request.toolName !== toolRun.toolName ||
    inlineApproval.toolName !== toolRun.toolName ||
    request.sessionId !== toolRun.sessionId ||
    inlineApproval.sessionId !== toolRun.sessionId ||
    request.turnId !== toolRun.turnId ||
    inlineApproval.turnId !== toolRun.turnId ||
    typeof request.workspaceId !== "string" ||
    !request.workspaceId ||
    typeof request.runId !== "string" ||
    !request.runId ||
    actionRecord?.outcome !== "executed" ||
    typeof actionRecord.auditEventId !== "string" ||
    !actionRecord.auditEventId
  )
    return false;

  const persisted = await storage.pendingApprovalActions.find(effect.approvalId);
  if (
    persisted?.approvalId !== effect.approvalId ||
    persisted.actionType !== "tool.invoke" ||
    persisted.resolutionStatus !== "executed" ||
    !persisted.resolvedAt ||
    ["toolRunId", "toolName", "workspaceId", "sessionId", "turnId", "runId"].some(
      (key) => persisted.request[key] !== request[key],
    ) ||
    canonicalJsonString(persisted.request.args ?? {}) !== canonicalJsonString(request.args ?? {}) ||
    persisted.result?.outcome !== "executed" ||
    persisted.result.auditEventId !== actionRecord.auditEventId ||
    persisted.result.policyReason !== actionRecord.policyReason ||
    canonicalJsonString(persisted.result.result ?? null) !== canonicalJsonString(actionRecord.result ?? null)
  )
    return false;

  const approval = await storage.approvals.get(effect.approvalId);
  if (
    approval.approvalId !== effect.approvalId ||
    approval.status !== "approved" ||
    approval.linkage?.workspaceId !== request.workspaceId ||
    approval.linkage.sessionId !== toolRun.sessionId ||
    approval.linkage.turnId !== toolRun.turnId ||
    approval.linkage.runId !== request.runId ||
    approval.linkage.toolName !== toolRun.toolName
  )
    return false;

  const events = (await storage.approvalEvents.listByApprovalId(effect.approvalId)).filter(
    (event) =>
      event.approvalId === effect.approvalId &&
      event.eventType === "approved_action_executed" &&
      event.actorId === "system",
  );
  const completed = events.filter((event) => event.payload.outcome === "executed");
  if (completed.length !== 1) return false;
  const event = completed[0]!;
  const boundary = event.payload.externalBoundaryState;
  return (
    event.payload.toolName === toolRun.toolName &&
    event.payload.auditEventId === actionRecord.auditEventId &&
    event.payload.sideEffectManaged === true &&
    ["not_required", "local_mutation", "crossed"].includes(String(boundary)) &&
    event.payload.externalRuntime === (boundary === "crossed") &&
    events.every(
      (candidate) =>
        candidate.payload.auditEventId !== actionRecord.auditEventId ||
        canonicalJsonString(candidate.payload) === canonicalJsonString(event.payload),
    )
  );
}

/** Only canonical owner events can prove that an approved call never dispatched. */
export async function hasApprovedToolPreDispatchEvidence(
  storage: Pick<AsyncStorage, "approvalEvents">,
  input: { approvalId: string; toolName: string; auditEventId: unknown },
): Promise<boolean> {
  if (typeof input.auditEventId !== "string" || !input.auditEventId) return false;
  try {
    const events = await storage.approvalEvents.listByApprovalId(input.approvalId);
    const matching = events.filter(
      (event) =>
        event.approvalId === input.approvalId &&
        event.eventType === "approved_action_executed" &&
        event.actorId === "system" &&
        event.payload.toolName === input.toolName &&
        event.payload.auditEventId === input.auditEventId,
    );
    return (
      matching.length > 0 &&
      matching.every(
        (event) =>
          event.payload.sideEffectManaged === true &&
          event.payload.toolDispatchStarted === false &&
          event.payload.outcome === "blocked" &&
          event.payload.externalRuntime === false &&
          event.payload.externalBoundaryState === "not_required",
      )
    );
  } catch {
    // Missing owner evidence is uncertainty, never proof of no side effect.
    return false;
  }
}

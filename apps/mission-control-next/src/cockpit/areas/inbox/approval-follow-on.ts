import {
  readDurableChatTurnExecutionPayloadAuthority,
  type ApprovalRequest,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import {
  fetchApprovalReplay,
  fetchRuntimeLifecycle,
  fetchDurableRun,
} from "@goatcitadel/mission-control-shared/api/client";

/** Read Gateway associations; never treat the approval.wait workflow as original execution. */
export async function readApprovalFollowOn(approval: ApprovalRequest, workspaceId: string, current: () => boolean) {
  const [replay, lifecycle] = await Promise.all([
    fetchApprovalReplay(approval.approvalId),
    fetchRuntimeLifecycle({ approvalId: approval.approvalId }),
  ]);
  const checkAccess = () => {
    if (!current()) throw new Error("Approval access changed. Reopen the current record.");
  };
  checkAccess();
  for (const record of [replay.approval, lifecycle.approval]) {
    if (!record || record.approvalId !== approval.approvalId || record.linkage?.workspaceId !== workspaceId)
      throw new Error("The follow-on record does not match this approval scope.");
  }
  if (lifecycle.canonical?.approvalId && lifecycle.canonical.approvalId !== approval.approvalId)
    throw new Error("Canonical lifecycle belongs to another approval.");
  const linkage = replay.approval.linkage;
  const readRun = async (id: string) => {
    checkAccess();
    const record = await fetchDurableRun(id);
    checkAccess();
    if (record.runId !== id || (record.payload.workspaceId && record.payload.workspaceId !== workspaceId))
      throw new Error("The returned work does not match the original run and workspace.");
    return record;
  };
  const waitId = replay.durableRunId ?? lifecycle.approvalWaitDurableRun?.runId;
  let wait: DurableRunRecord | undefined;
  if (waitId) {
    const record = await readRun(waitId);
    if (record.workflowKey === "approval.wait") {
      if (record.payload.approvalId !== approval.approvalId)
        throw new Error("Approval wait belongs to another request.");
      wait = record;
    }
  }
  // Exact turn association is stronger evidence of original Chat work when the
  // canonical approval linkage names its approval-wait bookkeeping workflow.
  const turn =
    linkage?.sessionId && linkage.turnId
      ? lifecycle.turns?.find((item) => item.sessionId === linkage.sessionId && item.turnId === linkage.turnId)
      : undefined;
  const canonicalId = lifecycle.canonical?.runId;
  const id =
    turn?.durableRunId ?? (lifecycle.resolution?.runIdSource === "approval_wait_run" ? undefined : canonicalId);
  let run: DurableRunRecord | undefined;
  if (id && id !== wait?.runId) {
    const record = await readRun(id);
    if (record.workflowKey === "approval.wait") {
      if (record.payload.approvalId !== approval.approvalId)
        throw new Error("Approval wait belongs to another request.");
      wait = record;
    } else {
      if (!record.workflowKey) throw new Error("Original workflow identity is unavailable.");
      if (record.workflowKey === "chat.turn.execute") {
        const payload = readDurableChatTurnExecutionPayloadAuthority({
          workflowKey: record.workflowKey,
          durableRunId: record.runId,
          payload: record.payload,
        });
        if (
          !payload ||
          payload.workspaceId !== workspaceId ||
          payload.sessionId !== linkage?.sessionId ||
          payload.turnId !== linkage?.turnId
        )
          throw new Error("Original Chat work does not match this approval's admitted turn.");
      } else if (record.payload.workspaceId !== workspaceId) {
        throw new Error("Original work workspace is not verified.");
      }
      run = record;
    }
  }
  return { replay, lifecycle, run, wait };
}

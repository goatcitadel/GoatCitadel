import type { ApprovalEffectRecord, ApprovalRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { isNativeExecutionApproval } from "./approval-native-runtime-parent.js";

/** Canonical Chat wake targeting, resumed-state CAS and retained proof reads.
 * The caller owns the enclosing effect transaction and durable wake. */
export interface ApprovalChatWakeStorage {
  chatInlineApprovals: Pick<AsyncStorage["chatInlineApprovals"], "get">;
  chatTurnTraces: Pick<AsyncStorage["chatTurnTraces"], "get" | "patchIfStatus">;
  pendingApprovalActions: Pick<AsyncStorage["pendingApprovalActions"], "find">;
}

export async function resolveLinkedTurnWakeTarget(
  storage: ApprovalChatWakeStorage,
  approval: ApprovalRequest,
): Promise<{ turnId: string; runId: string } | undefined> {
  const linkageTurnId =
    typeof approval.linkage?.turnId === "string" && approval.linkage.turnId.trim()
      ? approval.linkage.turnId.trim()
      : undefined;
  const inlineApproval = await storage.chatInlineApprovals.get(approval.approvalId);
  const inlineTurnId = inlineApproval?.turnId;
  const turnId = linkageTurnId ?? inlineTurnId;
  if (!turnId) {
    return undefined;
  }
  const linkageSessionId =
    typeof approval.linkage?.sessionId === "string" && approval.linkage.sessionId.trim()
      ? approval.linkage.sessionId.trim()
      : undefined;
  const expectedSessionId = linkageSessionId ?? inlineApproval?.sessionId;
  try {
    const trace = await storage.chatTurnTraces.get(turnId);
    if (expectedSessionId && trace.sessionId !== expectedSessionId) {
      return undefined;
    }
    const runId = trace.durable?.runId?.trim();
    if (!runId) {
      return undefined;
    }
    if (
      isNativeExecutionApproval(approval) &&
      (approval.linkage?.durableRunId !== runId || approval.linkage?.actionType !== approval.kind)
    ) {
      return undefined;
    }
    return { turnId, runId };
  } catch {
    return undefined;
  }
}

export async function markLinkedChatTurnResumed(
  storage: ApprovalChatWakeStorage,
  turnId: string,
  runId: string,
): Promise<void> {
  const observed = await storage.chatTurnTraces.get(turnId);
  if (observed.turnId !== turnId || observed.durable?.runId !== runId) {
    throw new Error(`Linked Chat wake ${runId} does not match turn ${turnId}.`);
  }
  if (observed.status === "running") {
    return;
  }
  if (observed.status !== "waiting_for_approval") {
    throw new Error(`Linked Chat wake ${runId} cannot resume turn ${turnId} from ${observed.status}.`);
  }
  const resumed = await storage.chatTurnTraces.patchIfStatus(turnId, ["waiting_for_approval"], {
    status: "running",
  });
  if (resumed) {
    return;
  }
  const canonical = await storage.chatTurnTraces.get(turnId);
  if (canonical.status !== "running" || canonical.durable?.runId !== runId) {
    throw new Error(`Linked Chat wake ${runId} lost the turn ${turnId} resume race.`);
  }
}

export async function buildAlreadyRunningWakeProof(
  storage: ApprovalChatWakeStorage,
  effect: ApprovalEffectRecord,
): Promise<Record<string, unknown> | undefined> {
  const pendingAction = await storage.pendingApprovalActions?.find(effect.approvalId);
  const executedOutcome = typeof pendingAction?.result?.outcome === "string" ? pendingAction.result.outcome : undefined;
  if (pendingAction?.resolutionStatus === "executed" || executedOutcome === "executed") {
    return {
      proofSource: "pending_approval_action",
      proofStatus: pendingAction?.resolutionStatus ?? executedOutcome ?? "executed",
      actionType: pendingAction?.actionType,
    };
  }

  try {
    const trace = (await storage.chatTurnTraces?.get(effect.targetId)) as
      | {
          assistantMessageId?: string;
          status?: string;
          durable?: { status?: string; checkpointKind?: string };
        }
      | undefined;
    if (
      trace?.assistantMessageId ||
      trace?.status === "completed" ||
      trace?.durable?.status === "completed" ||
      trace?.durable?.checkpointKind === "run_completed"
    ) {
      return {
        proofSource: "chat_turn_trace",
        proofStatus: trace?.durable?.status ?? trace?.status ?? "completed",
        checkpointKind: trace?.durable?.checkpointKind,
      };
    }
  } catch {
    // no proof available from chat traces
  }

  return undefined;
}

import {
  REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type ChatTurnCapabilityProfileRecord,
  type RemoteWorkerInferenceToolCall,
} from "@goatcitadel/contracts";
import type { AsyncStorage, RemoteWorkerInferenceRequestRecord } from "@goatcitadel/storage";
import { buildPersistedToolContinuationResult, serializeToolResultForModel } from "./chat-tool-result-projection.js";

export type RemoteWorkerChatToolResultStorage = Pick<AsyncStorage, "remoteWorkerEffects" | "chatToolRuns" | "approvals">;

/** Read only canonical settled results; model text and worker claims cannot
 * manufacture continuation evidence. Shared by tool replay and later inference. */
export async function readCanonicalWorkerModelToolResult(
  storage: RemoteWorkerChatToolResultStorage,
  record: RemoteWorkerInferenceRequestRecord,
  profile: ChatTurnCapabilityProfileRecord,
  call: RemoteWorkerInferenceToolCall,
) {
  const intents = await storage.remoteWorkerEffects.listIntents(
    record.registryWorkspaceId,
    record.assignmentId,
    record.assignmentGeneration,
  );
  const intent = intents.find((entry) => entry.workerIdempotencyKey === modelToolIntentKey(record, call));
  if (!intent) return undefined;
  const selected = profile.selection.tools.find((tool) => tool.modelName === call.modelToolName);
  if (
    !selected ||
    intent.effectSelector !== selected.canonicalName ||
    intent.canonicalArgsSha256 !== digest(JSON.parse(call.argumentsJson))
  )
    throw new Error("Worker model tool effect binding changed.");
  const settlement = await storage.remoteWorkerEffects.findSettlement(
    record.registryWorkspaceId,
    record.assignmentId,
    record.assignmentGeneration,
    intent.intentId,
  );
  const toolRunId = `remote-tool:${intent.intentId}`;
  const tool = await storage.chatToolRuns.get(toolRunId);
  if (
    intent.identity.executionWorkspaceId !== record.executionWorkspaceId ||
    tool.toolRunId !== toolRunId ||
    tool.sessionId !== record.sessionId ||
    tool.turnId !== record.turnId ||
    tool.toolName !== selected.canonicalName ||
    digest(tool.args) !== intent.canonicalArgsSha256
  )
    throw new Error("Worker tool result belongs to another call.");
  const identity = { toolRunId, intentId: intent.intentId };
  if (settlement?.receipt.receiptState === "blocked_before_dispatch" && tool.approvalId) {
    const approval = await storage.approvals.get(tool.approvalId);
    if (approval.status === "rejected" || approval.status === "edited") {
      const history = await storage.remoteWorkerEffects.readTransitionHistory(
        record.registryWorkspaceId, record.assignmentId, record.assignmentGeneration, intent.intentId,
      );
      const terminal = history.at(-1);
      if (!terminal || terminal.record.transitionState !== "blocked_before_dispatch" ||
        terminal.record.transitionSequence !== settlement.receipt.finalTransitionSequence ||
        terminal.record.transitionSha256 !== settlement.receipt.finalTransitionSha256 ||
        terminal.correlation.approvalRecordSha256 !== digest(approval) ||
        terminal.correlation.externalSideEffectRunId !== null || terminal.correlation.boundaryReceiptSha256 !== null ||
        tool.status !== "approval_required" || tool.effectOutcomeKind !== "none" ||
        approval.linkage?.workspaceId !== record.executionWorkspaceId || approval.linkage.sessionId !== record.sessionId ||
        approval.linkage.turnId !== record.turnId || approval.linkage.runId !== record.durableRunId ||
        approval.linkage.toolName !== tool.toolName)
        throw new Error("Worker declined tool result differs from its canonical decision receipt.");
      // A completed model-facing result records the refusal, not tool execution.
      // Unknown external outcomes and unrelated policy blocks remain parked.
      return completedResult(identity, { status: "blocked", error: "The tool approval did not authorize execution.",
        approvalDecision: approval.status === "edited" ? "edit" : "reject" });
    }
  }
  if (settlement && (tool.status !== "executed" ||
    !["completed_no_effect", "completed_with_effect"].includes(settlement.receipt.receiptState)))
    return { ...identity, status: "blocked" as const };
  if (!settlement && tool.status === "approval_required") {
    const history = await storage.remoteWorkerEffects.readTransitionHistory(
      record.registryWorkspaceId, record.assignmentId, record.assignmentGeneration, intent.intentId,
    );
    if (!tool.approvalId || history.at(-1)?.record.transitionState !== "approval_wait")
      throw new Error("Worker tool approval has no retained wait evidence.");
    return { ...identity, status: "waiting_approval" as const };
  }
  if (!settlement) return undefined;
  if (
    settlement.receipt.receiptState === "completed_with_effect" &&
    settlement.receipt.hx305OutcomeSha256 !== digest(tool)
  )
    throw new Error("Worker tool result changed after its completed effect receipt.");
  return completedResult(identity, buildPersistedToolContinuationResult(tool));
}

function completedResult(identity: { toolRunId: string; intentId: string }, value: Record<string, unknown>) {
  const resultJson = serializeToolResultForModel(value);
  if (Buffer.byteLength(resultJson, "utf8") > REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES)
    throw new Error("Worker tool result exceeds its continuation bound.");
  return { ...identity, status: "completed" as const, resultJson, resultSha256: digest(JSON.parse(resultJson)) };
}

export function modelToolIntentKey(
  record: RemoteWorkerInferenceRequestRecord,
  call: RemoteWorkerInferenceToolCall,
): string {
  return `chat-model-tool:${digest({
    registryWorkspaceId: record.registryWorkspaceId,
    assignmentId: record.assignmentId,
    assignmentGeneration: record.assignmentGeneration,
    requestSha256: record.requestSha256,
    call,
  })}`;
}

import {
  NotFoundError,
  remoteWorkerInferenceCanonicalSha256,
  type ChatStreamApprovalRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage, RemoteWorkerAssignmentAggregate } from "@goatcitadel/storage";

type ApprovalStorage = Pick<AsyncStorage,
  "remoteWorkerEffects" | "chatToolRuns" | "approvals" | "chatInlineApprovals" | "chatTurnTraces">;

/** Called inside the parent Chat write fence. The canonical stream/finalizer
 * owns the subsequent durable wait and checkpoint; this is not an executor. */
export async function retainRemoteWorkerChatApprovalWait(
  storage: ApprovalStorage,
  current: RemoteWorkerAssignmentAggregate,
  options: { resumedApprovalId?: string } = {},
): Promise<ChatStreamApprovalRecord | undefined> {
  // Approval may resolve between the tool result and the parent's first park.
  // The deferred resolution effect still needs that canonical wait to hand off.
  const waiting = await findRemoteWorkerChatApprovalWait(storage, current, { allowResolvedContinuation: true });
  if (!waiting) return undefined;
  if (waiting.summary.approvalId === options.resumedApprovalId) {
    if (waiting.approvalStatus === "pending") throw new Error("Worker resumed approval lost its canonical decision.");
    // The current dispatcher already bound this immutable wake. Keep it running
    // while the native worker rotates its lease and settles the exact request.
    return undefined;
  }
  const { summary, inline } = waiting;
  const manifest = current.assignment.manifest;
  if (!inline) await storage.chatInlineApprovals.upsert({
    ...summary, sessionId: manifest.sessionId!, turnId: manifest.turnId!, status: waiting.inlineStatus,
    ...(waiting.approvalStatus !== "pending" ? { details: { decision: waiting.approvalStatus === "rejected"
      ? "reject" : waiting.approvalStatus === "edited" ? "edit" : "approve" } } : {}),
  });
  const trace = await storage.chatTurnTraces.patchIfStatus(manifest.turnId!,
    ["running", "waiting_for_tool", "waiting_for_approval"], { status: "waiting_for_approval" });
  if (!trace) throw new Error("Worker approval lost its active Chat turn.");
  return summary;
}

/** Read the same exact retained intent, tool, approval and Chat linkage used by
 * the wait writer. No inline approval or trace is created or changed here. */
export async function findRemoteWorkerChatApprovalWait(
  storage: ApprovalStorage,
  current: Pick<RemoteWorkerAssignmentAggregate, "assignment" | "generation" | "settlement" | "control">,
  options: { allowResolvedContinuation?: boolean } = {},
) {
  const { assignment, generation } = current;
  if (!generation || current.settlement || current.control) return undefined;
  const manifest = assignment.manifest;
  const intents = await storage.remoteWorkerEffects.listIntents(
    assignment.registryWorkspaceId, assignment.assignmentId, generation.assignmentGeneration,
  );
  for (const intent of intents) {
    if (intent.identity.assignmentManifestSha256 !== assignment.manifestSha256 ||
      intent.identity.executionWorkspaceId !== manifest.executionWorkspaceId ||
      intent.identity.workerId !== generation.workerId || intent.identity.workerGeneration !== generation.workerGeneration)
      throw new Error("Worker approval intent belongs to another assignment.");
    const toolRunId = `remote-tool:${intent.intentId}`;
    let tool;
    try { tool = await storage.chatToolRuns.get(toolRunId); }
    catch (error) { if (error instanceof NotFoundError) continue; throw error; }
    if (tool.status !== "approval_required" || !tool.approvalId) continue;
    if (tool.toolRunId !== toolRunId || tool.sessionId !== manifest.sessionId || tool.turnId !== manifest.turnId ||
      tool.toolName !== intent.effectSelector || remoteWorkerInferenceCanonicalSha256(tool.args) !== intent.canonicalArgsSha256)
      throw new Error("Worker approval tool belongs to another invocation.");
    const history = await storage.remoteWorkerEffects.readTransitionHistory(
      assignment.registryWorkspaceId, assignment.assignmentId, generation.assignmentGeneration, intent.intentId,
    );
    if (history.at(-1)?.record.transitionState !== "approval_wait") continue;
    const approval = await storage.approvals.get(tool.approvalId);
    if (approval.linkage?.workspaceId !== manifest.executionWorkspaceId ||
      approval.linkage.sessionId !== manifest.sessionId || approval.linkage.turnId !== manifest.turnId ||
      approval.linkage.runId !== manifest.durableRunId || approval.linkage.toolName !== tool.toolName)
      throw new Error("Worker approval has no exact parent Chat linkage.");
    if (approval.status !== "pending" && !options.allowResolvedContinuation) continue;
    const trace = await storage.chatTurnTraces.get(manifest.turnId);
    if (trace.sessionId !== manifest.sessionId || trace.durable?.runId !== manifest.durableRunId)
      throw new Error("Worker approval has no canonical Chat trace.");
    const inline = await storage.chatInlineApprovals.get(approval.approvalId);
    // Match the approval lifecycle's display projection. An edited approval is
    // displayed as resolved/approved, but canonical status alone governs tools.
    const inlineStatus: "pending" | "denied" | "approved" = approval.status === "pending"
      ? "pending" : approval.status === "rejected" ? "denied" : "approved";
    if (inline && (inline.sessionId !== manifest.sessionId || inline.turnId !== manifest.turnId ||
      (inline.status !== "pending" && !(options.allowResolvedContinuation && inline.status === inlineStatus))))
      throw new Error("Worker approval projection changed its scope or resolution.");
    const summary: ChatStreamApprovalRecord = {
      approvalId: approval.approvalId, kind: approval.kind, toolName: tool.toolName,
      taskId: manifest.taskId, reason: approval.status === "pending" ? "Approval required by policy." : "Waiting for the worker to resume after the approval decision.", riskLevel: approval.riskLevel,
      expiresAt: approval.expiresAt,
    };
    return { summary, inline, inlineStatus, approvalStatus: approval.status };
  }
  return undefined;
}

import { readDurableChatTurnExecutionPayloadAuthority, type DurableRunRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { verifySettledChatWaitingAuthority } from "./chat-durable-waiting-authority.js";
import { GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY } from "./chat-durable-run-service.js";
import { findRemoteWorkerChatApprovalWait } from "./remote-worker-chat-approval-wait.js";

type ResumeStorage = Pick<AsyncStorage, "approvals" | "durableRuns" | "remoteWorkerAssignments">;

/** A declined action has no execution effect to hold its linked wake. Keep that
 * wake retryable until the parent commits its first wait and its finalizers.
 * This read neither grants execution nor replaces the canonical wake checks. */
export async function shouldDeferRemoteWorkerChatApprovalWake(
  storage: ResumeStorage & Pick<AsyncStorage,
    "remoteWorkerEffects" | "chatToolRuns" | "approvalWaitRuns" | "chatInlineApprovals" | "chatTurnTraces">,
  runId: string,
  approvalId: string,
): Promise<boolean> {
  const run = await storage.durableRuns.getRun(runId);
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey, durableRunId: run.runId, payload: run.payload,
  });
  if (!payload || (run.status !== "running" && run.status !== "waiting")) return false;
  const current = await storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
    executionWorkspaceId: payload.workspaceId, sessionId: payload.sessionId,
    turnId: payload.turnId, durableRunId: run.runId,
  });
  if (!current?.generation) return false;
  const waiting = await findRemoteWorkerChatApprovalWait(storage, current, { allowResolvedContinuation: true });
  if (!waiting) return false;
  if (waiting.summary.approvalId !== approvalId || waiting.approvalStatus === "pending")
    throw new Error("Worker approval wake does not match its resolved request.");
  const resume = await storage.remoteWorkerAssignments.findChatApprovalResume({
    registryWorkspaceId: current.assignment.registryWorkspaceId, assignmentId: current.assignment.assignmentId,
    assignmentGeneration: current.generation.assignmentGeneration,
  });
  // A lost response may leave the resolution effect pending after the exact
  // wake committed. Let the existing durable owner recover its wake proof.
  if (resume?.material.approvalId === approvalId) return false;
  if (run.status === "running" || run.metadata?.[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY] !== undefined) return true;
  await readResumeInput(storage, run, approvalId);
  return false;
}

async function readResumeInput(storage: ResumeStorage, run: DurableRunRecord, approvalId: string) {
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey, durableRunId: run.runId, payload: run.payload,
  });
  if (!payload) return undefined;
  const assignment = await storage.remoteWorkerAssignments.findTaskBoundChatAssignment({
    executionWorkspaceId: payload.workspaceId, sessionId: payload.sessionId,
    turnId: payload.turnId, durableRunId: run.runId,
  });
  if (!assignment) return undefined;
  if (run.status !== "waiting" || run.leaseOwnerId || run.leaseExpiresAt)
    throw new Error("Worker approval resume requires its parked durable Chat run.");
  const { authority, waitingCheckpoint } = await verifySettledChatWaitingAuthority(storage, run);
  if (authority.material.traceStatus !== "waiting_for_approval" ||
    authority.material.waitForEvent?.eventKey !== "approval.resolved" ||
    authority.material.waitForEvent.correlationId !== approvalId)
    throw new Error("Worker approval resume does not match its canonical wait.");
  return { registryWorkspaceId: assignment.assignment.registryWorkspaceId,
    assignmentId: assignment.assignment.assignmentId, approvalId, expectedParentVersion: run.version,
    waitingCheckpointId: waitingCheckpoint.checkpointId, waitingRuntimeAuthoritySha256: authority.materialSha256 };
}

/** Called under the approval effect's current claim. It only prepares the
 * skipped-local-action handoff; the linked durable wake remains its own effect. */
export async function prepareRemoteWorkerChatApprovalHandoff(storage: ResumeStorage, approvalId: string) {
  const approval = await storage.approvals.get(approvalId);
  const runId = approval.linkage?.runId;
  if (approval.status !== "approved" || !runId) throw new Error("Worker handoff requires a linked approved action.");
  const run = await storage.durableRuns.getRun(runId);
  const input = await readResumeInput(storage, run, approvalId);
  if (!input) throw new Error("Worker handoff has no canonical Chat assignment.");
  const material = await storage.remoteWorkerAssignments.prepareChatApprovalResumeHandoff(input);
  return { reason: "remote_worker_resume_handoff", registryWorkspaceId: material.registryWorkspaceId,
    assignmentId: material.assignmentId, assignmentGeneration: material.assignmentGeneration,
    intentId: material.intentId, pendingActionSha256: material.pendingActionSha256, approvalSha256: material.approvalSha256 };
}

/** The caller owns the same transaction as waiting -> queued. Failed admission,
 * seal/finalizer verification or the queue CAS rolls back the immutable wake. */
export async function recordRemoteWorkerChatApprovalWake(
  storage: ResumeStorage,
  run: DurableRunRecord,
  event: { eventKey: string; correlationId?: string },
) {
  const payload = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey, durableRunId: run.runId, payload: run.payload,
  });
  if (!payload) return;
  const input = await readResumeInput(storage, run, event.correlationId ?? "");
  if (!input) return;
  if (event.eventKey !== "approval.resolved" || !event.correlationId)
    throw new Error("Worker approval wake requires its exact approval resolution.");
  return await storage.remoteWorkerAssignments.recordChatApprovalResumeWake(input);
}

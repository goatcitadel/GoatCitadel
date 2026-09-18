import {
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type PendingApprovalAction,
  type RemoteWorkerAssignmentApprovalResumeRecord,
  type RemoteWorkerAssignmentApprovalWaitRecord,
  type ResolvedRemoteWorkerAssignmentAuthority,
} from "@goatcitadel/contracts";
import type {
  AsyncStorage,
  RemoteWorkerAssignmentProtectedCommitFence,
  ResolveRemoteWorkerAssignmentControlReadInput,
} from "@goatcitadel/storage";
import { findRemoteWorkerChatApprovalWait } from "./remote-worker-chat-approval-wait.js";
import { verifyCheckpointAnchoredChatTurnRuntimeAuthority } from "./chat-durable-runtime-authority.js";

export interface RemoteWorkerChatApprovalWaitReadPort {
  read(
    input: ResolveRemoteWorkerAssignmentControlReadInput,
    protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence,
  ): Promise<(ResolvedRemoteWorkerAssignmentAuthority & (
    { waiting: RemoteWorkerAssignmentApprovalWaitRecord } |
    { resume: RemoteWorkerAssignmentApprovalResumeRecord; phase: "waiting" | "renew" }
  )) | undefined>;
}

/** Keeps a native worker parked across restart. This owner cannot wake a run,
 * rotate a lease or dispatch effects, and returns no tool arguments or secrets. */
export class RemoteWorkerChatApprovalWaitReadService implements RemoteWorkerChatApprovalWaitReadPort {
  constructor(private readonly storage: AsyncStorage) {}

  async read(input: ResolveRemoteWorkerAssignmentControlReadInput,
    protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence) {
    return await this.storage.runImmediateTransaction(async () => {
      const continuation = await this.storage.remoteWorkerAssignments.resolveChatApprovalResumeByLeaseTokenHash(input, protectedAuthority);
      if (continuation) {
        const { resume, phase, pendingRecovery, ...records } = continuation;
        const material = resume.material;
        const checkpoint = await this.storage.durableRuns.getLatestCheckpointByKind(material.durableRunId, "run_waiting");
        if (!checkpoint || checkpoint.checkpointId !== material.waitingCheckpointId)
          throw new Error("Worker approval resume lost its waiting checkpoint.");
        const seal = verifyCheckpointAnchoredChatTurnRuntimeAuthority(
          { chatTurnRuntimeAuthority: checkpoint.state.chatTurnRuntimeAuthority }, checkpoint.state);
        const approval = await this.storage.approvals.get(material.approvalId);
        const pending = await this.storage.pendingApprovalActions.find(material.approvalId);
        if (seal.materialSha256 !== material.waitingRuntimeAuthoritySha256 ||
          (pendingRecovery && phase !== "waiting") ||
          seal.material.runId !== material.durableRunId || seal.material.turnId !== records.assignment.manifest.turnId ||
          seal.material.waitForEvent?.eventKey !== "approval.resolved" ||
          seal.material.waitForEvent.correlationId !== material.approvalId ||
          approval.status === "pending" || digest(approval) !== material.approvalSha256 ||
          (material.schemaVersion === "goatcitadel.remote-worker-native-runtime-resume.v1"
            ? approval.kind !== "remote_worker.native_runtime" || approval.status === "edited" ||
              (resume.recovery && (resume.recovery.material.schemaVersion !== "goatcitadel.remote-worker-native-runtime-resume-recovery.v1" ||
                resume.recovery.material.nativeRuntimeBindingSha256 !== material.nativeRuntimeBindingSha256)) ||
              digest(approval.payload.nativeRuntime) !== material.nativeRuntimeBindingSha256
            : !pending || (!pendingRecovery && (resume.recovery
            ? resume.recovery.material.schemaVersion !== "goatcitadel.remote-worker-chat-resume-recovery.v1" ||
              !matchesRecoveredAction(pending, approval.status, material.pendingActionSha256, resume.recovery.material.pendingActionSha256)
            : pending.resolutionStatus !== (approval.status === "approved" ? "pending" : "rejected") ||
              digest(pending) !== material.pendingActionSha256))))
          throw new Error("Worker approval resume differs from its retained handoff.");
        return { ...records, phase, resume: { approvalId: material.approvalId,
          runtimeAuthoritySha256: material.waitingRuntimeAuthoritySha256,
          resumeSha256: resume.recovery?.materialSha256 ?? resume.materialSha256 } };
      }
      const records = await this.storage.remoteWorkerAssignments.resolveWaitingChatAssignmentByLeaseTokenHash(
        input, protectedAuthority,
      );
      if (!records) return undefined;
      const manifest = records.assignment.manifest;
      const run = await this.storage.durableRuns.getRunForUpdate(manifest.durableRunId);
      const payload = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: run.workflowKey, durableRunId: run.runId, payload: run.payload,
      });
      if (run.status !== "waiting" || run.leaseOwnerId || run.leaseExpiresAt || !payload ||
        payload.workspaceId !== manifest.executionWorkspaceId || payload.sessionId !== manifest.sessionId ||
        payload.turnId !== manifest.turnId)
        throw new Error("Worker approval wait has no exact parked Chat parent.");
      const checkpoint = await this.storage.durableRuns.getLatestCheckpointByKind(run.runId, "run_waiting");
      if (!checkpoint) throw new Error("Worker approval wait has no retained checkpoint.");
      const seal = verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
      const waiting = await findRemoteWorkerChatApprovalWait(this.storage, records, { allowResolvedContinuation: true });
      const now = await this.storage.durableRuns.readDatabaseNow();
      const material = seal.material;
      const trace = await this.storage.chatTurnTraces.get(payload.turnId);
      if (!waiting || !waiting.inline ||
        (waiting.approvalStatus === "pending" && waiting.summary.expiresAt && Date.parse(waiting.summary.expiresAt) <= Date.parse(now)) ||
        trace.status !== "waiting_for_approval" ||
        trace.durable?.status !== "waiting" || material.runId !== run.runId || material.turnId !== payload.turnId ||
        material.transitionKind !== "waiting" || material.durableStatus !== "waiting" ||
        material.traceStatus !== "waiting_for_approval" ||
        material.waitForEvent?.eventKey !== "approval.resolved" ||
        material.waitForEvent.correlationId !== waiting.summary.approvalId ||
        canonicalJsonString(run.metadata?.waitForEvent) !== canonicalJsonString(material.waitForEvent) ||
        canonicalJsonString(checkpoint.state.waitForEvent) !== canonicalJsonString(material.waitForEvent))
        throw new Error("Worker approval wait differs from its canonical checkpoint or approval.");
      return { ...records, waiting: {
        approvalId: waiting.summary.approvalId, runtimeAuthoritySha256: seal.materialSha256,
      } };
    });
  }
}

function matchesRecoveredAction(pending: PendingApprovalAction, approvalStatus: string,
  originalActionSha256: string, recoveryActionSha256: string): boolean {
  if (approvalStatus !== "approved") return digest(pending) === recoveryActionSha256;
  if (!["pending", "executed", "failed"].includes(pending.resolutionStatus ?? "")) return false;
  // The old tool owner can finish after the recovery binding commits. Match
  // the approved request across that terminal transition; execution and result
  // projection still require the canonical effect owner's separate evidence.
  const original = { ...pending, resolutionStatus: "pending" as const };
  delete original.resolvedAt;
  delete original.result;
  return digest(original) === originalActionSha256;
}

import {
  canonicalJsonString,
  type ApprovalRequest,
  type ApprovalReplaySnapshot,
  type CodeModeRunRecord,
  type CodeModeRunArtifactPreview,
} from "@goatcitadel/contracts";
import { fetchApprovalReplay } from "@goatcitadel/mission-control-shared/api/approvals";
import { fetchCodeModeRun, fetchCodeModeRunArtifact } from "@goatcitadel/mission-control-shared/api/capabilities";
import { nativeRuntimeReviewForApproval } from "../../../features/native-routes/ops/NativeRuntimeApprovalReview";

export type SpecialistEvidence = {
  replay: ApprovalReplaySnapshot;
  code?: CodeModeRunRecord;
  source?: CodeModeRunArtifactPreview;
};
export function specialistEvidenceMatches(approval: ApprovalRequest, evidence: SpecialistEvidence): boolean {
  if (canonicalJsonString(evidence.replay.approval) !== canonicalJsonString(approval)) return false;
  if (approval.kind === "remote_worker.native_runtime")
    return Boolean(nativeRuntimeReviewForApproval(approval, evidence.replay));
  if (approval.kind !== "code_mode.run") return false;
  const code = evidence.code,
    source = evidence.source;
  return Boolean(
    code &&
    source &&
    code.status === "approval_pending" &&
    code.approvalId === approval.approvalId &&
    code.runId === approval.payload.runId &&
    code.workspaceId === approval.linkage?.workspaceId &&
    code.sessionId === approval.linkage?.sessionId &&
    code.turnId === approval.linkage?.turnId &&
    code.codeHash === approval.payload.codeHash &&
    code.wrapperManifestHash === approval.payload.wrapperManifestHash &&
    code.capabilitySnapshotId === approval.payload.capabilitySnapshotId &&
    code.codeModeInputHash === approval.payload.inputHash &&
    source.runId === code.runId &&
    source.sha256 === code.codeHash &&
    source.artifactKind === "source" &&
    !source.truncated,
  );
}
export async function readSpecialistEvidence(approval: ApprovalRequest): Promise<SpecialistEvidence> {
  const replay = await fetchApprovalReplay(approval.approvalId);
  if (approval.kind !== "code_mode.run") return { replay };
  if (typeof approval.payload.runId !== "string") throw new Error("The code run target is unavailable.");
  const scope = {
    workspaceId: approval.linkage?.workspaceId,
    sessionId: approval.linkage?.sessionId,
    turnId: approval.linkage?.turnId,
  };
  const [code, source] = await Promise.all([
    fetchCodeModeRun(approval.payload.runId, scope),
    fetchCodeModeRunArtifact(approval.payload.runId, "source", scope),
  ]);
  return { replay, code, source };
}

export function specialistEvidenceKey(evidence: SpecialistEvidence): string {
  return canonicalJsonString({
    ...evidence,
    // Reads append replay audit events and can deliver observability receipts. Neither
    // changes the reviewed action. Retain all execution/policy effects and other
    // events, pending action, durable mapping, and the full native runtime review.
    replay: {
      ...evidence.replay,
      events: evidence.replay.events.filter((event) => event.eventType !== "replayed"),
      effects: evidence.replay.effects.filter((effect) => effect.effectKind !== "approval_observability"),
    },
    source: evidence.source ? { ...evidence.source, verifiedAt: undefined } : undefined,
  });
}

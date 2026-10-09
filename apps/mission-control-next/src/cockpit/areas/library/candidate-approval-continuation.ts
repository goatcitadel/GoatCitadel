import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { canonicalJsonString, redactStructuredSecrets, type ApprovalReplaySnapshot, type CandidateSkillDetailRecord, type ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchApprovalReplay } from "@goatcitadel/mission-control-shared/api/approvals";
import { fetchChangePlan, respondToChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchCapabilityCandidate } from "@goatcitadel/mission-control-shared/api/capabilities";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function hash(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJsonString(value))))].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
/**
 * The public approval replay passes payloads through the shared secret redactor, which
 * masks token-derived actor IDs. Unredacted requesters compare exactly. A masked one
 * compares against the plan origin under that same projection and must also carry the
 * plan's origin workspace linkage; Gateway still binds plan and approval at resume.
 */
export function requesterMatchesPlanOrigin(plan: ChangePlanRecord, approval: { linkage?: { workspaceId?: string } }, publicRequester: unknown) {
  const origin = plan.origin.actorId;
  if (publicRequester === origin) return true;
  const projected = redactStructuredSecrets({ approval: { payload: { request: { requesterId: origin } } } }, { redactEnvAssignmentsAsWhole: true }).value.approval.payload.request.requesterId;
  return projected !== origin && publicRequester === projected && approval.linkage?.workspaceId === plan.origin.workspaceId;
}
function action(plan?: ChangePlanRecord) { return plan?.request.kind === "capability_candidate" && plan.status === "awaiting_approval" && plan.requiredAction?.kind === "approval" && plan.requiredAction.approvalId && plan.approvalRefs.includes(plan.requiredAction.approvalId) ? plan.requiredAction : undefined; }

/** Verify the lifecycle owner's global approval against the exact workspace-bound reviewed candidate. */
export async function requireCandidateApproval(plan: ChangePlanRecord, reviewed: CandidateSkillDetailRecord, current: CandidateSkillDetailRecord, replay: ApprovalReplaySnapshot) {
  const required = action(plan), approval = replay.approval;
  const request = plan.request;
  if (request.kind !== "capability_candidate" || !required || approval.approvalId !== required.approvalId || approval.kind !== "capability.lifecycle" || approval.status !== "approved" || !approval.resolvedBy || (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) || (plan.expiresAt && Date.parse(plan.expiresAt) <= Date.now())) throw new Error("The exact candidate approval is not currently approved and valid.");
  const workspaceId = plan.origin.workspaceId;
  if (reviewed.candidateId !== plan.target.resourceId || current.candidateId !== reviewed.candidateId || reviewed.revision !== plan.target.expectedRevision || (reviewed.originatingRun?.workspaceId && reviewed.originatingRun.workspaceId !== workspaceId) || (current.originatingRun?.workspaceId && current.originatingRun.workspaceId !== workspaceId) || !reviewed.relatedProposals.some(item => item.proposalId === request.proposalId && item.candidateId === reviewed.candidateId)) throw new Error("Candidate, proposal, workspace or reviewed revision does not match the plan.");
  const versionId = request.versionId ?? reviewed.latestVersion?.versionId;
  const version = reviewed.versions.find(item => item.versionId === versionId), nowVersion = current.versions.find(item => item.versionId === versionId);
  if (!version || !nowVersion || (version.workspaceId && version.workspaceId !== workspaceId) || (nowVersion.workspaceId && nowVersion.workspaceId !== workspaceId) || (version.wrapperManifestHash ?? version.manifestArtifact.sha256) !== plan.target.expectedHash || (nowVersion.wrapperManifestHash ?? nowVersion.manifestArtifact.sha256) !== plan.target.expectedHash) throw new Error("The immutable candidate version does not match the reviewed plan hash.");
  const kind = request.action ?? "activate";
  const expectedAction = kind === "activate" ? "candidate_promoted" : kind === "revoke" ? "candidate_revoked" : "candidate_rolled_back";
  const mutation = kind === "activate" ? { candidateId: reviewed.candidateId, versionId } : kind === "revoke" ? { candidateId: reviewed.candidateId, selectedVersionId: versionId, targetVersionIds: version.lifecycleState === "revoked" ? [] : [versionId] } : { candidateId: reviewed.candidateId, targetVersionId: versionId };
  const payload = record(approval.payload), binding = record(payload.capabilityLifecycle), envelope = record(payload.request);
  const requestSha256 = await hash({ schemaVersion: "goatcitadel.capability-lifecycle-request.v1", subjectKind: "capability_candidate", subjectId: reviewed.candidateId, action: expectedAction, mutation });
  const versions = [...reviewed.versions].sort((a, b) => a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0).map(item => ({ versionId: item.versionId, lifecycleState: item.lifecycleState, updatedAt: item.updatedAt }));
  const expectedStateSha256 = await hash({ schemaVersion: "goatcitadel.capability-lifecycle-state.v1", state: { candidateId: reviewed.candidateId, revision: reviewed.revision, versionCount: versions.length, versionsSha256: await hash(versions) } });
  const expectedBinding = { schemaVersion: "goatcitadel.capability-lifecycle-approval.v1", scopeKind: "global", subjectKind: "capability_candidate", subjectId: reviewed.candidateId, action: expectedAction, requestSha256, expectedStateSha256 };
  if (canonicalJsonString(binding) !== canonicalJsonString(expectedBinding) || envelope.schemaVersion !== "goatcitadel.capability-lifecycle-request-envelope.v1" || !requesterMatchesPlanOrigin(plan, approval, envelope.requesterId) || canonicalJsonString(envelope.mutation) !== canonicalJsonString(mutation)) throw new Error("Candidate approval request or reviewed state hash does not match this plan.");
  const digest = await hash({ schemaVersion: "goatcitadel.capability-lifecycle-approval-id.v1", subjectKind: "capability_candidate", subjectId: reviewed.candidateId, action: expectedAction, requestSha256, expectedStateSha256 });
  const expectedId = [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join("-");
  if (approval.approvalId !== expectedId) throw new Error("The lifecycle approval identity does not match its immutable hashes.");
}

const attempts = new Map<string, string>();
const listeners = new Set<() => void>();
function publish(key: string, message?: string) { if (message) attempts.set(key, message); else attempts.delete(key); for (const listener of listeners) listener(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useCandidateApprovalContinuation({ plan, reviewed, onSettled }: { plan?: ChangePlanRecord; reviewed: CandidateSkillDetailRecord; onSettled: () => Promise<unknown> }) {
  const access = useProjectAccess(JSON.stringify(["candidate-continuation", plan?.origin.workspaceId, plan?.planId]));
  const snapshot = plan ? canonicalJsonString(plan) : "", key = canonicalJsonString([access.presentationScope, plan?.planId]);
  const attempt = useSyncExternalStore(subscribe, () => attempts.get(key), () => undefined);
  const [notice, setNotice] = useState<string>();
  const lifecycle = useRef({ snapshot, mounted: true }); lifecycle.current.snapshot = snapshot;
  useEffect(() => { const current = lifecycle.current; current.mounted = true; return () => { current.mounted = false; }; }, []);
  async function continueApproved() {
    if (!plan || !action(plan) || attempts.has(key)) return;
    const isCurrent = () => access.current() && lifecycle.current.mounted && lifecycle.current.snapshot === snapshot;
    const context = { workspaceId: plan.origin.workspaceId };
    publish(key, "Checking the current candidate plan and lifecycle approval…"); setNotice(undefined);
    let dispatched = false;
    try {
      const fresh = await fetchChangePlan(plan.planId, context);
      if (!isCurrent()) return;
      if (canonicalJsonString(fresh) !== snapshot) throw new Error("The candidate plan changed. Refresh before continuing.");
      const required = action(fresh)!;
      const replay = await fetchApprovalReplay(required.approvalId!);
      const current = await fetchCapabilityCandidate(reviewed.candidateId);
      if (!isCurrent()) return;
      await requireCandidateApproval(fresh, reviewed, current, replay);
      const latest = await fetchChangePlan(plan.planId, context);
      if (!isCurrent()) return;
      if (canonicalJsonString(latest) !== snapshot) throw new Error("The candidate plan changed before continuation.");
      dispatched = true; publish(key, "Continuing the approved candidate plan…");
      const receipt = await respondToChangePlan(plan.planId, context, { expectedRevision: latest.revision, actionId: required.actionId, actionNonce: required.actionNonce, values: {} });
      if (receipt.planId !== plan.planId || receipt.origin.workspaceId !== context.workspaceId || receipt.intentHash !== plan.intentHash || receipt.target.resourceId !== reviewed.candidateId || receipt.revision <= plan.revision) throw new Error("Candidate continuation receipt does not confirm this action.");
      publish(key, "Continuation recorded. Inspect canonical plan settlement and candidate availability.");
      if (isCurrent()) await onSettled();
    } catch (cause) { const message = dispatched ? "Candidate continuation outcome is uncertain. This exact attempt is locked; refresh canonical state." : cause instanceof Error ? cause.message : "Candidate approval could not be checked."; if (dispatched) publish(key, message); if (isCurrent()) setNotice(message); }
    finally { if (!dispatched) publish(key); }
  }
  return { visible: Boolean(action(plan) || attempt), disabled: !action(plan) || Boolean(attempt), message: attempt ?? notice, continueApproved };
}
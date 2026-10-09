import { handleEvidenceScrollKeyDown } from "../../ui/evidence-scroll";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChangePlanRecord, CandidateSkillDetailRecord, CandidateSkillVersionRecord, CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { fetchCapabilityProposal, fetchCapabilityCandidate, fetchCandidateSkillArtifactReview, promoteCapabilityCandidate, revokeCapabilityCandidate, rollbackCapabilityCandidate } from "@goatcitadel/mission-control-shared/api/capabilities";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { LibraryCandidatePlan } from "./LibraryCandidatePlan";
import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { LibraryApproval } from "./LibraryApproval";

export function CapabilityLifecycleInspector({ item, workspaceId }: { item: CapabilityCatalogEntry; workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["candidate-inspector", workspaceId, item.capabilityId]));
  return <LifecycleInspector key={access.identity} item={item} workspaceId={workspaceId} />;
}
function LifecycleInspector({ item, workspaceId }: { item: CapabilityCatalogEntry; workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["candidate-inspector", workspaceId, item.capabilityId]));
  const proposal = useQuery({ queryKey: ["library", "proposal", item.proposalId, access.identity], queryFn: () => fetchCapabilityProposal(item.proposalId!), enabled: Boolean(item.proposalId), staleTime: 0 });
  const candidateId = item.candidateId ?? proposal.data?.proposal.candidateId;
  const candidate = useQuery({ queryKey: ["library", "candidate", candidateId, access.identity], queryFn: () => fetchCapabilityCandidate(candidateId!), enabled: Boolean(candidateId), staleTime: 0 });
  return <section className="grid gap-3" aria-label="Capability lifecycle">
    {proposal.isFetching || candidate.isFetching ? <p role="status">Reading governed capability evidence…</p> : null}
    {proposal.error || candidate.error ? <Callout tone="error">{describeApiError(proposal.error ?? candidate.error).summary} No lifecycle change is available without the canonical owner.</Callout> : null}
    {proposal.data ? <><h3 className="font-semibold">{proposal.data.proposal.title}</h3><p>{proposal.data.proposal.summary}</p><p>Proposal status: {proposal.data.proposal.status}. A proposal is not a callable capability.</p><ul>{proposal.data.events.map(event => <li key={event.eventId}>{event.eventType} · {new Date(event.createdAt).toLocaleString()}<TechnicalDetails label="Proposal event timestamp"><p>{event.createdAt}</p></TechnicalDetails></li>)}</ul></> : null}
    {candidate.data ? <CandidateVersions key={`${workspaceId}:${candidateId}`} detail={candidate.data} workspaceId={workspaceId} available={!candidate.isError && !candidate.isFetching && !proposal.isError} /> : !candidateId && !proposal.isFetching ? <Callout>No candidate version is linked to this catalog entry.</Callout> : null}
  </section>;
}
function CandidateVersions({ detail, workspaceId, available }: { detail: CandidateSkillDetailRecord; workspaceId: string; available: boolean }) {
  const client = useQueryClient();
  const operation = useLibraryOperation(JSON.stringify(["candidate-lifecycle", workspaceId, detail.candidateId]));
  const [versionId, setVersionId] = useState<string>();
  const [review, setReview] = useSessionViewState<{ action: "promote" | "revoke" | "rollback"; revision: number; version: CandidateSkillVersionRecord } | undefined>(operation.key + ":review", undefined);
  const [busy, setBusy] = useState(false), [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string; approvalId?: string; changePlan?: ChangePlanRecord; reviewedCandidate?: CandidateSkillDetailRecord } | undefined>(operation.key + ":receipt", undefined);

  const artifacts = useQuery({ queryKey: ["library", "candidate-artifacts", workspaceId, detail.candidateId, versionId, operation.identity], queryFn: () => fetchCandidateSkillArtifactReview(detail.candidateId, versionId!, workspaceId), enabled: Boolean(versionId), staleTime: 0 });
  async function refresh() { await client.invalidateQueries({ queryKey: ["library"] }); }
  async function submit() {
    if (!review || !available || operation.locked || busy || outcome || detail.revision !== review.revision) return;
    setBusy(true);
    try {
      const receipt = await operation.run(String(review.revision), async () => {
      const fresh = await fetchCapabilityCandidate(detail.candidateId);
      if (fresh.revision !== review.revision || !fresh.versions.some(version => version.versionId === review.version.versionId)) throw new Error("Candidate changed during review. Inspect the current version before deciding.");
      return fresh;
      }, async fresh => {
      const result = review.action === "promote" ? await promoteCapabilityCandidate(detail.candidateId, review.revision, review.version.versionId) : review.action === "revoke" ? await revokeCapabilityCandidate(detail.candidateId, review.revision, review.version.versionId) : await rollbackCapabilityCandidate(detail.candidateId, review.version.versionId, review.revision);
      if (result.pendingApproval && result.pendingApproval.candidateId !== detail.candidateId) throw new Error("Approval receipt does not match this candidate.");
      return { result, fresh };
      });
      if (!receipt || !operation.current()) return;
      const { result, fresh } = receipt;
      setOutcome({ error: false, text: result.pendingApproval ? "Lifecycle approval requested. Callability has not changed; wait for approval and effect settlement." : result.noMutationRequired ? "The canonical owner reports no change was required." : "A governed change plan was returned. Inspect canonical candidate state; execution and callability are not confirmed by plan creation.", approvalId: result.pendingApproval?.approvalId, reviewedCandidate: fresh, changePlan: "changePlan" in result ? result.changePlan : undefined });
      await refresh();
    } catch (cause) { if (operation.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} The request is not confirmed. Refresh and inspect Inbox before retrying.` }); }
    finally { if (operation.current()) setBusy(false); }
  }
  return <>
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <p className="text-sm text-fg-secondary">{detail.activeVersion ? `Active version: ${detail.activeVersion.title}` : "No active version. Inactive candidates are not callable."}</p>
    {detail.activationBlockers.map((blocker, index) => <Callout key={index} tone="warning">{blocker}</Callout>)}
    <ul className="grid gap-2">{detail.versions.map(version => <li key={version.versionId} className="grid gap-2 rounded-md border border-line p-3"><h4 className="font-semibold">{version.title}</h4><p>{version.summary}</p><p className="text-sm text-fg-secondary">{version.lifecycleState} · {version.sourceKind.replaceAll("_", " ")} · {version.lineageStatus ?? "Lineage unavailable"} · {new Date(version.createdAt).toLocaleString()}</p><TechnicalDetails label="Immutable version identifiers"><p>Version: {version.versionId}</p><p>Created: {version.createdAt}</p><p>Updated: {version.updatedAt}</p><p>Source: {version.sourceFingerprint ?? "Unavailable"}</p><p>Instruction artifact: {version.instructionArtifact.artifactId}</p></TechnicalDetails><Button disabled={!available || busy} onClick={() => setVersionId(version.versionId)}>Inspect version artifacts</Button><div className="flex flex-wrap gap-2">{(["promote", "revoke", "rollback"] as const).map(action => <Button key={action} disabled={!available || busy || operation.locked || (version.workspaceId !== undefined && version.workspaceId !== workspaceId) || ((action === "promote" || action === "rollback") && version.lifecycleState === "revoked")} onClick={() => { setOutcome(undefined); setReview({ action, revision: detail.revision, version }); }}>Review {action}</Button>)}</div></li>)}</ul>
    {artifacts.isFetching ? <p role="status">Reading immutable artifacts…</p> : null}{artifacts.error ? <Callout tone="error">{describeApiError(artifacts.error).summary}</Callout> : null}
    {artifacts.data ? <section aria-label="Immutable version artifacts"><p>Read-only artifact inspection does not activate this version.</p>{artifacts.data.artifacts.map(artifact => <details key={artifact.artifactRef} className="rounded-md border border-line p-2"><summary>{artifact.label}</summary><pre role="region" aria-label={artifact.label + " artifact content"} tabIndex={0} onKeyDown={handleEvidenceScrollKeyDown} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{artifact.content}</pre></details>)}</section> : null}
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review capability lifecycle" description="Version inspection and governed activation are separate actions."><div className="grid gap-3"><p>{review?.action}: {review?.version.title}</p><p>Workspace {review?.version.workspaceId ?? "Installation scope"}</p><Callout tone="warning">Activation remains subject to policy, approvals, provenance, health and grants. A pending request is never callable.</Callout>{outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : review && review.revision !== detail.revision ? <Callout tone="warning">The candidate changed during review. Close and inspect its current version.</Callout> : null}{outcome?.changePlan && outcome.reviewedCandidate ? <LibraryCandidatePlan key={outcome.changePlan.planId} seed={outcome.changePlan} reviewedCandidate={outcome.reviewedCandidate} candidateId={detail.candidateId} onRefresh={refresh} /> : null}{outcome?.approvalId ? <LibraryApproval approvalId={outcome.approvalId} workspaceId={workspaceId} onRefresh={refresh} /> : null}<Button disabled={busy || operation.locked || Boolean(outcome) || !available || review?.revision !== detail.revision} onClick={() => void submit()}>Request capability change</Button></div></Dialog>
  </>;
}

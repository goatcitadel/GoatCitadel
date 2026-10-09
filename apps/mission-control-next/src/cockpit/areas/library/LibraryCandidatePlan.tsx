import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canonicalJsonString, type CandidateSkillDetailRecord, type ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchChangePlan, confirmChangePlan, respondToChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { useCandidateApprovalContinuation } from "./candidate-approval-continuation";
import { LibraryApproval } from "./LibraryApproval";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useLibraryOperation } from "./use-library-operation";

/** The returned aggregate remains the authority through review, approval and settlement. */
export function LibraryCandidatePlan({ seed, candidateId, reviewedCandidate, onRefresh }: { seed: ChangePlanRecord; candidateId: string; reviewedCandidate: CandidateSkillDetailRecord; onRefresh: () => Promise<unknown> }) {
  const operation = useLibraryOperation(JSON.stringify(["candidate-plan", seed.origin.workspaceId, candidateId, seed.planId]));
  return <CandidatePlan key={operation.identity} seed={seed} candidateId={candidateId} reviewedCandidate={reviewedCandidate} onRefresh={onRefresh} />;
}
function CandidatePlan({ seed, candidateId, reviewedCandidate, onRefresh }: { seed: ChangePlanRecord; candidateId: string; reviewedCandidate: CandidateSkillDetailRecord; onRefresh: () => Promise<unknown> }) {
  const operation = useLibraryOperation(JSON.stringify(["candidate-plan", seed.origin.workspaceId, candidateId, seed.planId]));
  const context = { workspaceId: seed.origin.workspaceId, ...(seed.origin.sessionId ? { sessionId: seed.origin.sessionId } : {}), ...(seed.origin.turnId ? { turnId: seed.origin.turnId } : {}) };
  function bound(plan: ChangePlanRecord) {
    if (plan.planId !== seed.planId || plan.origin.workspaceId !== context.workspaceId || plan.request.kind !== "capability_candidate" || plan.target.resourceId !== candidateId || plan.intentHash !== seed.intentHash) throw new Error("The returned change plan does not match this candidate and workspace.");
    return plan;
  }
  const query = useQuery({ queryKey: ["library", "candidate-plan", context.workspaceId, candidateId, seed.planId, operation.identity], queryFn: async () => bound(await fetchChangePlan(seed.planId, context)), staleTime: 0 });
  const plan = query.data;
  const [review, setReview] = useState<ChangePlanRecord | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState<string>(), [error, setError] = useState<string>();
  async function refresh() { await query.refetch(); await onRefresh(); }
  const continuation = useCandidateApprovalContinuation({ plan, reviewed: reviewedCandidate, onSettled: refresh });
  async function submit(snapshot: ChangePlanRecord, actionKind: "confirmation" | "artifact_review") {
    if (busy || operation.locked || !operation.current()) return;
    setBusy(true); setError(undefined);
    try {
      const receipt = await operation.run(String(snapshot.revision), async () => {
        const fresh = bound(await fetchChangePlan(seed.planId, context));
        if (canonicalJsonString(fresh) !== canonicalJsonString(snapshot) || fresh.requiredAction?.kind !== actionKind || (fresh.expiresAt && Date.parse(fresh.expiresAt) <= Date.now())) throw new Error("The required action changed or expired. Close this review and refresh the change plan.");
        return fresh;
      }, fresh => actionKind === "confirmation" ? confirmChangePlan(fresh.planId, context, { expectedRevision: fresh.revision, actionNonce: fresh.requiredAction!.actionNonce }) : respondToChangePlan(fresh.planId, context, { expectedRevision: fresh.revision, actionId: fresh.requiredAction!.actionId, actionNonce: fresh.requiredAction!.actionNonce, values: {} }), result => {
        bound(result);
        if (result.revision <= snapshot.revision) throw new Error("The change plan receipt did not advance the reviewed action.");
      });
      if (!receipt || !operation.current()) return;
      setMessage(`Change plan action recorded: ${receipt.status.replaceAll("_", " ")}. Inspect the canonical result before relying on callability.`); setReview(null);
      await refresh();
    } catch (cause) {
      if (operation.current()) setError(describeApiError(cause).summary);
    } finally { if (operation.current()) setBusy(false); }
  }
  const approvalId = plan?.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId : undefined;
  return <section className="grid gap-3 rounded-md border border-line p-3" aria-label="Candidate change plan">
    <h3 className="font-semibold">{plan?.title ?? seed.title}</h3><p>Workspace {context.workspaceId}</p>
    {query.isFetching ? <p role="status">Reading canonical change plan…</p> : null}{query.error ? <Callout tone="error">{describeApiError(query.error).summary}</Callout> : null}
    {plan ? <><p>{plan.summary}</p><p>Impact: {plan.impact}</p><p>Status: {plan.status.replaceAll("_", " ")}</p><p>Required action: {plan.requiredAction?.title ?? "No operator action recorded"}</p>{plan.result ? <Callout>{plan.result.summary}</Callout> : null}<TechnicalDetails label="Change plan identity"><p>Plan: {plan.planId} · Revision {plan.revision}</p><p>Candidate: {plan.target.resourceId} · Reviewed target revision {plan.target.expectedRevision}</p></TechnicalDetails></> : null}
    {message ? <Callout>{message}</Callout> : null}{error ? <Callout tone="error">{error}</Callout> : null}
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <Button disabled={busy || query.isFetching} onClick={() => void refresh()}>Refresh candidate change plan</Button>
    {plan?.requiredAction && ["confirmation", "artifact_review"].includes(plan.requiredAction.kind) ? <Button disabled={busy || query.isFetching || query.isError || operation.locked} onClick={() => { setError(undefined); setReview(plan); }}>Review required candidate action</Button> : null}
    {approvalId ? <LibraryApproval approvalId={approvalId} workspaceId={context.workspaceId} onRefresh={refresh} /> : null}
    {continuation.visible ? <><Button disabled={operation.locked || continuation.disabled || busy || query.isFetching || query.isError} onClick={() => void continuation.continueApproved()}>Continue approved candidate change</Button>{continuation.message ? <Callout>{continuation.message}</Callout> : null}</> : null}
    <ChatChangePlanActionDialog plan={review} pending={busy} error={error} onClose={() => setReview(null)} onConfirm={snapshot => submit(snapshot, "confirmation")} onReviewArtifacts={snapshot => submit(snapshot, "artifact_review")} onSubmitPublicForm={() => undefined} onSubmitSecureInput={() => undefined} onContinueOAuth={() => undefined} onOpenNativePathPicker={() => undefined} />
  </section>;
}

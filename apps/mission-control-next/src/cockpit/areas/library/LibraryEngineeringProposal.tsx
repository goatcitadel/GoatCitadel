import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canonicalJsonString, type CodeModeRunRecord, type EngineeringLearningProposalRequest } from "@goatcitadel/contracts";
import { fetchCodeModeRuns, fetchCodeModeRun, fetchCodeModeRunVerificationEvidence } from "@goatcitadel/mission-control-shared/api/capabilities";
import { submitEngineeringLearningProposal } from "@goatcitadel/mission-control-shared/api/engineering-learnings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useLibraryOperation } from "./use-library-operation";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
const TEXT_FIELDS = ["title", "problem", "rootCause", "resolution", "prevention"] as const;
export function LibraryEngineeringProposal({ workspaceId, onCreated }: { workspaceId: string; onCreated: (id: string) => void }) {
  const operation = useLibraryOperation(JSON.stringify(["engineering-proposal", workspaceId]));
  const draft = useSessionDraft(operation.presentationScope, { runId: "", title: "", problem: "", rootCause: "", resolution: "", prevention: "" }, undefined, { label: "Engineering learning proposal" });
  const runs = useQuery({ queryKey: ["library", "engineering-sources", operation.identity], queryFn: () => fetchCodeModeRuns({ workspaceId, status: "completed", limit: 100 }), staleTime: 0 });
  const [review, setReview] = useState<{ input: EngineeringLearningProposalRequest; source: CodeModeRunRecord }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function prepare() {
    if (busy || operation.locked || !operation.current()) return;
    setBusy(true); setError(undefined);
    try {
      const source = await fetchCodeModeRun(draft.value.runId, { workspaceId });
      const evidence = (await fetchCodeModeRunVerificationEvidence(source.runId, { workspaceId })).items.find(item => item.evidenceId === source.verification?.evidenceId);
      if (source.workspaceId !== workspaceId || source.status !== "completed" || source.verification?.status !== "verified" || !evidence || evidence.status !== "verified" || evidence.runId !== source.runId || evidence.subject.changedFilesTruncated || !evidence.subject.changedFiles.length) throw new Error("This source has no current complete verification evidence. Complete and verify the actual work in Chat first.");
      if (!operation.current()) return;
      const { runId: _runId, ...text } = draft.value;
      setReview({ source, input: { ...text, workspaceId, disposition: "completed", source: { runId: source.runId, sessionId: source.sessionId, turnId: source.turnId }, changedFiles: evidence.subject.changedFiles, verificationEvidence: ["code-mode-verification:" + evidence.evidenceId] } });
    } catch (cause) { if (operation.current()) setError(describeApiError(cause).summary); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!review || busy) return;
    setBusy(true); setError(undefined);
    try {
      const result = await operation.run(canonicalJsonString(review.input), async () => {
        const source = await fetchCodeModeRun(review.source.runId, { workspaceId });
        if (canonicalJsonString(source) !== canonicalJsonString(review.source)) throw new Error("The reviewed source changed. Review its current evidence again.");
      }, () => submitEngineeringLearningProposal(review.input), (record) => {
        if (record.workspaceId !== workspaceId || record.source.runId !== review.source.runId) throw new Error("The proposal receipt does not match the reviewed source.");
      });
      if (!result) return;
      draft.acceptSaved({ runId: review.source.runId, title: result.title, problem: result.problem, rootCause: result.rootCause, resolution: result.resolution, prevention: result.prevention }, undefined, { runId: review.source.runId, title: review.input.title, problem: review.input.problem, rootCause: review.input.rootCause, resolution: review.input.resolution, prevention: review.input.prevention }); setReview(undefined); onCreated(result.learningId);
    } catch (cause) { if (operation.current()) setError(describeApiError(cause).summary); }
    finally { setBusy(false); }
  }
  return <section className="grid gap-3" aria-label="Create Engineering learning"><h3 className="font-semibold">Create Engineering learning</h3><p>Choose an actual completed Code Mode source with current named verification evidence. The Gateway derives its files and provenance. Proposals remain inactive; a previously captured source returns its existing learning.</p>
    {runs.error ? <Callout tone="error">{describeApiError(runs.error).summary}</Callout> : null}
    <Field label="Completed Engineering source">{props => <select {...props} className="min-h-11 rounded-md border border-line bg-canvas p-2" value={draft.value.runId} onChange={event => draft.setValue(value => ({ ...value, runId: event.target.value }))}><option value="">Choose a completed source</option>{runs.data?.items.filter(run => run.workspaceId === workspaceId).map(run => <option key={run.runId} value={run.runId} disabled={run.verification?.status !== "verified"}>{run.requestedOutputIntent ?? "Completed code work"} · {run.verification?.status ?? "Unverified"}</option>)}</select>}</Field>
    {!runs.isPending && !runs.data?.items.some(run => run.workspaceId === workspaceId && run.verification?.status === "verified") ? <Callout>No current verified source is available. Complete the governed code work and its named verification in Chat; text or an arbitrary run identifier cannot substitute for this evidence.</Callout> : null}
    {TEXT_FIELDS.map(key => <Field key={key} label={key === "rootCause" ? "Root cause" : key[0]!.toUpperCase() + key.slice(1)}>{props => <textarea {...props} className="min-h-20 rounded-md border border-line bg-canvas p-2" value={draft.value[key]} onChange={event => draft.setValue(value => ({ ...value, [key]: event.target.value }))} />}</Field>)}
    {error ? <Callout tone="error">{error}</Callout> : null}{operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <Button disabled={busy || operation.locked || !draft.value.runId || TEXT_FIELDS.some(key => !draft.value[key].trim())} onClick={() => void prepare()}>Review learning proposal</Button>
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review learning proposal"><div className="grid gap-3"><p>Workspace {workspaceId}. This creates an inactive proposal from the verified source.</p>{TEXT_FIELDS.map(key => <p key={key}>{key === "rootCause" ? "Root cause" : key}: {review?.input[key]}</p>)}<p>Verified files: {review?.input.changedFiles.join(", ")}</p><TechnicalDetails label="Proposal source evidence"><p>Run: {review?.source.runId}</p><p>{review?.input.verificationEvidence.join(", ")}</p></TechnicalDetails><Button disabled={busy || operation.locked} onClick={() => void submit()}>Create inactive learning proposal</Button><Button variant="secondary" disabled={busy} onClick={() => setReview(undefined)}>Cancel</Button></div></Dialog>
  </section>;
}

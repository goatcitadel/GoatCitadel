import { LibraryEngineeringReceipt } from "./LibraryEngineeringReceipt";
import type { EngineeringRevision } from "./LibraryEngineeringRevision";
import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type EngineeringLearningRecord, type EngineeringLearningStatus } from "@goatcitadel/contracts";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { fetchEngineeringLearning, fetchEngineeringLearnings, requestEngineeringLearningAction } from "@goatcitadel/mission-control-shared/api/engineering-learnings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { LibraryApproval } from "./LibraryApproval";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
const Revision = lazy(() => import("./LibraryEngineeringRevision").then(module => ({ default: module.LibraryEngineeringRevision })));
const Proposal = lazy(() => import("./LibraryEngineeringProposal").then(module => ({ default: module.LibraryEngineeringProposal })));
const STATUSES: EngineeringLearningStatus[] = ["proposed", "active", "stale", "superseded", "rejected", "archived"];
export function LibraryEngineeringLearnings({ workspaceId }: { workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["engineering", workspaceId]));
  return <EngineeringLearnings key={access.identity} workspaceId={workspaceId} />;
}
function EngineeringLearnings({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["engineering", workspaceId]));
  const [createOpen, setCreateOpen] = useState(false);
  const route = useCockpitRoute(), client = useQueryClient();
  const settings = useQuery({ queryKey: ["library", "engineering-settings", workspaceId, operation.identity], queryFn: () => fetchSettings(), staleTime: 0 });
  const enabled = settings.data?.features.engineeringLearningsV1Enabled === true && !settings.isError;
  const [status, setStatus] = useState<EngineeringLearningStatus | "all">("all");
  const list = useQuery({ queryKey: ["library", "learnings", workspaceId, status, operation.identity], queryFn: () => fetchEngineeringLearnings({ workspaceId, limit: 200, ...(status !== "all" ? { status } : {}) }), enabled, staleTime: 0 });
  const learningId = new URLSearchParams(route.search).get("learningId");
  const selected = useQuery({ queryKey: ["library", "learning", workspaceId, learningId, operation.identity], queryFn: () => fetchEngineeringLearning(learningId!), enabled: enabled && Boolean(learningId), staleTime: 0 });
  const item = selected.data?.workspaceId === workspaceId ? selected.data : undefined;
  const [review, setReview] = useSessionViewState<{ item: EngineeringLearningRecord; action: "activate" | "reject" | "archive" | EngineeringRevision["action"]; updates?: EngineeringRevision["updates"]; targets?: EngineeringLearningRecord[] } | undefined>(operation.presentationScope + ":review", undefined), [busy, setBusy] = useState(false), [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string; approvalId?: string } | undefined>(operation.presentationScope + ":outcome", undefined);
  async function refresh() { await client.invalidateQueries({ queryKey: ["library", "engineering-receipt"] }); await client.invalidateQueries({ queryKey: ["library", "learning"] }); await client.invalidateQueries({ queryKey: ["library", "learnings"] }); }
  async function submit() {
    if (!review || !enabled || operation.locked || outcome || selected.isError || selected.isFetching || settings.isFetching) return;
    setBusy(true);
    try {
      const approval = await operation.run(review.item.provenanceHash, async () => {
      const current = await fetchEngineeringLearning(review.item.learningId);
      if (current.workspaceId !== workspaceId || canonicalJsonString(current) !== canonicalJsonString(review.item)) throw new Error("The learning changed during review. Refresh before requesting an action.");
      for (const target of review.targets ?? []) { const fresh = await fetchEngineeringLearning(target.learningId); if (fresh.workspaceId !== workspaceId || canonicalJsonString(fresh) !== canonicalJsonString(target)) throw new Error("A selected learning target changed. Review current targets."); }
      return current;
      }, current => requestEngineeringLearningAction(current.learningId, { action: review.action, ...(review.updates ? { updates: review.updates } : {}), ...(review.targets?.length ? { targetLearningIds: review.targets.map(target => target.learningId) } : {}) }), receipt => {
        if (!receipt.approvalId || receipt.kind !== "engineering_learning.lifecycle" || receipt.payload.learningId !== review.item.learningId || receipt.payload.action !== review.action || receipt.linkage?.workspaceId !== workspaceId) throw new Error("The Gateway did not return a bound approval receipt.");
      });
      if (!approval) return;
      setOutcome({ error: false, text: "Approval requested. The learning status has not been confirmed changed; review and verify its settled record.", approvalId: approval.approvalId });
    } catch (cause) { if (operation.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} The request is not confirmed. Check Inbox before retrying.` }); }
    finally { setBusy(false); }
  }
  if (settings.isPending) return <p role="status">Checking Engineering learnings availability…</p>;
  if (settings.isError) return <Callout tone="error">Engineering learnings availability is unknown. {describeApiError(settings.error).summary}</Callout>;
  if (!enabled) return <Callout>Engineering learnings is disabled in this runtime. Direct links and technical details do not enable this feature.</Callout>;
  return <section className="grid gap-3 rounded-lg border border-line p-3" aria-label="Engineering learnings"><h2 className="font-display text-lg">Engineering learnings</h2><Button onClick={() => setCreateOpen(true)}>Create learning from verified work</Button>{createOpen ? <Suspense fallback={<p role="status">Loading proposal editor…</p>}><Proposal workspaceId={workspaceId} onCreated={id => { void refresh(); route.navigate(`/library/knowledge?learningId=${encodeURIComponent(id)}&shell=cockpit`); }} /></Suspense> : null}{operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}<Field label="Learning status">{props => <select {...props} className="rounded-md border border-line bg-raised p-2" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">All statuses</option>{STATUSES.map(value => <option key={value} value={value}>{value}</option>)}</select>}</Field>
    {list.isFetching ? <p role="status">Reading Engineering learnings…</p> : null}{list.error ? <Callout tone="error">{describeApiError(list.error).summary}</Callout> : null}<Button onClick={() => void refresh()}>Refresh learnings</Button>
    <ul className="grid gap-2">{list.data?.items.filter(record => record.workspaceId === workspaceId).map(record => <li key={record.learningId} className="rounded-md border border-line p-3"><h3>{record.title}</h3><p>{record.status}</p><Button onClick={() => route.navigate(`/library/knowledge?learningId=${encodeURIComponent(record.learningId)}&shell=cockpit`)}>Open {record.title}</Button></li>)}</ul>
    {selected.isFetching ? <p role="status">Reading learning record…</p> : null}{selected.error ? <Callout tone="error">{describeApiError(selected.error).summary}</Callout> : null}{selected.data && !item ? <Callout tone="warning">The learning does not belong to this workspace.</Callout> : null}
    {item ? <article className="grid gap-2"><h3 className="font-semibold">{item.title}</h3><p>{item.status} · Workspace {workspaceId} · Updated {new Date(item.updatedAt).toLocaleString()}</p>{(["problem", "rootCause", "resolution", "prevention"] as const).map(key => <div key={key}><h4 className="font-medium">{key === "rootCause" ? "Root cause" : key[0]!.toUpperCase() + key.slice(1)}</h4><p className="whitespace-pre-wrap break-words">{item[key]}</p></div>)}<p>Applies to: {item.applicablePaths.join(", ") || "No paths recorded"}</p>{item.staleReasons?.map(reason => <Callout key={reason} tone="warning">{reason}</Callout>)}<ul>{item.verificationEvidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul><TechnicalDetails label="Learning provenance"><p>Created: {item.createdAt} · Updated: {item.updatedAt}</p><p>Source run: {item.source.runId}</p><p>Source message: {item.source.turnId ?? "Not recorded"}</p><p className="break-all">Provenance hash: {item.provenanceHash}</p></TechnicalDetails><NativeOwnerLink scope={[workspaceId, item.learningId, item.source.runId]} href={`/work/runs/${encodeURIComponent(item.source.runId)}?shell=cockpit`}>Open source run</NativeOwnerLink>{item.source.sessionId ? <NativeOwnerLink scope={workspaceId} href={`/chat?sessionId=${encodeURIComponent(item.source.sessionId)}&shell=cockpit`}>Open source conversation</NativeOwnerLink> : null}<div className="flex flex-wrap gap-2">{(["activate", "reject", "archive"] as const).filter(action => action !== "activate" || item.status === "proposed").map(action => <Button key={action} disabled={busy || operation.locked || selected.isFetching || selected.isError || settings.isFetching} onClick={() => { setOutcome(undefined); setReview({ item, action }); }}>Review {action} learning</Button>)}</div><Suspense fallback={<p role="status">Loading learning revision…</p>}><Revision item={item} candidates={list.data?.items ?? []} disabled={busy || operation.locked || selected.isFetching || selected.isError || settings.isFetching} onReview={revision => { setOutcome(undefined); setReview({ item, ...revision }); }} /></Suspense></article> : null}
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review Engineering learning" description="This creates a governed approval request, not an immediate status change."><div className="grid gap-3"><p>{review?.action}: {review?.item.title} · Workspace {workspaceId}</p>{review?.updates ? <dl>{Object.entries(review.updates).map(([key, value]) => <div key={key}><dt>{key}</dt><dd className="whitespace-pre-wrap break-words">{value}</dd></div>)}</dl> : null}{review?.targets?.length ? <p>Targets to supersede: {review.targets.map(target => target.title + " (" + target.status + ")").join(", ")}</p> : null}<Callout tone="warning">Activation makes this learning eligible for context under Gateway policy. Rejection or archive removes its eligibility as governed by the owner.</Callout>{outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}{outcome?.approvalId && review ? <LibraryEngineeringReceipt approvalId={outcome.approvalId} item={review.item} action={review.action} /> : null}{outcome?.approvalId ? <LibraryApproval approvalId={outcome.approvalId} workspaceId={workspaceId} onRefresh={refresh} /> : null}<Button disabled={busy || operation.locked || Boolean(outcome) || selected.isFetching || selected.isError || settings.isFetching} onClick={() => void submit()}>Request learning approval</Button></div></Dialog>
  </section>;
}

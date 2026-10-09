import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExternalSourceDetailResponse, ExternalSourceImportPlanResponse, ExternalSourceImportDetailResponse } from "@goatcitadel/contracts";
import { fetchExternalSources, fetchExternalSourceDetail, fetchExternalSourceCatalogPage, scanExternalSource, createExternalSourceImportPlan, applyExternalSourceImport, fetchExternalSourceImportDetail, isExternalSourceCapabilityAbsent } from "@goatcitadel/mission-control-shared/api/external-sources";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { externalSourceManagementHref } from "../../../features/native-routes/library/external-source-launch";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { LibrarySourceRegistration } from "./LibrarySourceRegistration";
import { LibraryImportProvenance } from "./LibraryImportProvenance";

export function LibraryExternalSources({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["external-sources", workspaceId]));
  return <ExternalSources key={operation.identity} workspaceId={workspaceId} />;
}
function ExternalSources({ workspaceId }: { workspaceId: string }) {
  const operation = useLibraryOperation(JSON.stringify(["external-sources", workspaceId]));
  const route = useCockpitRoute();
  const sourceId = new URLSearchParams(route.search).get("sourceId");
  const query = useQuery({ queryKey: ["library", "external-sources", workspaceId, operation.identity], queryFn: () => fetchExternalSources(workspaceId), staleTime: 0, retry: false });
  const detail = useQuery({ queryKey: ["library", "external-source", workspaceId, sourceId, operation.identity], queryFn: () => fetchExternalSourceDetail(workspaceId, sourceId!), enabled: Boolean(sourceId) && Boolean(query.data), staleTime: 0 });
  if (query.isError && isExternalSourceCapabilityAbsent(query.error)) return <Callout>External sources are unavailable in this runtime. Registration and imports remain disabled.</Callout>;
  return <section className="grid min-w-0 max-w-full grid-cols-1 gap-3 wrap-anywhere rounded-lg border border-line p-3" aria-label="External sources"><h2 className="font-display text-lg">External sources</h2><p className="text-sm text-fg-secondary">Governed source registration, sealed scans and content-free import provenance. Imports do not grant unrestricted source read access.</p>
    {query.isPending ? <p role="status">Reading external sources…</p> : null}{query.error ? <Callout tone="error">{describeApiError(query.error).summary} A specific authenticated operator and source access may be required.</Callout> : null}
    {query.data && !query.isError ? <LibrarySourceRegistration workspaceId={workspaceId} onRegistered={id => { void query.refetch(); route.navigate(`/library/knowledge?sourceId=${encodeURIComponent(id)}&shell=cockpit`); }} /> : null}
    <Button disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh external sources</Button>
    <ul className="grid min-w-0 grid-cols-1 gap-2">{query.data?.items.filter(item => item.workspaceId === workspaceId).map(item => <li key={item.sourceId} className="min-w-0 rounded-md border border-line p-3"><h3>{item.label}</h3><p>{item.kind.replaceAll("_", " ")} · {item.status} · {item.latestScan?.status ?? "No scan recorded"}</p><Button size="sm" className="min-w-0 max-w-full" onClick={() => route.navigate(`/library/knowledge?sourceId=${encodeURIComponent(item.sourceId)}&shell=cockpit`)}>Inspect {item.label}</Button></li>)}</ul>
    {detail.isFetching ? <p role="status">Reading registered source…</p> : null}{detail.error ? <Callout tone="error">{describeApiError(detail.error).summary}</Callout> : null}
    {detail.data && detail.data.source.workspaceId !== workspaceId ? <Callout tone="error">This source does not belong to the current workspace.</Callout> : null}
    {detail.data?.source.workspaceId === workspaceId ? <SourceOperations key={`${workspaceId}:${sourceId}`} detail={detail.data} workspaceId={workspaceId} available={!query.isError && !detail.isError && !detail.isFetching} /> : null}
    <ClassicOwnerLink href={externalSourceManagementHref(workspaceId, sourceId ?? undefined)} scope={workspaceId} label="Register a source or inspect path-bridge controls in classic view" />
  </section>;
}
type SourceReview = { action: "scan" | "plan" | "apply"; revision: number; scanId?: string; selected: string[]; plan?: ExternalSourceImportPlanResponse; source: ExternalSourceDetailResponse["source"]; itemLabels: Record<string, string> };
function SourceOperations({ detail, workspaceId, available }: { detail: ExternalSourceDetailResponse; workspaceId: string; available: boolean }) {
  const client = useQueryClient();
  const operation = useLibraryOperation(JSON.stringify(["external-source", workspaceId, detail.source.sourceId]));
  const source = detail.source, scan = detail.latestScan;
  const [cursor, setCursor] = useState<string>(), [selected, setSelected] = useState<string[]>([]);
  const [itemLabels, setItemLabels] = useSessionViewState<Record<string, string>>(operation.key + ":item-labels", {});
  const catalog = useQuery({ queryKey: ["library", "external-catalog", workspaceId, source.sourceId, scan?.scanId, cursor, operation.identity], queryFn: () => fetchExternalSourceCatalogPage(source.sourceId, { workspaceId, scanId: scan!.scanId, limit: 50, ...(cursor ? { cursor } : {}) }), enabled: scan?.status === "sealed", staleTime: 0 });
  const [plan, setPlan] = useSessionViewState<ExternalSourceImportPlanResponse | undefined>(operation.key + ":plan", undefined), [imported, setImported] = useSessionViewState<ExternalSourceImportDetailResponse | undefined>(operation.key + ":import", undefined);
  const [review, setReview] = useSessionViewState<SourceReview | undefined>(operation.key + ":review", undefined);
  // The owner request outlives its dialog. Catalog edits and reads cannot replace it.
  const [pendingApply, setPendingApply] = useSessionViewState<SourceReview | undefined>(operation.key + ":pending-apply", undefined);
  const [reviewOpen, setReviewOpen] = useSessionViewState(operation.key + ":review-open", false);
  const applyPlan = pendingApply?.plan ?? plan;
  const [busy, setBusy] = useState(false), [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string } | undefined>(operation.key + ":outcome", undefined), [lookup, setLookup] = useState("");
  async function submit(replay = false) {
    if (!review || (replay && (review !== pendingApply || operation.attempt?.phase !== "uncertain")) || busy || (!replay && (outcome || operation.locked)) || !available || !operation.current()) return;
    setBusy(true);
    try {
      const result = await operation.run(review.action === "apply" ? review.plan!.idempotencyKey : String(review.revision), async () => {
        const fresh = await fetchExternalSourceDetail(workspaceId, source.sourceId);
        if (fresh.source.workspaceId !== workspaceId || fresh.source.sourceId !== source.sourceId) throw new Error("Source does not belong to this workspace.");
        if (!replay && (fresh.source.revision !== review.revision || (review.action !== "scan" && fresh.latestScan?.scanId !== review.scanId))) throw new Error("The source or sealed scan changed during review. Refresh and plan again.");
      }, async () => {
        if (review.action === "scan") return { kind: "scan" as const, value: await scanExternalSource(source.sourceId, { workspaceId, expectedRevision: review.revision }) };
        if (review.action === "plan") return { kind: "plan" as const, value: await createExternalSourceImportPlan({ workspaceId, sourceId: source.sourceId, scanId: review.scanId!, selectedItemIds: review.selected, expectedRevision: review.revision }) };
        if (!replay) setPendingApply(review);
        return { kind: "apply" as const, value: await applyExternalSourceImport({ workspaceId, planId: review.plan!.plan.planId, expectedPlanSha256: review.plan!.plan.planSha256, idempotencyKey: review.plan!.idempotencyKey }) };
      }, receipt => {
        if (receipt.kind === "scan" && (receipt.value.workspaceId !== workspaceId || receipt.value.sourceId !== source.sourceId || receipt.value.configRevision !== review.revision)) throw new Error("Scan receipt does not match the reviewed source.");
        if (receipt.kind === "plan" && (receipt.value.plan.workspaceId !== workspaceId || receipt.value.plan.sourceId !== source.sourceId || receipt.value.plan.scanId !== review.scanId)) throw new Error("Plan receipt does not match the source and scan.");
        if (receipt.kind === "apply") {
          const expected = review.plan!;
          if (receipt.value.intent.workspaceId !== workspaceId || receipt.value.intent.sourceId !== source.sourceId || receipt.value.intent.planId !== expected.plan.planId || receipt.value.intent.idempotencyKey !== expected.idempotencyKey || receipt.value.plan.workspaceId !== workspaceId || receipt.value.plan.sourceId !== source.sourceId || receipt.value.plan.planId !== expected.plan.planId || receipt.value.plan.planSha256 !== expected.plan.planSha256 || receipt.value.intent.planSha256 !== expected.plan.planSha256) throw new Error("Import receipt does not match the reviewed plan.");
          setPendingApply(undefined);
          setPlan(undefined);
          setImported(receipt.value);
        }
      }, replay);
      if (!result || !operation.current()) return;
      let text: string;
      if (result.kind === "scan") {
        setSelected([]); setPlan(undefined); setCursor(undefined);
        text = result.value.status === "sealed" ? `Scan sealed: ${result.value.supportedItemCount} supported of ${result.value.itemCount} items.` : `Scan blocked: ${result.value.blockerCodes.join(", ")}.`;
      } else if (result.kind === "plan") {
        setPlan(result.value); setImported(undefined); text = result.value.plan.blockerCodes.length ? `Import plan blocked: ${result.value.plan.blockerCodes.join(", ")}.` : "Import plan sealed. No import has been applied. Close this review to inspect and review apply.";
      } else {
        setImported(result.value); setSelected([]); setPlan(undefined); text = `Import ${result.value.applyDisposition}; settlement: ${result.value.settlement?.disposition ?? "not yet recorded"}. ${result.value.items.length} item records returned.`;
      }
      setOutcome({ error: false, text });
      await client.invalidateQueries({ queryKey: ["library", "external-source"] }); await client.invalidateQueries({ queryKey: ["library", "external-sources"] });
    } catch (cause) { if (operation.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} The action is not confirmed. Inspect the canonical source/import before retrying.` }); }
    finally { if (operation.current()) setBusy(false); }
  }
  function start(action: "scan" | "plan" | "apply") {
    if (busy || !operation.current()) return;
    if (operation.locked) {
      if (action === "apply" && pendingApply) { setReview(pendingApply); setReviewOpen(true); }
      return;
    }
    setOutcome(undefined);
    setReview({ action, revision: source.revision, scanId: scan?.scanId, selected: action === "apply" ? [...(plan?.plan.selectedItemIds ?? [])] : [...selected], plan, source: { ...source }, itemLabels: { ...itemLabels } });
    setReviewOpen(true);
  }
  return <section className="grid min-w-0 max-w-full grid-cols-1 gap-3 wrap-anywhere"><h3 className="font-semibold">{source.label}</h3><p className="break-words text-sm">Registered root: {source.canonicalRootPath}</p><p className="text-sm text-fg-secondary">Workspace {workspaceId} · {source.status} · Adapter {source.adapterId}</p><TechnicalDetails label="Source provenance"><p>Source: {source.sourceId}</p><p>Configuration version: {source.revision}</p><p className="break-all">Root SHA-256: {source.rootIdentitySha256}</p><p className="break-all">Scan manifest: {scan?.manifestSha256 ?? "No sealed scan"}</p></TechnicalDetails>
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <Button disabled={!available || busy || operation.locked || source.status !== "active"} onClick={() => start("scan")}>Review source scan</Button>
    {catalog.error ? <Callout tone="error">{describeApiError(catalog.error).summary}</Callout> : null}
    <ul className="grid min-w-0 grid-cols-1 gap-2">{catalog.data?.items.map(item => <li key={item.itemId} className="min-w-0 rounded-md border border-line p-2"><label className="flex min-h-11 min-w-0 w-full items-center gap-2"><input className="shrink-0" type="checkbox" checked={selected.includes(item.itemId)} disabled={busy || item.disposition !== "supported" || catalog.isFetching} onChange={event => { setPlan(undefined); setItemLabels(value => ({ ...value, [item.itemId]: item.normalizedRelativePath })); setSelected(value => event.target.checked ? [...value, item.itemId] : value.filter(id => id !== item.itemId)); }} /> <span className="min-w-0 wrap-anywhere">{item.normalizedRelativePath}</span></label><p className="text-sm text-fg-secondary">{item.disposition} · {item.rawByteCount} bytes · {item.messageCount} messages</p><p>{item.reasonCodes.join(", ")}</p></li>)}</ul>
    <div className="flex flex-wrap gap-2"><Button disabled={!cursor || busy} onClick={() => { setCursor(undefined); }}>First source page</Button><Button disabled={!catalog.data?.nextCursor || busy || catalog.isFetching} onClick={() => { setCursor(catalog.data?.nextCursor); }}>Next source page</Button><Button disabled={!available || busy || operation.locked || !selected.length || catalog.isFetching || catalog.isError} onClick={() => start("plan")}>Review import plan</Button></div>
    {applyPlan ? <div className="grid min-w-0 grid-cols-1 gap-2"><p>{pendingApply ? "Original import request retained for exact recovery." : applyPlan.plan.blockerCodes.length ? `Blocked: ${applyPlan.plan.blockerCodes.join(", ")}` : "Sealed import plan ready for review."}</p><TechnicalDetails label="Sealed import plan"><p>Plan: {applyPlan.plan.planId}</p><p className="break-all">Plan SHA-256: {applyPlan.plan.planSha256}</p></TechnicalDetails><Button disabled={busy || !available || Boolean(applyPlan.plan.blockerCodes.length)} onClick={() => start("apply")}>Review import apply</Button></div> : null}
    {imported ? <LibraryImportProvenance detail={imported} workspaceId={workspaceId} /> : null}
    <Field label="Import record ID">{props => <input {...props} className="min-w-0 w-full max-w-full rounded-md border border-line bg-raised p-2" value={lookup} onChange={event => setLookup(event.target.value)} />}</Field><Button disabled={!lookup.trim() || busy} onClick={() => { void fetchExternalSourceImportDetail(workspaceId, lookup.trim()).then(result => { if (!operation.current()) return; if (result.intent.workspaceId !== workspaceId || result.plan.sourceId !== source.sourceId) throw new Error("Import does not belong to this source and workspace."); setImported(result); }).catch(cause => { if (operation.current()) setOutcome({ error: true, text: describeApiError(cause).summary }); }); }}>Look up import</Button>{outcome && !reviewOpen ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}
    <Dialog open={reviewOpen && Boolean(review)} onOpenChange={open => { if (!open && !busy) { setReviewOpen(false); setReview(undefined); } }} title="Review external source action" description="Gateway validates source identity, revisions, hashes and admission."><div className="grid min-w-0 grid-cols-1 gap-3 wrap-anywhere"><p>{review?.action}: {review?.source.label} · Workspace {workspaceId}</p><p className="break-words">Root: {review?.source.canonicalRootPath}</p><p>{review?.selected.length ?? 0} selected items. Planning does not import; applying copies exactly the sealed selection into immutable imported evidence.</p><ul>{review?.selected.map(id => <li key={id}>{review.itemLabels[id] ?? "Previously selected item"}<TechnicalDetails label="Selected import item"><p>{id}</p></TechnicalDetails></li>)}</ul>{review?.action === "apply" && review.plan ? <><p>{review.plan.plan.rawByteCount} source bytes · {review.plan.plan.normalizedByteCount} normalized bytes · {review.plan.plan.messageCount} messages. Sealed staging expires {new Date(review.plan.plan.stagingExpiresAt).toLocaleString()}.</p><TechnicalDetails label="Reviewed import plan provenance"><p>{review.plan.plan.planId} · {review.plan.plan.planSha256}</p><p>{review.plan.plan.stagingExpiresAt}</p></TechnicalDetails></> : null}{outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : null}{review?.action === "apply" && review.plan && operation.attempt?.phase === "uncertain" ? <Button disabled={busy || !available} onClick={() => void submit(true)}>Replay exact import request</Button> : null}<Button disabled={busy || operation.locked || Boolean(outcome) || !available} onClick={() => void submit()}>Confirm source action</Button></div></Dialog>
  </section>;
}

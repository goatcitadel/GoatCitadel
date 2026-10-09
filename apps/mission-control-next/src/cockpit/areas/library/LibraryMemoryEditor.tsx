import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryItemRecord } from "@goatcitadel/contracts";
import { fetchMemoryItemHistory, forgetMemoryItem, patchMemoryItem, type MemoryLifecyclePendingApproval } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { readLibraryMemoryItem, sameMemoryItem } from "./library-memory-owner";
import { LibraryApproval } from "./LibraryApproval";
import { LibraryMemoryReceipt } from "./LibraryMemoryReceipt";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { recordView } from "../../data/record-view";

export function LibraryMemoryEditor({ itemId, workspaceId }: { itemId: string; workspaceId: string }) {
  const access = useLibraryOperation(JSON.stringify(["memory-item", workspaceId, itemId]));
  const item = useQuery({ queryKey: ["library", "memory-item", workspaceId, itemId, access.identity], queryFn: () => readLibraryMemoryItem(itemId, workspaceId), staleTime: 0 });
  return <section className="grid gap-3 rounded-lg border border-line p-3" aria-label="Memory editor">
    {item.isPending ? <p role="status">Reading canonical memory item…</p> : null}
    {item.error ? <Callout tone="error">{describeApiError(item.error).summary} Changes are locked.</Callout> : null}
    {item.data ? <MemoryEditor key={access.identity} item={item.data} workspaceId={workspaceId} available={!item.isError && !item.isFetching} /> : !item.isPending && !item.isError ? <Callout tone="warning">Memory item not found in this workspace.</Callout> : null}
  </section>;
}

function MemoryEditor({ item, workspaceId, available }: { item: MemoryItemRecord; workspaceId: string; available: boolean }) {
  const operation = useLibraryOperation(JSON.stringify(["memory-item", workspaceId, item.itemId]));
  const client = useQueryClient();
  const draft = useSessionDraft(JSON.stringify(["cockpit-memory", operation.presentationScope]), { title: item.title, content: item.content, pinned: item.pinned, ttl: item.ttlOverrideSeconds == null ? "" : String(item.ttlOverrideSeconds) }, item.updatedAt, { label: item.title });
  const settings = useQuery({ queryKey: ["library", "memory-settings", workspaceId, operation.identity], queryFn: () => fetchSettings(), staleTime: 0 });
  const enabled = settings.data?.features.memoryLifecycleAdminV1Enabled === true && !settings.isError && !settings.isFetching;
  const settingsView = recordView(settings);
  const administrationMessage = settings.isError ? "Memory administration settings are unavailable." : settingsView.phase === "loading" || settingsView.phase === "checking" ? "Checking memory administration settings…" : "Memory administration is disabled.";
  const [historyOpen, setHistoryOpen] = useState(false), [busy, setBusy] = useState(false);
  const [review, setReview] = useSessionViewState<{ item: MemoryItemRecord; action: "save" | "forget"; draft: typeof draft.value } | undefined>(operation.presentationScope + ":review", undefined);
  const [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string; request?: MemoryLifecyclePendingApproval } | undefined>(operation.presentationScope + ":outcome", undefined);
  const history = useQuery({ queryKey: ["library", "memory-history", workspaceId, item.itemId, item.updatedAt], queryFn: () => fetchMemoryItemHistory(item.itemId, 100), enabled: historyOpen, staleTime: 0 });
  const stale = draft.baseRevision !== item.updatedAt;
  const reviewStale = Boolean(review && !sameMemoryItem(review.item, item));
  async function refresh() { await client.invalidateQueries({ queryKey: ["library"] }); }
  async function submit() {
    if (!review || !available || !enabled || operation.locked || outcome || reviewStale) return;
    setBusy(true);
    try {
      const result = await operation.run(review.item.updatedAt, async () => {
      const fresh = await readLibraryMemoryItem(item.itemId, workspaceId);
      if (!fresh || !sameMemoryItem(fresh, review.item)) throw new Error("Memory changed during review. Close this review and refresh the canonical item before trying again.");
      const ttl = review.draft.ttl.trim() ? Number(review.draft.ttl) : null;
      if (ttl !== null && (!Number.isInteger(ttl) || ttl < 1 || ttl > 31536000)) throw new Error("TTL must be empty for default or a whole number from 1 to 31536000 seconds.");
      const { ttl: _ttl, ...values } = review.draft;
      return { ...values, ...(ttl !== (review.item.ttlOverrideSeconds ?? null) ? { ttlOverrideSeconds: ttl } : {}) };
      }, values => review.action === "forget" ? forgetMemoryItem(item.itemId) : patchMemoryItem(item.itemId, values), result => {
      const approval = result.pendingApproval;
      if (approval && (approval.kind !== "memory.lifecycle" || approval.workspaceId !== workspaceId || approval.action !== (review.action === "forget" ? "items_forgotten" : "item_updated") || approval.subjectKind !== "memory_item" || approval.subjectId !== item.itemId || approval.itemIds.length !== 1 || approval.itemIds[0] !== item.itemId)) throw new Error("Approval receipt does not match the reviewed memory item. Check Inbox before retrying.");
      });
      if (!result) return;
      const approval = result.pendingApproval;
      setOutcome({ error: false, text: "The owner reports this item was already forgotten. No mutation was required.", request: approval ?? undefined });
    } catch (cause) { if (operation.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} Submission is not confirmed; check Inbox and refresh before retrying. Your draft is retained.` }); }
    finally { setBusy(false); }
  }
  function start(action: "save" | "forget") { if (operation.locked || !operation.current()) return; setOutcome(undefined); setReview({ action, item, draft: { ...draft.value } }); }
  const scope = item.workspaceId ?? (typeof item.metadata.workspaceId === "string" ? item.metadata.workspaceId : "Global memory shared across workspaces");
  return <>
    <h2 className="font-display text-lg text-fg">{item.title}</h2><p className="text-sm text-fg-secondary">{scope} · {item.namespace} · {item.status} · {item.lifecycleState}</p>
    {!enabled ? <Callout tone="warning">{administrationMessage} Changes remain locked.</Callout> : null}
    {stale ? <Callout tone="warning">The canonical memory changed. Your draft is retained; discard it to load current content before making another request.</Callout> : null}
    <Field label="Memory title">{props => <input {...props} className="w-full rounded-md border border-line bg-raised p-2" value={draft.value.title} onChange={event => draft.setValue({ ...draft.value, title: event.target.value })} />}</Field>
    <Field label="Memory content">{props => <textarea {...props} className="w-full rounded-md border border-line bg-raised p-2" rows={6} value={draft.value.content} onChange={event => draft.setValue({ ...draft.value, content: event.target.value })} />}</Field>
    <Field label="Memory TTL override (seconds)">{props => <input {...props} type="number" min={1} max={31536000} placeholder="Use default" className="rounded-md border border-line bg-raised p-2" value={draft.value.ttl} onChange={event => draft.setValue({ ...draft.value, ttl: event.target.value })} />}</Field>
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <label className="text-sm"><input type="checkbox" checked={draft.value.pinned} onChange={event => draft.setValue({ ...draft.value, pinned: event.target.checked })} /> Pinned memory</label>
    <div className="flex flex-wrap gap-2"><Button disabled={!enabled || !available || stale || busy || item.status !== "active" || !draft.value.title.trim()} onClick={() => start("save")}>Review memory changes</Button><Button disabled={!enabled || !available || busy || item.status !== "active"} onClick={() => start("forget")}>Review forget</Button><Button disabled={busy} variant="ghost" onClick={draft.discard}>Discard memory changes</Button><Button onClick={() => void refresh()}>Refresh memory record</Button><Button onClick={() => setHistoryOpen(value => !value)}>Memory history</Button></div>
    <details className="break-words text-sm text-fg-secondary"><summary>Memory provenance</summary><p>Created {new Date(item.createdAt).toLocaleString()} · Updated {new Date(item.updatedAt).toLocaleString()}</p><p>Expires: {item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "No expiry recorded"}</p><p>Namespace: {item.namespace}</p><TechnicalDetails label="Memory source identifiers"><p>Created: {item.createdAt} · Updated: {item.updatedAt} · Expires: {item.expiresAt ?? "none"}</p>{Object.entries(item.metadata).filter(([key, value]) => /^(source|sourceRef|sourceKind|sourceSessionId|sourceTurnId|actorId|origin)$/u.test(key) && typeof value === "string").map(([key, value]) => <p key={key}>{key}: {String(value)}</p>)}</TechnicalDetails></details>
    {historyOpen ? <section aria-label="Memory history">{history.isFetching ? <p role="status">Reading memory history…</p> : null}{history.error ? <Callout tone="error">{describeApiError(history.error).summary}</Callout> : null}<ul className="grid gap-2">{history.data?.items.filter(event => event.itemId === item.itemId).map(event => <li key={event.changeId} className="rounded-md border border-line p-2"><h3>{event.changeType.replaceAll("_", " ")}</h3><p className="text-sm text-fg-secondary">{event.actorId ?? "Actor not recorded"} · {new Date(event.createdAt).toLocaleString()}</p><TechnicalDetails label="Technical event details"><p>{event.createdAt}</p><pre className="whitespace-pre-wrap break-words">{JSON.stringify(event.payload, null, 2)}</pre></TechnicalDetails></li>)}</ul></section> : null}
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title={review?.action === "forget" ? "Forget memory" : "Request memory changes"} description="This requests a governed approval; submission is not a completed memory write.">
      <div className="grid gap-3"><p className="break-words">Target: {review?.item.title} · {scope}</p><Callout tone="warning">{review?.action === "forget" ? "Forgetting removes the item from active recall after approval and effect settlement." : "The reviewed title, content and pinned state are applied only after approval and effect settlement."}</Callout>
        {review?.action === "save" ? <section aria-label="Proposed memory changes" className="grid gap-2"><p className="whitespace-pre-wrap break-words">Requested title: {review.draft.title}</p><p>Requested content:</p><pre className="whitespace-pre-wrap break-words">{review.draft.content}</pre><p>Requested pinned state: {review.draft.pinned ? "pinned" : "unpinned"}</p><p>Requested TTL: {review.draft.ttl || "Default"} {review.draft.ttl ? "seconds" : ""}</p></section> : null}
        {outcome?.request ? <LibraryMemoryReceipt request={outcome.request} itemId={item.itemId} workspaceId={workspaceId} /> : outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : reviewStale ? <Callout tone="warning">The memory item changed during review. Close and inspect current content.</Callout> : null}
        {outcome?.request ? <LibraryApproval approvalId={outcome.request.approvalId} workspaceId={workspaceId} onRefresh={refresh} /> : null}
        <Button disabled={busy || Boolean(outcome) || reviewStale || !available || !enabled} onClick={() => void submit()}>{busy ? "Requesting approval…" : "Request memory approval"}</Button>
      </div>
    </Dialog>
  </>;
}

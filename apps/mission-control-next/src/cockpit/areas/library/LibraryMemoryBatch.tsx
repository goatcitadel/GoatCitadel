import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MEMORY_BATCH_MAX_OPERATIONS, type MemoryItemRecord, type MemoryBatchMutationOperation } from "@goatcitadel/contracts";
import { batchMutateMemoryItems, type MemoryLifecyclePendingApproval } from "@goatcitadel/mission-control-shared/api/memory";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useLibraryOperation } from "./use-library-operation";
import { readLibraryMemoryItem, sameMemoryItem } from "./library-memory-owner";
import { LibraryApproval } from "./LibraryApproval";
import { LibraryMemoryReceipt } from "./LibraryMemoryReceipt";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Callout } from "../../ui/Callout";
export function LibraryMemoryBatch({ workspaceId, items, available, onClear, onRefresh }: { workspaceId: string; items: MemoryItemRecord[]; available: boolean; onClear: () => void; onRefresh: () => Promise<unknown> }) {
 const client = useQueryClient();
 const operation = useLibraryOperation(JSON.stringify(["memory-batch", workspaceId]));
 const [review, setReview] = useSessionViewState<{ items: MemoryItemRecord[]; action: "pin" | "unpin" | "forget" } | undefined>(operation.presentationScope + ":review", undefined);
 const [receipt, setReceipt] = useSessionViewState<MemoryLifecyclePendingApproval | undefined>(operation.presentationScope + ":receipt", undefined);
 const [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
 async function submit() {
  if (!review || !available || busy || receipt || operation.locked) return;
  setBusy(true); setError(undefined);
  try {
   const result = await operation.run(review.action, async () => {
    const settings = await fetchSettings(); if (!settings.features.memoryLifecycleAdminV1Enabled) throw new Error("Memory administration is disabled.");
    for (const item of review.items) { const fresh = await readLibraryMemoryItem(item.itemId, workspaceId); if (!fresh || !sameMemoryItem(item, fresh) || fresh.workspaceId !== workspaceId) throw new Error("A reviewed memory item changed or is not owned by this workspace."); }
   }, () => batchMutateMemoryItems({ source: "mission-control:library", operations: review.items.map((item): MemoryBatchMutationOperation => review.action === "forget" ? { kind: "forget_item", itemId: item.itemId } : { kind: "patch_item", itemId: item.itemId, patch: { pinned: review.action === "pin" } }) }), result => {
    const bound = result.pendingApproval;
    if (bound.workspaceId !== workspaceId || bound.action !== "batch_mutated" || bound.subjectKind !== "memory_item_batch" || bound.itemIds.length !== review.items.length || review.items.some(item => !bound.itemIds.includes(item.itemId))) throw new Error("Batch approval receipt does not match the exact reviewed items.");
   });
   if (result) { setReceipt(result.pendingApproval); onClear(); }
  } catch (cause) { if (operation.current()) setError(describeApiError(cause).summary); }
  finally { setBusy(false); }
 }
 return <section aria-label="Selected memory actions" className="grid gap-2"><p>{items.length} visible memory items selected. One approval governs an atomic batch; global items cannot enter a workspace batch.</p><div className="flex flex-wrap gap-2">{(["pin", "unpin", "forget"] as const).map(action => <Button key={action} disabled={!available || busy || operation.locked || !items.length || items.length > MEMORY_BATCH_MAX_OPERATIONS || items.some(item => item.workspaceId !== workspaceId || item.status !== "active")} onClick={() => { setReceipt(undefined); setError(undefined); setReview({ items: [...items], action }); }}>Review {action} selected memory</Button>)}<Button variant="secondary" onClick={onClear}>Clear memory selection</Button></div>{operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}{error ? <Callout tone="error">{error}</Callout> : null}
 <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title="Review selected memory changes"><div className="grid gap-3"><p>{review?.action} · Workspace {workspaceId}. No item changes until the governed approval effect completes.</p><ul>{review?.items.map(item => <li key={item.itemId}>{item.title} · {item.namespace} · {item.pinned ? "Pinned" : "Unpinned"}</li>)}</ul>{receipt ? <><LibraryApproval approvalId={receipt.approvalId} workspaceId={workspaceId} onRefresh={async () => { await onRefresh(); await client.invalidateQueries({ queryKey: ["library", "memory-receipt"] }); }} />{review?.items.map(item => <LibraryMemoryReceipt key={item.itemId} request={receipt} workspaceId={workspaceId} itemId={item.itemId} batchAction={review.action} />)}</> : null}<Button disabled={busy || !available || operation.locked || Boolean(receipt)} onClick={() => void submit()}>Request batch memory approval</Button><Button variant="secondary" disabled={busy} onClick={() => setReview(undefined)}>Cancel</Button></div></Dialog></section>;
}

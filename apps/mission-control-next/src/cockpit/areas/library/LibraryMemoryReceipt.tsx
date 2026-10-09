import { useLibraryOperation } from "./use-library-operation";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useQuery } from "@tanstack/react-query";
import { fetchApprovalReplay } from "@goatcitadel/mission-control-shared/api/approvals";
import { fetchMemoryItemHistory, type MemoryLifecyclePendingApproval } from "@goatcitadel/mission-control-shared/api/memory";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { readLibraryMemoryItem } from "./library-memory-owner";
import { Callout } from "../../ui/Callout";
import { recordView } from "../../data/record-view";
import type { MemoryBatchMutationOperation } from "@goatcitadel/contracts";

function sameItemIds(actual: unknown, expected: readonly string[]) {
  return Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === expected.length && expected.every(id => actual.includes(id));
}

/** Read-only receipt: admission identity, canonical effect, bound history, then current item. */
export function LibraryMemoryReceipt({ request, itemId, workspaceId, batchAction }: { request: MemoryLifecyclePendingApproval; itemId: string; workspaceId: string; batchAction?: "pin" | "unpin" | "forget" }) {
  const access = useLibraryOperation(JSON.stringify(["memory-receipt", workspaceId, itemId]));
  const receipt = useQuery({
    queryKey: ["library", "memory-receipt", workspaceId, itemId, request, batchAction, access.identity],
    queryFn: async () => {
      const replay = await fetchApprovalReplay(request.approvalId);
      const approval = replay.approval;
      const binding = approval.payload.memoryLifecycle as Record<string, unknown> | undefined;
      if (approval.approvalId !== request.approvalId || approval.kind !== "memory.lifecycle" || approval.linkage?.workspaceId !== workspaceId || !binding ||
        ["workspaceId", "action", "subjectKind", "subjectId", "requestSha256", "expectedStateSha256"].some(key => binding[key] !== request[key as keyof MemoryLifecyclePendingApproval])) {
        throw new Error("The canonical approval does not match this memory request.");
      }
      const operations = (approval.payload.request as { mutation?: { operations?: MemoryBatchMutationOperation[] } } | undefined)?.mutation?.operations;
      const operationIndex = Array.isArray(operations) ? operations.findIndex(value => value.itemId === itemId) : -1;
      const operation = operations?.[operationIndex];
      if (batchAction && (request.action !== "batch_mutated" || request.subjectKind !== "memory_item_batch" ||
        !sameItemIds(operations?.map(value => value.itemId), request.itemIds) || !request.itemIds.includes(itemId) ||
        (batchAction === "forget" ? operation?.kind !== "forget_item" : operation?.kind !== "patch_item" ||
          Object.keys(operation.patch).length !== 1 || operation.patch.pinned !== (batchAction === "pin")))) {
        throw new Error("The canonical batch operation does not match this reviewed memory action.");
      }
      const [item, history] = await Promise.all([readLibraryMemoryItem(itemId, workspaceId), fetchMemoryItemHistory(itemId, 100)]);
      const effect = replay.effects.find(value => value.approvalId === request.approvalId && value.effectKind === "memory_lifecycle_apply" &&
        (!batchAction || (value.targetKind === "memory_record" && value.targetId === request.approvalId &&
          ["workspaceId", "action", "subjectKind", "requestSha256"].every(key => value.payload[key] === binding[key]))));
      const effectResultMatches = !batchAction || (effect?.result?.workspaceId === workspaceId && effect.result.action === request.action &&
        effect.result.subjectKind === request.subjectKind && sameItemIds(effect.result.itemIds, request.itemIds));
      const change = history.items.find(value => value.itemId === itemId && value.payload.approvalId === request.approvalId &&
        value.payload.requestSha256 === request.requestSha256 && value.payload.expectedStateSha256 === request.expectedStateSha256 &&
        value.changeType === (request.action === "items_forgotten" || batchAction === "forget" ? "forgotten" : batchAction ? "pin_changed" : "updated") &&
        value.payload.operationKind === (batchAction ? "approved_batch" : request.action === "items_forgotten" ? "approved_forget" : "approved_patch") &&
        (!batchAction || (value.payload.batchOperationIndex === operationIndex && value.payload.batchOperationKind === operation?.kind)));
      return { approval, effect, effectResultMatches, change, item };
    },
    retry: false,
  });
  const view = recordView(receipt);
  const data = view.record;
  let message = "Checking canonical memory request, effect and item readback…";
  if (data && view.phase === "ready") {
    if (data.approval.status === "pending") message = "Approval requested. No memory change is confirmed yet. Review the persisted request below.";
    else if (data.approval.status !== "approved") message = `Memory request ${data.approval.status}. This request does not confirm a memory change.`;
    else if (data.approval.actionOutcome === "policy_blocked") message = "Memory effect blocked by policy. Your draft is retained.";
    else if (data.effect?.status === "failed") message = "Memory effect failed. Inspect the persisted outcome before retrying. Your draft is retained.";
    else if (data.effect?.status === "pending" || data.effect?.status === "running") message = "Memory effect is pending. Approval alone does not confirm a memory change.";
    else if (data.effect?.status === "completed" && data.effectResultMatches && data.change) message = "Original memory effect completed; matching change history confirmed.";
    else message = "Original memory effect is not verified. Canonical effect and matching history are required; your draft is retained.";
  }
  return <section aria-label="Memory request receipt" className="grid gap-2" aria-live="polite">
    {receipt.isError ? <Callout tone="warning">Memory outcome is not verified; current owner evidence is unavailable. {describeApiError(receipt.error).summary} Your draft is retained.</Callout> : <p role="status">{message}</p>}
    {data ? <><p>{view.stale ? "Last verified memory decision" : "Memory decision"}: {data.approval.status}.</p>{view.stale ? <p>Previous readback retained while current owner evidence is checked.</p> : null}{data.item ? <details><summary>{view.stale ? "Last verified memory record" : "Current memory record"}: {data.item.status}</summary><p>Readback title: {data.item.title}</p><p className="whitespace-pre-wrap break-words">{data.item.content}</p><p>Updated: {new Date(data.item.updatedAt).toLocaleString()}. Current readback is separate from the original effect.</p><TechnicalDetails label="Memory receipt provenance"><p>Updated: {data.item.updatedAt}</p></TechnicalDetails></details> : <p>Current memory record is unavailable. Your draft is retained.</p>}</> : null}
  </section>;
}

import type { CitadelRecord } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { hasCitadelRecord } from "./directory-lifecycle-binding";

export const CITADEL_KINDS: readonly CitadelRecord["kind"][] = ["personal", "company", "team", "client", "household", "creator", "learning", "project", "custom"];
export interface CitadelDraft { name: string; description: string; slug: string; kind: CitadelRecord["kind"] }
export function citadelDraft(record?: CitadelRecord | null): CitadelDraft {
  return { name: record?.name ?? "", description: record?.description ?? "", slug: record?.slug ?? "", kind: record?.kind ?? "custom" };
}
export function citadelRequestedSlug(draft: CitadelDraft): string {
  return (draft.slug.trim() || draft.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 64).replace(/-+$/g, "");
}
export function citadelEditorReceiptMatches(receipt: CitadelRecord, draft: CitadelDraft, before?: CitadelRecord): boolean {
  if (!hasCitadelRecord(receipt) || receipt.name !== draft.name.trim() || (receipt.description ?? "") !== draft.description.trim()
    || receipt.slug !== citadelRequestedSlug(draft) || receipt.kind !== draft.kind
    || !Number.isFinite(Date.parse(receipt.createdAt)) || !Number.isFinite(Date.parse(receipt.updatedAt))) return false;
  if (!before) return receipt.citadelId === receipt.slug && receipt.lifecycleStatus === "active" && !receipt.archivedAt && !receipt.defaultWorkspaceId;
  return receipt.citadelId === before.citadelId && receipt.createdAt === before.createdAt && receipt.lifecycleStatus === before.lifecycleStatus
    && receipt.archivedAt === before.archivedAt && receipt.defaultWorkspaceId === before.defaultWorkspaceId
    && receipt.revision !== before.revision && Date.parse(receipt.updatedAt) > Date.parse(before.updatedAt);
}
export function citadelEditorRejectedBeforeCommit(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object") return false;
  const body = error.body as Record<string, unknown>, details = body.details as Record<string, unknown> | undefined;
  // Current Citadel repository emits this slug conflict only before committing under its structure lock.
  return body.code === "ALREADY_EXISTS" && body.committed !== true && body.mutationCommitted !== true
    && details?.committed !== true && details?.mutationCommitted !== true;
}

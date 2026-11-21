import { createHash } from "node:crypto";

export const MEMORY_ITEM_ORIGIN_COLUMNS = `o.source_incarnation AS note_source_incarnation, o.owner_session_id AS note_owner_session_id,
 o.trust_level AS note_trust_level, o.upsert_key AS note_upsert_key, o.artifact_doc_id AS note_artifact_doc_id,`;
export function memoryItemSourceHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify([2,"memory_item",row.item_id,row.workspace_id,row.namespace,row.title,
    row.content,row.metadata_json,row.pinned,row.status,row.expires_at,row.updated_at,
    row.note_source_incarnation ?? null,row.note_owner_session_id ?? null,row.note_trust_level ?? null,
    row.note_upsert_key ?? null,row.note_artifact_doc_id ?? null])).digest("hex");
}

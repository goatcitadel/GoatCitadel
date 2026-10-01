import { ValidationError, type DurableRunHistoryQuery } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { toDurableRunRows, type DurableRunRow } from "./durable-run-row-codec.js";

interface HistoryCursor {
  version: 1;
  workspaceId: string;
  createdAt: string;
  runId: string;
}

function validId(value: unknown, maxBytes = 200): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && [...value].every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
}

function invalidCursor(): ValidationError {
  return new ValidationError({ field: "cursor", message: "Invalid durable history cursor for this workspace" });
}

function parseCursor(value: string | undefined, workspaceId: string): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw invalidCursor();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidCursor();
    const cursor = parsed as Record<string, unknown>;
    if (Object.keys(cursor).sort().join(",") !== "createdAt,runId,version,workspaceId"
      || cursor.version !== 1 || cursor.workspaceId !== workspaceId || !validId(cursor.runId, 256)
      || typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))
      || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw invalidCursor();
    return cursor as unknown as HistoryCursor;
  } catch {
    throw invalidCursor();
  }
}

/** Scope and keyset predicates run in storage before LIMIT, never on a global sample. */
export function listDurableRunHistoryRows(
  db: DatabaseClient,
  query: DurableRunHistoryQuery,
): { rows: DurableRunRow[]; nextCursor?: string } {
  if (!validId(query.workspaceId)) throw new ValidationError({ field: "workspaceId" });
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError({ field: "limit" });
  const cursor = parseCursor(query.cursor, query.workspaceId);
  // Bundled/CI PostgreSQL 16 supplies pg_input_is_valid. CASE must guard each
  // cast: WHERE predicate ordering alone cannot protect corrupt legacy JSON.
  const safeJson = (column: string) => db.dialect === "postgres"
    ? `CASE WHEN pg_input_is_valid(${column}, 'jsonb') THEN ${column}::jsonb END`
    : `CASE WHEN json_valid(${column}) THEN ${column} END`;
  const scope = (column: string) => db.dialect === "postgres"
    ? { type: `jsonb_typeof(${column} -> 'workspaceId')`, value: `${column} ->> 'workspaceId'`, string: "string" }
    : { type: `json_type(${column}, '$.workspaceId')`, value: `json_extract(${column}, '$.workspaceId')`, string: "text" };
  const jsonType = (column: string) => db.dialect === "postgres" ? `jsonb_typeof(${column})` : `json_type(${column})`;
  const payload = scope("history_payload_json");
  const metadata = scope("history_metadata_json");
  const clauses = [
    `${jsonType("history_payload_json")} = 'object'`,
    // Only SQL NULL means absent metadata. Corrupt or non-object metadata must
    // exclude the whole record even when the payload names this workspace.
    `(metadata_json IS NULL OR ${jsonType("history_metadata_json")} = 'object')`,
    `(${payload.type} IS NULL OR ${payload.type} IN ('null', '${payload.string}'))`,
    `(${metadata.type} IS NULL OR ${metadata.type} IN ('null', '${metadata.string}'))`,
    `(${payload.value} IS NULL OR ${payload.value} = @workspaceId)`,
    `(${metadata.value} IS NULL OR ${metadata.value} = @workspaceId)`,
    `COALESCE(${payload.value}, ${metadata.value}) = @workspaceId`,
  ];
  const params: Record<string, string | number> = { workspaceId: query.workspaceId, limit: limit + 1 };
  if (cursor) {
    clauses.push("(created_at < @createdAt OR (created_at = @createdAt AND run_id < @runId))");
    params.createdAt = cursor.createdAt;
    params.runId = cursor.runId;
  }
  const rows = toDurableRunRows(db.prepare(`
    WITH history_json AS (
      SELECT durable_runs.*, ${safeJson("payload_json")} AS history_payload_json,
        ${safeJson("metadata_json")} AS history_metadata_json
      FROM durable_runs
    )
    SELECT * FROM history_json
    WHERE ${clauses.join(" AND ")}
    ORDER BY created_at DESC, run_id DESC
    LIMIT @limit
  `).all(params));
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
    version: 1, workspaceId: query.workspaceId, createdAt: last.created_at, runId: last.run_id,
  } satisfies HistoryCursor)).toString("base64url") : undefined;
  return { rows: page, ...(nextCursor ? { nextCursor } : {}) };
}

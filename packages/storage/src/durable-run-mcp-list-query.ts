import type { DatabaseClient } from "./db.js";
import { toDurableRunRows, type DurableRunRow } from "./durable-run-row-codec.js";

// Match String.trim() in the MCP get/cancel scope check, including legacy IDs.
const trimCharacters = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const trimHex = [...trimCharacters].map((character) => Buffer.from(character).toString("hex")).join("|");
const trimHexPattern = `^(?:${trimHex})+|(?:${trimHex})+$`;

export function listDurableMcpTaskRunRows(db: DatabaseClient, workspaceId: string, limit: number): DurableRunRow[] {
  const postgres = db.dialect === "postgres";
  const safeJson = (column: string) => postgres
    ? `CASE WHEN pg_input_is_valid(${column}, 'jsonb') THEN ${column}::jsonb END`
    : `CASE WHEN json_valid(${column}) THEN ${column} END`;
  const type = (column: string, field: string) => postgres
    ? `jsonb_typeof(${column} -> '${field}')`
    : `json_type(${column}, '$.${field}')`;
  const policyContext = (column: string) => postgres
    ? `(${column} -> 'policyContext')`
    : `json_extract(${column}, '$.policyContext')`;
  const workspace = (column: string) => {
    // Trim UTF-8 hex in PostgreSQL so the query and its parameters are
    // representable even on servers that cannot encode every trim character.
    const normalized = postgres
      ? `regexp_replace(encode(convert_to(${column} ->> 'workspaceId', 'UTF8'), 'hex'), @trim, '', 'g')`
      : `trim(json_extract(${column}, '$.workspaceId'), @trim)`;
    return `CASE WHEN ${type(column, "workspaceId")} = '${postgres ? "string" : "text"}' THEN NULLIF(${normalized}, '') END`;
  };
  return toDurableRunRows(db.prepare(`
    WITH task_scope AS (
      SELECT durable_runs.*, ${safeJson("payload_json")} AS task_payload,
        ${safeJson("metadata_json")} AS task_metadata
      FROM durable_runs
    )
    SELECT * FROM task_scope
    WHERE COALESCE(
      ${workspace("task_metadata")},
      ${workspace("task_payload")},
      CASE WHEN ${type("task_payload", "policyContext")} = 'object'
        THEN ${workspace(policyContext("task_payload"))}
        WHEN ${type("task_metadata", "policyContext")} = 'object'
        THEN ${workspace(policyContext("task_metadata"))}
      END
    ) = @workspaceId
    ORDER BY created_at DESC, run_id DESC
    LIMIT @limit
  `).all({
    workspaceId: postgres ? Buffer.from(workspaceId).toString("hex") : workspaceId,
    trim: postgres ? trimHexPattern : trimCharacters,
    limit,
  }));
}

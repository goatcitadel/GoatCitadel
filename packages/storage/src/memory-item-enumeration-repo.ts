import { ConflictError, type MemoryItemRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { buildMemoryWorkspaceScopeSql } from "./memory-maintenance-repo.js";

export interface MemoryItemEnumerationRow {
  item_id: string; namespace: string; title: string; content: string; metadata_json: string | null;
  pinned: number; ttl_override_seconds: number | null; expires_at: string | null;
  status: MemoryItemRecord["status"]; created_at: string; updated_at: string; forgotten_at: string | null; workspace_id: string | null;
}

export interface MemoryItemEnumerationContinuation {
  generation: string;
  snapshotAt: string;
  validUntil: string;
  after: { updatedAt: string; itemId: string };
}

export interface MemoryItemEnumerationInput {
  workspaceId?: string;
  namespace?: string;
  status: "active" | "forgotten" | "all";
  query?: string;
  limit: number;
  continuation?: MemoryItemEnumerationContinuation;
}

export interface MemoryItemEnumerationPage {
  rows: MemoryItemEnumerationRow[];
  total: number;
  snapshotAt: string;
  continuation?: MemoryItemEnumerationContinuation;
}

const columns = `item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds,
  expires_at, status, created_at, updated_at, forgotten_at, workspace_id`;
const snapshotTtlMs = 15 * 60_000;

/** Consistent keyset pages over the canonical memory table. A database-owned
 * generation invalidates continuation on every committed item mutation. */
export class MemoryItemEnumerationRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public listPage(input: MemoryItemEnumerationInput): MemoryItemEnumerationPage {
    validateInput(input);
    return this.db.transaction("immediate", () => {
      // PostgreSQL shares this row lock between readers; mutation triggers must
      // acquire its write lock before committing. SQLite's immediate transaction
      // supplies the equivalent writer exclusion for count, clock and page reads.
      const state = this.db.prepare(`SELECT generation FROM memory_item_enumeration_state
        WHERE singleton_id = 1${this.db.dialect === "postgres" ? " FOR SHARE" : ""}`)
        .get<{ generation: string | number }>();
      if (!state) throw new Error("Memory enumeration state is unavailable");
      const generation = String(state.generation);
      const nowSql = this.db.dialect === "postgres"
        ? "to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      const now = this.db.prepare(`SELECT ${nowSql} AS now`).get<{ now: string }>()!.now;
      const previous = input.continuation;
      if (previous && (previous.generation !== generation || now >= previous.validUntil)) throw staleCursor();
      const snapshotAt = previous?.snapshotAt ?? now;
      const clauses: string[] = [], params: Record<string, string | number> = {};
      if (input.workspaceId) {
        clauses.push(buildMemoryWorkspaceScopeSql(this.db.dialect));
        params.workspaceId = input.workspaceId;
      }
      if (input.namespace) { clauses.push("namespace = @namespace"); params.namespace = input.namespace; }
      if (input.status !== "all") { clauses.push("status = @status"); params.status = input.status; }
      if (input.status === "active") {
        clauses.push("(expires_at IS NULL OR expires_at > @snapshotAt)"); params.snapshotAt = snapshotAt;
      }
      if (input.query) {
        clauses.push("(LOWER(title) LIKE @query OR LOWER(content) LIKE @query OR LOWER(namespace) LIKE @query)");
        params.query = `%${input.query}%`;
      }
      const where = clauses.length ? clauses.join(" AND ") : "1 = 1";
      const counts = this.db.prepare(`SELECT COUNT(*) AS total, MIN(expires_at) AS next_expiry FROM memory_items WHERE ${where}`)
        .get<{ total: number | string; next_expiry: string | null }>(params)!;
      const total = Number(counts.total);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("Memory enumeration count is invalid");
      let validUntil = previous?.validUntil ?? new Date(Date.parse(now) + snapshotTtlMs).toISOString();
      if (input.status === "active" && counts.next_expiry && counts.next_expiry < validUntil) validUntil = counts.next_expiry;
      const after = previous?.after;
      const position = after ? " AND (updated_at < @updatedAt OR (updated_at = @updatedAt AND item_id < @itemId))" : "";
      const rows = this.db.prepare(`SELECT ${columns} FROM memory_items WHERE ${where}${position}
        ORDER BY updated_at DESC, item_id DESC LIMIT @limit`).all<MemoryItemEnumerationRow>({
        ...params, limit: input.limit + 1, ...(after ? { updatedAt: after.updatedAt, itemId: after.itemId } : {}),
      });
      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit), last = page.at(-1);
      return { rows: page, total, snapshotAt,
        ...(hasMore && last ? { continuation: { generation, snapshotAt, validUntil,
          after: { updatedAt: last.updated_at, itemId: last.item_id } } } : {}),
      };
    });
  }
}

function validateInput(input: MemoryItemEnumerationInput): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new TypeError("Memory page limit must be 1-500");
  if (!["active", "forgotten", "all"].includes(input.status)) throw new TypeError("Invalid memory status filter");
  for (const value of [input.workspaceId, input.namespace, input.query]) {
    if (value !== undefined && (typeof value !== "string" || value.length > 2_000)) throw new TypeError("Invalid memory page filter");
  }
  const cursor = input.continuation;
  if (!cursor) return;
  if (!/^\d{1,19}$/.test(cursor.generation) || !isIso(cursor.snapshotAt) || !isIso(cursor.validUntil) ||
      cursor.validUntil <= cursor.snapshotAt || Date.parse(cursor.validUntil) - Date.parse(cursor.snapshotAt) > snapshotTtlMs ||
      typeof cursor.after?.updatedAt !== "string" || !cursor.after.updatedAt || cursor.after.updatedAt.length > 64 ||
      typeof cursor.after?.itemId !== "string" || !cursor.after.itemId || cursor.after.itemId.length > 256) {
    throw new TypeError("Invalid memory page continuation");
  }
}

function isIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function staleCursor(): ConflictError {
  return new ConflictError({
    message: "Memory changed or this page expired. Reload the list before continuing.",
    details: { reason: "MEMORY_CURSOR_STALE" },
  });
}

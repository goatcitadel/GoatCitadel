import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  AutonomyAuditAppendInput,
  AutonomyAuditEntry,
  AutonomyAuditKind,
  AutonomyAuditRestoreRef,
} from "@goatcitadel/contracts";
import { AUTONOMY_AUDIT_KINDS } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface AutonomyAuditRow {
  audit_id: string;
  kind: string;
  target_key: string;
  occurred_at: string;
  restore_ref_json: string;
  reverted: number;
  reverted_at: string | null;
}

const VALID_KINDS: ReadonlySet<AutonomyAuditKind> = new Set(AUTONOMY_AUDIT_KINDS);

/**
 * Append-only ledger of autonomous mutations (cross-cutting kill-switch & rollback).
 *
 * One row per autonomous mutation. The `restore_ref_json` column carries a
 * discriminated {@link AutonomyAuditRestoreRef} describing how to revert the
 * entry — the control service dispatches on it. `reverted` flips to 1 once an
 * entry has been undone so "revert since T" is idempotent (a second pass skips
 * already-reverted entries).
 *
 * Appends are best-effort at the call site: a failed append must never break the
 * mutation it describes. This repo therefore keeps writes simple and never
 * throws on a valid input.
 */
export class AutonomyAuditRepository {
  private readonly appendStmt;
  private readonly getStmt;
  private readonly listSinceStmt;
  private readonly listRecentStmt;
  private readonly countAllStmt;
  private readonly markRevertedStmt;
  private readonly clearRevertedStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.appendStmt = db.prepare(`
      INSERT INTO autonomy_audit (
        audit_id, kind, target_key, occurred_at, restore_ref_json, reverted, reverted_at
      ) VALUES (
        @auditId, @kind, @targetKey, @occurredAt, @restoreRefJson, 0, NULL
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM autonomy_audit WHERE audit_id = ?");
    // Newest-first so the control service reverts most-recent changes first.
    // LIMIT is pushed into SQL so a large unreverted backlog is bounded at the
    // database, not loaded wholesale into memory for the caller to slice.
    this.listSinceStmt = db.prepare(`
      SELECT * FROM autonomy_audit
      WHERE occurred_at >= ? AND reverted = 0
      ORDER BY occurred_at DESC, audit_id DESC
      LIMIT ?
    `);
    this.listRecentStmt = db.prepare(`
      SELECT * FROM autonomy_audit
      ORDER BY occurred_at DESC, audit_id DESC
      LIMIT ?
    `);
    this.countAllStmt = db.prepare(`
      SELECT
        kind,
        COUNT(*) AS total,
        SUM(CASE WHEN reverted = 1 THEN 1 ELSE 0 END) AS reverted
      FROM autonomy_audit
      GROUP BY kind
    `);
    this.markRevertedStmt = db.prepare(`
      UPDATE autonomy_audit
      SET reverted = 1, reverted_at = @revertedAt
      WHERE audit_id = @auditId AND reverted = 0
    `);
    this.clearRevertedStmt = db.prepare(`
      UPDATE autonomy_audit
      SET reverted = 0, reverted_at = NULL
      WHERE audit_id = @auditId AND reverted = 1
    `);
  }

  /** Append a new audit entry. Returns the stored record. */
  public append(input: AutonomyAuditAppendInput, now = new Date().toISOString()): AutonomyAuditEntry {
    const auditId = createAutonomyAuditId();
    const occurredAt = input.occurredAt ?? now;
    this.appendStmt.run({
      auditId,
      kind: input.kind,
      targetKey: input.targetKey,
      occurredAt,
      restoreRefJson: JSON.stringify(input.restoreRef),
    });
    const stored = this.get(auditId);
    if (!stored) {
      // Unreachable: the insert above guarantees a row exists.
      throw new Error(`autonomy audit append did not persist (id=${auditId})`);
    }
    return stored;
  }

  public get(auditId: string): AutonomyAuditEntry | undefined {
    const row = toRow(this.getStmt.get(auditId));
    return row ? mapRow(row) : undefined;
  }

  /**
   * Un-reverted entries with `occurredAt >= sinceIso`, newest-first. This is the
   * exact set the control service walks for "revert autonomous changes since T".
   * The result is bounded by `limit` (pushed into SQL) so an unbounded backlog
   * never loads wholesale into memory; callers pass their own cap when they have
   * one.
   */
  public listUnrevertedSince(sinceIso: string, limit = 10_000): AutonomyAuditEntry[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10_000;
    return this.listSinceStmt.all(sinceIso, safeLimit).map(toRow).filter(isEntryRow).map(mapRow);
  }

  /** Most recent entries (newest first), capped by `limit`. */
  public listRecent(limit = 20): AutonomyAuditEntry[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    return this.listRecentStmt.all(safeLimit).map(toRow).filter(isEntryRow).map(mapRow);
  }

  /** Per-kind totals (total + reverted) across all entries. */
  public countByKind(): Array<{ kind: AutonomyAuditKind; total: number; reverted: number }> {
    const rows = this.countAllStmt.all<{ kind: unknown; total: unknown; reverted: unknown }>();
    const out: Array<{ kind: AutonomyAuditKind; total: number; reverted: number }> = [];
    for (const row of rows) {
      if (!isAuditKind(row.kind)) {
        continue;
      }
      out.push({
        kind: row.kind,
        total: toCount(row.total),
        reverted: toCount(row.reverted),
      });
    }
    return out;
  }

  /**
   * Mark an entry reverted. Returns true if it transitioned (was un-reverted),
   * false if it was already reverted or does not exist (idempotent).
   */
  public markReverted(auditId: string, now = new Date().toISOString()): boolean {
    const result = this.markRevertedStmt.run({ auditId, revertedAt: now });
    return toCount(result.changes) > 0;
  }

  /**
   * Clear the reverted flag on an entry. Inverse of {@link markReverted}; used to
   * roll back a *claim* when the restore that the caller intended to perform
   * threw, so the entry stays retryable on a later pass. Returns true if it
   * transitioned (was reverted), false otherwise.
   */
  public unmarkReverted(auditId: string): boolean {
    const result = this.clearRevertedStmt.run({ auditId });
    return toCount(result.changes) > 0;
  }
}

function mapRow(row: AutonomyAuditRow): AutonomyAuditEntry {
  const entry: AutonomyAuditEntry = {
    auditId: row.audit_id,
    kind: isAuditKind(row.kind) ? row.kind : "memory",
    targetKey: typeof row.target_key === "string" ? row.target_key : "",
    occurredAt: row.occurred_at,
    restoreRef: parseRestoreRef(row.restore_ref_json),
    reverted: row.reverted === 1,
  };
  if (row.reverted_at) {
    entry.revertedAt = row.reverted_at;
  }
  return entry;
}

function parseRestoreRef(value: string): AutonomyAuditRestoreRef {
  const parsed = safeJsonParse<AutonomyAuditRestoreRef>(value ?? "{}", {
    kind: "memory",
    priorSnapshot: undefined,
  });
  return parsed;
}

function isAuditKind(value: unknown): value is AutonomyAuditKind {
  return typeof value === "string" && VALID_KINDS.has(value as AutonomyAuditKind);
}

function toCount(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function toRow(value: unknown): AutonomyAuditRow | undefined {
  return isAuditRow(value) ? value : undefined;
}

function isEntryRow(value: AutonomyAuditRow | undefined): value is AutonomyAuditRow {
  return value !== undefined;
}

function isAuditRow(value: unknown): value is AutonomyAuditRow {
  return (
    isRecord(value) &&
    typeof value.audit_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.target_key === "string" &&
    typeof value.occurred_at === "string" &&
    typeof value.restore_ref_json === "string" &&
    typeof value.reverted === "number" &&
    (value.reverted_at === null || typeof value.reverted_at === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Stable id factory for a new autonomy-audit entry. */
export function createAutonomyAuditId(): string {
  return `aa_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

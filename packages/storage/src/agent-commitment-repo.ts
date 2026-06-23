import type { DatabaseClient } from "./db.js";
import type {
  AgentCommitmentCreatedBy,
  AgentCommitmentKind,
  AgentCommitmentRecord,
  AgentCommitmentStatus,
} from "@goatcitadel/contracts";

interface AgentCommitmentRow {
  commitment_id: string;
  session_id: string;
  workspace_id: string;
  kind: string;
  due_at: string;
  confidence: number;
  dedupe_key: string;
  suggested_text: string;
  status: string;
  created_by: string;
  created_at: string;
  sent_at: string | null;
}

/** Input for {@link AgentCommitmentRepository.upsertByDedupe}. */
export interface AgentCommitmentUpsertInput {
  commitmentId: string;
  sessionId: string;
  workspaceId: string;
  kind: AgentCommitmentKind;
  dueAt: string;
  confidence: number;
  dedupeKey: string;
  suggestedText: string;
  status?: AgentCommitmentStatus;
  createdBy?: AgentCommitmentCreatedBy;
}

/**
 * Persistence for inferred follow-up commitments (P1-F3).
 *
 * Dedup wins: {@link upsertByDedupe} keys on `(session_id, dedupe_key)`. A second
 * classification of the same future check-in updates the existing row (refreshing
 * dueAt / confidence / text) rather than creating a duplicate, and never resets a
 * row that has already been `sent`/`dismissed`/`superseded` back to `pending`.
 */
export class AgentCommitmentRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly getByDedupeStmt;
  private readonly listDueStmt;
  private readonly listBySessionStmt;
  private readonly markDeliveryPendingStmt;
  private readonly markDeliveryFailedStmt;
  private readonly markSentStmt;
  private readonly markSupersededStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO agent_commitments (
        commitment_id, session_id, workspace_id, kind, due_at, confidence,
        dedupe_key, suggested_text, status, created_by, created_at, sent_at
      ) VALUES (
        @commitmentId, @sessionId, @workspaceId, @kind, @dueAt, @confidence,
        @dedupeKey, @suggestedText, @status, @createdBy, @createdAt, NULL
      )
      ON CONFLICT(session_id, dedupe_key) DO UPDATE SET
        kind = excluded.kind,
        due_at = excluded.due_at,
        confidence = excluded.confidence,
        suggested_text = excluded.suggested_text,
        workspace_id = excluded.workspace_id
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM agent_commitments WHERE commitment_id = ?
    `);
    this.getByDedupeStmt = db.prepare(`
      SELECT * FROM agent_commitments WHERE session_id = @sessionId AND dedupe_key = @dedupeKey
    `);
    this.listDueStmt = db.prepare(`
      SELECT *
      FROM agent_commitments
      WHERE status = 'pending' AND due_at <= @nowIso
      ORDER BY due_at ASC, commitment_id ASC
      LIMIT @limit
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT *
      FROM agent_commitments
      WHERE session_id = @sessionId
      ORDER BY due_at ASC, commitment_id ASC
      LIMIT @limit
    `);
    this.markSentStmt = db.prepare(`
      UPDATE agent_commitments
      SET status = 'sent', sent_at = @sentAt
      WHERE commitment_id = @commitmentId AND status IN ('pending', 'delivery_pending')
    `);
    this.markDeliveryPendingStmt = db.prepare(`
      UPDATE agent_commitments
      SET status = 'delivery_pending'
      WHERE commitment_id = @commitmentId AND status = 'pending'
    `);
    this.markDeliveryFailedStmt = db.prepare(`
      UPDATE agent_commitments
      SET status = 'delivery_failed'
      WHERE commitment_id = @commitmentId AND status IN ('pending', 'delivery_pending')
    `);
    this.markSupersededStmt = db.prepare(`
      UPDATE agent_commitments
      SET status = 'superseded'
      WHERE commitment_id = @commitmentId AND status = 'pending'
    `);
  }

  /**
   * Insert a commitment, or update the existing row sharing
   * `(session_id, dedupe_key)`. Returns the resulting record. Dedup updates only
   * refresh inferred fields; lifecycle (`status`/`sent_at`) is preserved.
   */
  public upsertByDedupe(input: AgentCommitmentUpsertInput, now = new Date().toISOString()): AgentCommitmentRecord {
    this.upsertStmt.run({
      commitmentId: input.commitmentId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      dueAt: input.dueAt,
      confidence: input.confidence,
      dedupeKey: input.dedupeKey,
      suggestedText: input.suggestedText,
      status: input.status ?? "pending",
      createdBy: input.createdBy ?? "classifier",
      createdAt: now,
    });
    const stored = this.getByDedupe(input.sessionId, input.dedupeKey);
    if (!stored) {
      // Should be unreachable: the upsert above guarantees a row exists.
      throw new Error(
        `agent commitment upsert did not persist (session=${input.sessionId}, dedupe=${input.dedupeKey})`,
      );
    }
    return stored;
  }

  public get(commitmentId: string): AgentCommitmentRecord | undefined {
    const row = toRow(this.getStmt.get(commitmentId));
    return row ? mapRow(row) : undefined;
  }

  public getByDedupe(sessionId: string, dedupeKey: string): AgentCommitmentRecord | undefined {
    const row = toRow(this.getByDedupeStmt.get({ sessionId, dedupeKey }));
    return row ? mapRow(row) : undefined;
  }

  /**
   * Pending commitments whose `dueAt <= nowIso`, oldest-due first. Bounded by
   * `limit`. Non-pending rows (sent/dismissed/superseded) are excluded.
   */
  public listDue(nowIso: string, limit = 100): AgentCommitmentRecord[] {
    const rows = toRows(this.listDueStmt.all({ nowIso, limit: clampLimit(limit) }));
    return rows.map(mapRow);
  }

  public listBySession(sessionId: string, limit = 100): AgentCommitmentRecord[] {
    const rows = toRows(this.listBySessionStmt.all({ sessionId, limit: clampLimit(limit) }));
    return rows.map(mapRow);
  }

  /** Transition a still-pending commitment to async delivery-pending. Returns true if updated. */
  public markDeliveryPending(commitmentId: string): boolean {
    const result = this.markDeliveryPendingStmt.run({ commitmentId });
    return changed(result);
  }

  /** Transition a pending or async delivery-pending commitment to `delivery_failed`. Returns true if updated. */
  public markDeliveryFailed(commitmentId: string): boolean {
    const result = this.markDeliveryFailedStmt.run({ commitmentId });
    return changed(result);
  }

  /** Transition a still-pending commitment to `sent`. Returns true if updated. */
  public markSent(commitmentId: string, now = new Date().toISOString()): boolean {
    const result = this.markSentStmt.run({ commitmentId, sentAt: now });
    return changed(result);
  }

  /** Transition a still-pending commitment to `superseded`. Returns true if updated. */
  public markSuperseded(commitmentId: string): boolean {
    const result = this.markSupersededStmt.run({ commitmentId });
    return changed(result);
  }
}

function mapRow(row: AgentCommitmentRow): AgentCommitmentRecord {
  return {
    commitmentId: row.commitment_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    kind: row.kind as AgentCommitmentKind,
    dueAt: row.due_at,
    confidence: row.confidence,
    dedupeKey: row.dedupe_key,
    suggestedText: row.suggested_text,
    status: row.status as AgentCommitmentStatus,
    createdBy: row.created_by as AgentCommitmentCreatedBy,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 100;
  }
  return Math.min(Math.floor(limit), 1000);
}

function changed(result: unknown): boolean {
  return Number((result as { changes?: number } | undefined)?.changes ?? 0) > 0;
}

function toRow(value: unknown): AgentCommitmentRow | undefined {
  return isAgentCommitmentRow(value) ? value : undefined;
}

function toRows(value: unknown): AgentCommitmentRow[] {
  return Array.isArray(value) ? value.filter(isAgentCommitmentRow) : [];
}

function isAgentCommitmentRow(value: unknown): value is AgentCommitmentRow {
  return (
    isRecord(value) &&
    typeof value.commitment_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.due_at === "string" &&
    typeof value.confidence === "number" &&
    typeof value.dedupe_key === "string" &&
    typeof value.suggested_text === "string" &&
    typeof value.status === "string" &&
    typeof value.created_by === "string" &&
    typeof value.created_at === "string" &&
    (typeof value.sent_at === "string" || value.sent_at === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

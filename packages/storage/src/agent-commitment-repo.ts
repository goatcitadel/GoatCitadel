import type { DatabaseClient } from "./db.js";
import {
  buildCommitmentCheckInPrompt,
  canonicalJsonString,
  ConflictError,
  type CommitmentCreatorReceipt,
  type CronAgentTurnConfig,
  type CronRunRecord,
} from "@goatcitadel/contracts";
import { CronJobRepository } from "./cron-job-repo.js";
import { CronRunRepository } from "./cron-run-repo.js";
import { commitmentSha256, readCommitmentCreatorReceipt } from "./commitment-creator-receipt.js";
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
  revision: number;
  creator_receipt_json: string | null;
  creator_receipt_sha256: string | null;
  scheduled_job_id: string | null;
  scheduled_run_id: string | null;
  scheduled_material_sha256: string | null;
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
  /** Internal canonical turn pointer, never classifier-generated authority. */
  sourceTurnId?: string;
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
  private readonly hasOpenBySessionStmt;
  private readonly markDeliveryPendingStmt;
  private readonly markDeliveryFailedStmt;
  private readonly markSentStmt;
  private readonly markSupersededStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO agent_commitments (
        commitment_id, session_id, workspace_id, kind, due_at, confidence,
        dedupe_key, suggested_text, status, created_by, created_at, sent_at,
        revision, creator_receipt_json, creator_receipt_sha256
      ) VALUES (
        @commitmentId, @sessionId, @workspaceId, @kind, @dueAt, @confidence,
        @dedupeKey, @suggestedText, @status, @createdBy, @createdAt, NULL,
        1, @creatorReceiptJson, @creatorReceiptSha256
      )
      ON CONFLICT(session_id, dedupe_key) DO UPDATE SET
        kind = excluded.kind,
        due_at = excluded.due_at,
        confidence = excluded.confidence,
        suggested_text = excluded.suggested_text,
        workspace_id = excluded.workspace_id,
        revision = agent_commitments.revision + 1,
        creator_receipt_json = excluded.creator_receipt_json,
        creator_receipt_sha256 = excluded.creator_receipt_sha256
      WHERE agent_commitments.scheduled_run_id IS NULL
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
    // Existence-only counterpart to `listBySession(...).some(status === 'pending')`,
    // used on the proactive scheduler hot path. Encodes the IDENTICAL "open" predicate
    // (status = 'pending') as a single bounded existence probe so an idle session never
    // pays to materialize and map up to N commitment rows just to answer a yes/no.
    this.hasOpenBySessionStmt = db.prepare(`
      SELECT 1 AS present
      FROM agent_commitments
      WHERE session_id = @sessionId AND status = 'pending'
      LIMIT 1
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
    const receipt = readCommitmentCreatorReceipt(this.db, input);
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
      creatorReceiptJson: receipt ? canonicalJsonString(receipt) : null,
      creatorReceiptSha256: receipt ? commitmentSha256(receipt) : null,
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

  /** Atomically freeze inferred material and reserve exactly one existing cron occurrence. */
  public claimScheduledOccurrence(input: {
    commitmentId: string;
    expectedRevision: number;
    deliveryChannel?: CronAgentTurnConfig["deliveryChannel"];
  }): CronRunRecord {
    return this.db.transaction("immediate", () => {
      const observed = this.get(input.commitmentId);
      if (!observed) throw new ConflictError({ message: "Commitment no longer exists." });
      // Share the session admission lock before taking the commitment row lock.
      if (this.db.dialect === "postgres") this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@sessionId, 411))")
        .get({ sessionId: observed.sessionId });
      // A no-op update obtains the PostgreSQL row lock before rereading; SQLite already holds the write lock.
      this.db.prepare("UPDATE agent_commitments SET status = status WHERE commitment_id = ?").run(input.commitmentId);
      const row = this.get(input.commitmentId);
      if (!row) throw new ConflictError({ message: "Commitment no longer exists." });
      const runs = new CronRunRepository(this.db);
      if (row.scheduledRunId) {
        const existing = runs.get(row.scheduledRunId);
        if (!existing) throw new ConflictError({ message: "Commitment occurrence owner is missing." });
        return existing;
      }
      const nowRow = this.db
        .prepare(
          this.db.dialect === "postgres"
            ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso`
            : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso`,
        )
        .get<{ now_iso: string }>();
      const now = nowRow!.now_iso;
      if (row.status !== "pending" || row.revision !== input.expectedRevision || row.dueAt > now)
        throw new ConflictError({ message: "Commitment revision is stale or not due." });
      const active = this.db.prepare(`SELECT 1 FROM agent_commitments c JOIN cron_runs r ON r.run_id = c.scheduled_run_id
        WHERE c.session_id = @sessionId AND c.workspace_id = @workspaceId
          AND r.status IN ('admitting', 'admitted', 'running', 'waiting') LIMIT 1`)
        .get({ sessionId: row.sessionId, workspaceId: row.workspaceId });
      if (active) throw new ConflictError({ message: "Another commitment occurrence is already active for this session." });
      const creator = this.readCurrentCreator(row);
      const materialSha256 = commitmentSha256(commitmentMaterial(row));
      const suffix = commitmentSha256({ commitmentId: row.commitmentId }).slice(0, 40);
      const jobId = `commitment_${suffix}`;
      const runId = `cron_commitment_${suffix}`;
      const config: CronAgentTurnConfig = {
        sessionId: row.sessionId,
        prompt: buildCommitmentCheckInPrompt(row.suggestedText),
        deliverMode: "always",
        commitment: { commitmentId: row.commitmentId, revision: row.revision!, materialSha256 },
        ...(creator && input.deliveryChannel
          ? {
              deliveryChannel: input.deliveryChannel,
              createdBy: { operatorId: creator.actorId, permissionProfileId: creator.permissionProfileId, depth: 0 },
            }
          : { inertInboxFallback: true }),
      };
      new CronJobRepository(this.db).createSpec(
        {
          jobId,
          name: "Commitment follow-up",
          action: "agent_turn",
          actionConfig: { agentTurn: config },
          schedule: "0 0 1 1 *",
          enabled: false,
          description: "One frozen commitment occurrence; execution and delivery are owned by cron.",
        },
        now,
      );
      const admitted = runs.beginAdmission(
        {
          jobId,
          runId,
          admissionKey: `commitment:${row.commitmentId}`,
          scheduledFor: row.dueAt,
          trigger: "scheduled_due",
        },
        now,
      );
      if (admitted.outcome === "blocked") throw new ConflictError({ message: "Commitment occurrence overlap." });
      this.db
        .prepare(
          `UPDATE agent_commitments SET status = 'delivery_pending', scheduled_job_id = @jobId,
        scheduled_run_id = @runId, scheduled_material_sha256 = @materialSha256
        WHERE commitment_id = @commitmentId AND scheduled_run_id IS NULL AND revision = @revision`,
        )
        .run({
          jobId,
          runId,
          materialSha256,
          commitmentId: row.commitmentId,
          revision: row.revision,
        });
      return admitted.run;
    });
  }

  /** The immutable cron snapshot must agree with both frozen material and the current source owner. */
  public assertScheduledOccurrence(runId: string, config: CronAgentTurnConfig): AgentCommitmentRecord {
    const ref = config.commitment;
    const row = ref ? this.get(ref.commitmentId) : undefined;
    const creator = row ? this.readCurrentCreator(row) : undefined;
    if (
      !row ||
      !ref ||
      !creator ||
      row.scheduledRunId !== runId ||
      row.revision !== ref.revision ||
      row.scheduledMaterialSha256 !== ref.materialSha256 ||
      commitmentSha256(commitmentMaterial(row)) !== ref.materialSha256 ||
      config.sessionId !== row.sessionId ||
      config.prompt !== buildCommitmentCheckInPrompt(row.suggestedText) ||
      config.createdBy?.operatorId !== creator.actorId ||
      config.createdBy?.permissionProfileId !== creator.permissionProfileId ||
      config.inertInboxFallback ||
      row.status !== "delivery_pending"
    )
      throw new ConflictError({ message: "Commitment occurrence or creator receipt is stale." });
    return row;
  }

  /** Only the canonical cron terminal receipt settles a scheduled commitment; delivery retries never rerun its model. */
  public reconcileScheduled(limit = 100): number {
    const rows = this.db
      .prepare(
        `SELECT c.commitment_id, r.status, r.outcome_json FROM agent_commitments c
      JOIN cron_runs r ON r.run_id = c.scheduled_run_id
      WHERE c.status = 'delivery_pending' ORDER BY c.due_at LIMIT ?`,
      )
      .all<{ commitment_id: string; status: string; outcome_json: string | null }>(clampLimit(limit));
    let count = 0;
    for (const row of rows) {
      if (row.status === "completed") {
        const outcome = row.outcome_json ? (JSON.parse(row.outcome_json) as Record<string, unknown>) : {};
        if (outcome.mode === "inbox" || outcome.status === "inbox_created") {
          this.db
            .prepare(
              "UPDATE agent_commitments SET status = 'dismissed' WHERE commitment_id = ? AND status = 'delivery_pending'",
            )
            .run(row.commitment_id);
        } else if (outcome.deliveryStatus === "sent" && typeof outcome.deliveryId === "string") {
          this.markSent(row.commitment_id);
        } else this.markDeliveryFailed(row.commitment_id);
        count++;
      } else if (["failed", "cancelled", "manual_reconciliation_required"].includes(row.status)) {
        this.markDeliveryFailed(row.commitment_id);
        count++;
      }
    }
    return count;
  }

  private readCurrentCreator(row: AgentCommitmentRecord): CommitmentCreatorReceipt | undefined {
    const receipt = row.creatorReceipt;
    if (!receipt || commitmentSha256(receipt) !== row.creatorReceiptSha256) return undefined;
    const current = readCommitmentCreatorReceipt(this.db, { ...row, sourceTurnId: receipt.sourceTurnId });
    return current && canonicalJsonString(current) === canonicalJsonString(receipt) ? current : undefined;
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

  /**
   * True when the session has at least one `pending` commitment. Behaviourally
   * equivalent to `listBySession(sessionId, anyLimit).some((c) => c.status === "pending")`
   * but answered by a single bounded existence query — no rows are materialized or
   * mapped. Intended for the proactive scheduler's per-tick "has open work?" gate.
   */
  public hasOpenBySession(sessionId: string): boolean {
    return this.hasOpenBySessionStmt.get({ sessionId }) !== undefined;
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
    revision: Number(row.revision),
    creatorReceipt: row.creator_receipt_json
      ? (JSON.parse(row.creator_receipt_json) as CommitmentCreatorReceipt)
      : undefined,
    creatorReceiptSha256: row.creator_receipt_sha256 ?? undefined,
    scheduledJobId: row.scheduled_job_id ?? undefined,
    scheduledRunId: row.scheduled_run_id ?? undefined,
    scheduledMaterialSha256: row.scheduled_material_sha256 ?? undefined,
  };
}

function commitmentMaterial(row: AgentCommitmentRecord) {
  return {
    version: "commitment.occurrence.v1",
    commitmentId: row.commitmentId,
    revision: row.revision,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    kind: row.kind,
    dueAt: row.dueAt,
    dedupeKey: row.dedupeKey,
    suggestedText: row.suggestedText,
    creatorReceiptSha256: row.creatorReceiptSha256 ?? null,
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

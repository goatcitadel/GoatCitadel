import type { PendingApprovalAction } from "@goatcitadel/contracts";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { parseJsonObject } from "./state-validators.js";

export interface PendingApprovalActionRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

interface PendingActionRow {
  approval_id: string;
  action_type: PendingApprovalAction["actionType"];
  request_json: string;
  created_at: string;
  expires_at: string | null;
  resolved_at: string | null;
  resolution_status: NonNullable<PendingApprovalAction["resolutionStatus"]>;
  result_json: string | null;
}

export class PendingApprovalActionRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly findFreshPendingStmt;
  private readonly resolveStmt;
  private readonly reclassifyExecutedAsFailedStmt;
  private readonly options: PendingApprovalActionRepositoryOptions;

  public constructor(
    private readonly db: DatabaseClient,
    options: PendingApprovalActionRepositoryOptions = {},
  ) {
    this.options = options;
    this.upsertStmt = db.prepare(`
      INSERT INTO pending_approval_actions (
        approval_id, action_type, request_json, created_at, expires_at, resolution_status
      ) VALUES (@approvalId, @actionType, @requestJson, @createdAt, @expiresAt, 'pending')
      ON CONFLICT(approval_id) DO UPDATE SET
        action_type = excluded.action_type,
        request_json = excluded.request_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
      WHERE pending_approval_actions.resolution_status = 'pending'
    `);

    this.getStmt = db.prepare("SELECT * FROM pending_approval_actions WHERE approval_id = ?");
    const explicitExpiry = db.dialect === "postgres" ? "gc_try_parse_timestamptz(expires_at)" : "julianday(expires_at)";
    const createdAt = db.dialect === "postgres" ? "gc_try_parse_timestamptz(created_at)" : "julianday(created_at)";
    const databaseNow = db.dialect === "postgres" ? "statement_timestamp()" : "julianday('now')";
    const defaultExpiry =
      db.dialect === "postgres"
        ? `(${createdAt} + (CAST(@defaultTtlMs AS DOUBLE PRECISION) * INTERVAL '1 millisecond'))`
        : `(${createdAt} + (CAST(@defaultTtlMs AS REAL) / 86400000.0))`;
    this.findFreshPendingStmt = db.prepare(`
      SELECT *
      FROM pending_approval_actions
      WHERE approval_id = @approvalId
        AND resolution_status = 'pending'
        AND (
          (
            expires_at IS NOT NULL
            AND ${explicitExpiry} IS NOT NULL
            AND ${explicitExpiry} > ${databaseNow}
          )
          OR (
            expires_at IS NULL
            AND ${createdAt} IS NOT NULL
            AND ${defaultExpiry} > ${databaseNow}
          )
        )
      LIMIT 1
    `);

    this.resolveStmt = db.prepare(`
      UPDATE pending_approval_actions
      SET resolved_at = @resolvedAt, resolution_status = @resolutionStatus, result_json = @resultJson
      WHERE approval_id = @approvalId
        AND resolution_status = 'pending'
    `);
    this.reclassifyExecutedAsFailedStmt = db.prepare(`
      UPDATE pending_approval_actions
      SET resolution_status = 'failed', result_json = @nextResultJson
      WHERE approval_id = @approvalId
        AND resolution_status = 'executed'
        AND result_json = @expectedResultJson
    `);
  }

  public upsertPending(input: {
    approvalId: string;
    actionType: PendingApprovalAction["actionType"];
    request: Record<string, unknown>;
    createdAt?: string;
    expiresAt?: string;
  }): PendingApprovalAction {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.upsertStmt.run({
      approvalId: input.approvalId,
      actionType: input.actionType,
      requestJson: JSON.stringify(input.request),
      createdAt,
      expiresAt: input.expiresAt ?? null,
    });
    return this.get(input.approvalId);
  }

  public get(approvalId: string): PendingApprovalAction {
    const row = this.getStmt.get(approvalId) as PendingActionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "pending approval action", id: approvalId });
    }
    return this.mapRow(row);
  }

  public find(approvalId: string): PendingApprovalAction | undefined {
    const row = this.getStmt.get(approvalId) as PendingActionRow | undefined;
    if (!row) {
      return undefined;
    }
    return this.mapRow(row);
  }

  public findFreshPending(approvalId: string, defaultTtlMs: number): PendingApprovalAction | undefined {
    const normalizedDefaultTtlMs = Math.max(0, Math.floor(defaultTtlMs));
    const row = this.findFreshPendingStmt.get({
      approvalId,
      defaultTtlMs: normalizedDefaultTtlMs,
    }) as PendingActionRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  public markResolved(
    approvalId: string,
    resolutionStatus: NonNullable<PendingApprovalAction["resolutionStatus"]>,
    result?: Record<string, unknown>,
  ): PendingApprovalAction {
    const update = this.resolveStmt.run({
      approvalId,
      resolvedAt: new Date().toISOString(),
      resolutionStatus,
      resultJson: result ? JSON.stringify(result) : null,
    });

    if (update.changes === 0) {
      const existing = this.find(approvalId);
      if (existing) {
        return existing;
      }
      throw new NotFoundError({ entity: "pending approval action", id: approvalId });
    }

    return this.get(approvalId);
  }

  public reclassifyExecutedAsFailed(
    approvalId: string,
    expectedResult: Record<string, unknown>,
    nextResult: Record<string, unknown>,
  ): PendingApprovalAction {
    const update = this.reclassifyExecutedAsFailedStmt.run({
      approvalId,
      expectedResultJson: JSON.stringify(expectedResult),
      nextResultJson: JSON.stringify(nextResult),
    });
    if (update.changes > 0) {
      return this.get(approvalId);
    }
    const existing = this.find(approvalId);
    if (!existing) {
      throw new NotFoundError({ entity: "pending approval action", id: approvalId });
    }
    if (existing.resolutionStatus === "failed") {
      return existing;
    }
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Pending approval action ${approvalId} changed before its executed result could be reclassified as failed.`,
      details: { approvalId, resolutionStatus: existing.resolutionStatus },
    });
  }

  private mapRow(row: PendingActionRow): PendingApprovalAction {
    return {
      approvalId: row.approval_id,
      actionType: row.action_type,
      request: loadAndSanitize(
        row.request_json,
        {
          store: "pending_approval_action.request",
          rowId: row.approval_id,
          parse: parseJsonObject,
          onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
          log: this.options.logger,
        },
        {},
      ) as Record<string, unknown>,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolutionStatus: row.resolution_status,
      result: row.result_json
        ? (loadAndSanitize(
            row.result_json,
            {
              store: "pending_approval_action.result",
              rowId: row.approval_id,
              parse: parseJsonObject,
              onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
              log: this.options.logger,
            },
            {},
          ) as Record<string, unknown>)
        : undefined,
    };
  }
}

import { randomUUID } from "node:crypto";
import type {
  ApprovalEffectKind,
  ApprovalEffectRecord,
  ApprovalEffectStatus,
  ApprovalEffectTargetKind,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface ApprovalEffectRow {
  effect_id: string;
  approval_id: string;
  effect_kind: ApprovalEffectKind | "wake_durable_run";
  target_kind: ApprovalEffectTargetKind | null;
  target_id: string;
  idempotency_key: string | null;
  status: ApprovalEffectStatus;
  outcome: string | null;
  detail: string | null;
  attempt_count: number;
  details_json: string | null;
  payload_json: string | null;
  result_json: string | null;
  last_error: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  version: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class ApprovalEffectRepository {
  private readonly getByIdStmt;
  private readonly getByIdempotencyKeyStmt;
  private readonly getByTargetStmt;
  private readonly listByApprovalStmt;
  private readonly upsertStmt;
  private readonly claimCandidatesStmt;
  private readonly claimEffectStmt;
  private readonly renewLeaseStmt;
  private readonly completeEffectStmt;
  private readonly skipEffectStmt;
  private readonly failEffectStmt;
  private readonly recoverExpiredStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getByIdStmt = db.prepare(`
      SELECT *
      FROM approval_effects
      WHERE effect_id = ?
      LIMIT 1
    `);
    this.getByIdempotencyKeyStmt = db.prepare(`
      SELECT *
      FROM approval_effects
      WHERE idempotency_key = ?
      LIMIT 1
    `);
    this.getByTargetStmt = db.prepare(`
      SELECT *
      FROM approval_effects
      WHERE approval_id = ? AND effect_kind = ? AND target_kind = ? AND target_id = ?
      LIMIT 1
    `);
    this.listByApprovalStmt = db.prepare(`
      SELECT *
      FROM approval_effects
      WHERE approval_id = ?
      ORDER BY created_at ASC, effect_id ASC
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO approval_effects (
        effect_id, approval_id, effect_kind, target_kind, target_id, idempotency_key, status,
        attempt_count, payload_json, result_json, last_error, claimed_by, claimed_at,
        lease_expires_at, version, created_at, updated_at, completed_at
      ) VALUES (
        @effectId, @approvalId, @effectKind, @targetKind, @targetId, @idempotencyKey, @status,
        @attemptCount, @payloadJson, @resultJson, @lastError, @claimedBy, @claimedAt,
        @leaseExpiresAt, @version, @createdAt, @updatedAt, @completedAt
      )
      ON CONFLICT(idempotency_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    this.claimCandidatesStmt = db.prepare(`
      SELECT *
      FROM approval_effects
      WHERE (
          status = 'pending'
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
        )
      ORDER BY
        CASE effect_kind
          WHEN 'pending_action_execute' THEN 0
          WHEN 'approval_wait_wake' THEN 1
          WHEN 'proactive_run_wake' THEN 2
          WHEN 'linked_chat_turn_wake' THEN 3
          ELSE 4
        END ASC,
        created_at ASC,
        effect_id ASC
      LIMIT @limit
    `);
    this.claimEffectStmt = db.prepare(`
      UPDATE approval_effects
      SET status = 'running',
          attempt_count = attempt_count + 1,
          claimed_by = @workerId,
          claimed_at = @claimedAt,
          lease_expires_at = @leaseExpiresAt,
          updated_at = @updatedAt,
          last_error = NULL,
          version = version + 1
      WHERE effect_id = @effectId
        AND version = @expectedVersion
        AND (
          status = 'pending'
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
        )
    `);
    this.renewLeaseStmt = db.prepare(`
      UPDATE approval_effects
      SET lease_expires_at = @leaseExpiresAt,
          updated_at = @updatedAt,
          version = version + 1
      WHERE effect_id = @effectId
        AND status = 'running'
        AND claimed_by = @workerId
    `);
    this.completeEffectStmt = db.prepare(`
      UPDATE approval_effects
      SET status = 'completed',
          result_json = @resultJson,
          last_error = NULL,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          updated_at = @updatedAt,
          completed_at = @completedAt,
          version = version + 1
      WHERE effect_id = @effectId
        AND status = 'running'
        AND claimed_by = @workerId
    `);
    this.skipEffectStmt = db.prepare(`
      UPDATE approval_effects
      SET status = 'skipped',
          result_json = @resultJson,
          last_error = NULL,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          updated_at = @updatedAt,
          completed_at = @completedAt,
          version = version + 1
      WHERE effect_id = @effectId
        AND status = 'running'
        AND claimed_by = @workerId
    `);
    this.failEffectStmt = db.prepare(`
      UPDATE approval_effects
      SET status = 'failed',
          result_json = @resultJson,
          last_error = @lastError,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          updated_at = @updatedAt,
          completed_at = @completedAt,
          version = version + 1
      WHERE effect_id = @effectId
        AND status = 'running'
        AND claimed_by = @workerId
    `);
    this.recoverExpiredStmt = db.prepare(`
      UPDATE approval_effects
      SET status = 'pending',
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          updated_at = @updatedAt,
          version = version + 1
      WHERE effect_id = @effectId
        AND version = @expectedVersion
        AND status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= @now
    `);
  }

  public get(effectId: string): ApprovalEffectRecord {
    const row = this.getByIdStmt.get(effectId) as ApprovalEffectRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "approval effect", id: effectId });
    }
    return mapApprovalEffectRow(row);
  }

  public getByIdempotencyKey(idempotencyKey: string): ApprovalEffectRecord | undefined {
    const row = this.getByIdempotencyKeyStmt.get(idempotencyKey) as ApprovalEffectRow | undefined;
    return row ? mapApprovalEffectRow(row) : undefined;
  }

  public getByTarget(
    approvalId: string,
    effectKind: ApprovalEffectKind,
    targetKind: ApprovalEffectTargetKind,
    targetId: string,
  ): ApprovalEffectRecord | undefined {
    const row = this.getByTargetStmt.get(approvalId, effectKind, targetKind, targetId) as ApprovalEffectRow | undefined;
    return row ? mapApprovalEffectRow(row) : undefined;
  }

  public listByApproval(approvalId: string): ApprovalEffectRecord[] {
    const rows = this.listByApprovalStmt.all(approvalId) as ApprovalEffectRow[];
    return rows.map(mapApprovalEffectRow);
  }

  public upsert(input: {
    approvalId: string;
    effectKind: ApprovalEffectKind;
    targetKind: ApprovalEffectTargetKind;
    targetId: string;
    idempotencyKey?: string;
    status?: ApprovalEffectStatus;
    attemptCount?: number;
    payload?: Record<string, unknown>;
    result?: Record<string, unknown>;
    lastError?: string;
    claimedBy?: string;
    claimedAt?: string;
    leaseExpiresAt?: string;
    version?: number;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
  }): ApprovalEffectRecord {
    const idempotencyKey = input.idempotencyKey ?? buildApprovalEffectIdempotencyKey(input);
    const existing = this.getByIdempotencyKey(idempotencyKey);
    const createdAt = input.createdAt ?? existing?.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;
    this.upsertStmt.run({
      effectId: existing?.effectId ?? randomUUID(),
      approvalId: input.approvalId,
      effectKind: input.effectKind,
      targetKind: input.targetKind,
      targetId: input.targetId,
      idempotencyKey,
      status: input.status ?? existing?.status ?? "pending",
      attemptCount: input.attemptCount ?? existing?.attemptCount ?? 0,
      payloadJson: JSON.stringify(input.payload ?? existing?.payload ?? {}),
      resultJson: JSON.stringify(input.result ?? existing?.result ?? {}),
      lastError: input.lastError ?? existing?.lastError ?? null,
      claimedBy: input.claimedBy ?? existing?.claimedBy ?? null,
      claimedAt: input.claimedAt ?? existing?.claimedAt ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? existing?.leaseExpiresAt ?? null,
      version: input.version ?? existing?.version ?? 1,
      createdAt,
      updatedAt,
      completedAt: input.completedAt ?? existing?.completedAt ?? null,
    });
    return this.getByIdempotencyKey(idempotencyKey) as ApprovalEffectRecord;
  }

  public claimNextPendingEffect(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit = 25,
  ): ApprovalEffectRecord | undefined {
    const candidates = this.claimCandidatesStmt.all({
      now,
      limit: Math.max(1, limit),
    }) as ApprovalEffectRow[];
    for (const candidate of candidates) {
      const update = this.claimEffectStmt.run({
        effectId: candidate.effect_id,
        workerId,
        claimedAt: now,
        leaseExpiresAt,
        updatedAt: now,
        expectedVersion: Number(candidate.version ?? 1),
        now,
      });
      if (Number(update.changes ?? 0) > 0) {
        return this.get(candidate.effect_id);
      }
    }
    return undefined;
  }

  public renewEffectLease(
    effectId: string,
    workerId: string,
    _expectedVersion: number,
    now: string,
    leaseExpiresAt: string,
  ): ApprovalEffectRecord | undefined {
    const update = this.renewLeaseStmt.run({
      effectId,
      workerId,
      leaseExpiresAt,
      updatedAt: now,
    });
    return Number(update.changes ?? 0) > 0 ? this.get(effectId) : undefined;
  }

  public completeEffect(
    effectId: string,
    workerId: string,
    _expectedVersion: number,
    input: {
      result?: Record<string, unknown>;
      updatedAt?: string;
      completedAt?: string;
    },
  ): ApprovalEffectRecord | undefined {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const completedAt = input.completedAt ?? updatedAt;
    const update = this.completeEffectStmt.run({
      effectId,
      workerId,
      resultJson: JSON.stringify(input.result ?? {}),
      updatedAt,
      completedAt,
    });
    return Number(update.changes ?? 0) > 0 ? this.get(effectId) : undefined;
  }

  public skipEffect(
    effectId: string,
    workerId: string,
    _expectedVersion: number,
    input: {
      result?: Record<string, unknown>;
      updatedAt?: string;
      completedAt?: string;
    },
  ): ApprovalEffectRecord | undefined {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const completedAt = input.completedAt ?? updatedAt;
    const update = this.skipEffectStmt.run({
      effectId,
      workerId,
      resultJson: JSON.stringify(input.result ?? {}),
      updatedAt,
      completedAt,
    });
    return Number(update.changes ?? 0) > 0 ? this.get(effectId) : undefined;
  }

  public failEffect(
    effectId: string,
    workerId: string,
    _expectedVersion: number,
    input: {
      result?: Record<string, unknown>;
      lastError: string;
      updatedAt?: string;
      completedAt?: string;
    },
  ): ApprovalEffectRecord | undefined {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const completedAt = input.completedAt ?? updatedAt;
    const update = this.failEffectStmt.run({
      effectId,
      workerId,
      resultJson: JSON.stringify(input.result ?? {}),
      lastError: input.lastError,
      updatedAt,
      completedAt,
    });
    return Number(update.changes ?? 0) > 0 ? this.get(effectId) : undefined;
  }

  public recoverExpiredEffect(
    effectId: string,
    expectedVersion: number,
    now: string,
  ): ApprovalEffectRecord | undefined {
    const update = this.recoverExpiredStmt.run({
      effectId,
      expectedVersion,
      now,
      updatedAt: now,
    });
    return Number(update.changes ?? 0) > 0 ? this.get(effectId) : undefined;
  }
}

export function buildApprovalEffectIdempotencyKey(input: {
  approvalId: string;
  effectKind: ApprovalEffectKind;
  targetKind: ApprovalEffectTargetKind;
  targetId: string;
}): string {
  return `${input.approvalId}:${input.effectKind}:${input.targetKind}:${input.targetId}`;
}

function mapApprovalEffectRow(row: ApprovalEffectRow): ApprovalEffectRecord {
  const effectKind = row.effect_kind === "wake_durable_run" ? "approval_wait_wake" : row.effect_kind;
  const targetKind = row.target_kind ?? "durable_run";
  const legacyResult = row.result_json
    ? safeJsonParse<Record<string, unknown>>(row.result_json, {})
    : mergeLegacyWakeResult(row.outcome, row.detail, row.details_json);
  const payload = safeJsonParse<Record<string, unknown>>(row.payload_json ?? "{}", {});
  return {
    effectId: row.effect_id,
    approvalId: row.approval_id,
    effectKind,
    targetKind,
    targetId: row.target_id,
    idempotencyKey:
      row.idempotency_key ??
      buildApprovalEffectIdempotencyKey({
        approvalId: row.approval_id,
        effectKind,
        targetKind,
        targetId: row.target_id,
      }),
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    payload,
    result: legacyResult,
    lastError: row.last_error ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function mergeLegacyWakeResult(
  outcome: string | null,
  detail: string | null,
  detailsJson: string | null,
): Record<string, unknown> {
  const details = safeJsonParse<Record<string, unknown>>(detailsJson ?? "{}", {});
  if (outcome) {
    details.outcome = outcome;
  }
  if (detail) {
    details.detail = detail;
  }
  return details;
}

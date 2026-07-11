import { randomUUID } from "node:crypto";
import type {
  ApprovalEffectKind,
  ApprovalEffectRecord,
  ApprovalEffectStatus,
  ApprovalEffectTargetKind,
  ApprovalObservabilityAttribution,
  ApprovalObservabilityDelivery,
  ApprovalObservabilityEnvelope,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
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
  private readonly lockApprovalForObservabilityStmt;
  private readonly upsertStmt;
  private readonly claimCandidatesStmt;
  private readonly claimObservabilityCandidatesStmt;
  private readonly claimEffectStmt;
  private readonly renewLeaseStmt;
  private readonly deferEffectStmt;
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
    this.lockApprovalForObservabilityStmt =
      db.dialect === "postgres"
        ? db.prepare(`
            SELECT approval_id
            FROM approvals
            WHERE approval_id = ?
            FOR UPDATE
          `)
        : undefined;
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
      ON CONFLICT(idempotency_key) DO NOTHING
    `);
    this.claimCandidatesStmt = db.prepare(`
      SELECT *
      FROM approval_effects
      WHERE (
          status = 'pending'
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
        )
        AND effect_kind <> 'approval_observability'
      ORDER BY
        CASE effect_kind
          WHEN 'approval_wait_materialize' THEN 0
          WHEN 'approval_resolution_signals' THEN 1
          WHEN 'pending_action_execute' THEN 2
          WHEN 'approval_wait_wake' THEN 3
          WHEN 'proactive_run_wake' THEN 4
          WHEN 'linked_chat_turn_wake' THEN 5
          WHEN 'orchestration_parent_wake' THEN 6
          ELSE 7
        END ASC,
        created_at ASC,
        effect_id ASC
      LIMIT @limit
    `);
    this.claimObservabilityCandidatesStmt = db.prepare(`
      SELECT *
      FROM approval_effects
      WHERE (
          status = 'pending'
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now)
        )
        AND effect_kind = 'approval_observability'
      ORDER BY created_at ASC, effect_id ASC
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
    this.deferEffectStmt = db.prepare(`
      UPDATE approval_effects
      SET result_json = @resultJson,
          last_error = @lastError,
          lease_expires_at = @leaseExpiresAt,
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
    const persisted = this.getByIdempotencyKey(idempotencyKey) as ApprovalEffectRecord;
    assertApprovalEffectIdempotencyMatch(persisted, {
      approvalId: input.approvalId,
      effectKind: input.effectKind,
      targetKind: input.targetKind,
      targetId: input.targetId,
      payload: input.payload ?? existing?.payload ?? {},
    });
    return persisted;
  }

  public upsertObservabilityBatch(input: {
    approvalId: string;
    occurredAt: string;
    attribution?: ApprovalObservabilityAttribution;
    items: readonly {
      operationId: string;
      delivery: ApprovalObservabilityDelivery;
    }[];
  }): ApprovalEffectRecord[] {
    return this.db.transaction("immediate", () => {
      if (this.lockApprovalForObservabilityStmt) {
        const locked = this.lockApprovalForObservabilityStmt.get(input.approvalId);
        if (!locked) {
          throw new NotFoundError({ entity: "approval", id: input.approvalId });
        }
      }

      const latestEntry = this.listByApproval(input.approvalId)
        .filter((effect) => effect.effectKind === "approval_observability")
        .map((effect) => ({ effect, envelope: readStoredApprovalObservabilityEnvelope(effect.payload) }))
        .filter((entry): entry is { effect: ApprovalEffectRecord; envelope: ApprovalObservabilityEnvelope } =>
          Boolean(entry.envelope),
        )
        .sort((left, right) => left.envelope.orderIndex - right.envelope.orderIndex)
        .at(-1);
      const latestEnvelope = latestEntry?.envelope;
      let orderIndex = (latestEnvelope?.orderIndex ?? 0) + 1;
      let predecessorDeliveryId = latestEnvelope?.deliveryId;
      const occurredAtMs = Date.parse(input.occurredAt);
      const latestCreatedAtMs = latestEntry ? Date.parse(latestEntry.effect.createdAt) : Number.NaN;
      let nextCreatedAtMs = Math.max(
        Number.isFinite(occurredAtMs) ? occurredAtMs : Date.now(),
        Number.isFinite(latestCreatedAtMs) ? latestCreatedAtMs + 1 : Number.NEGATIVE_INFINITY,
      );
      const effects: ApprovalEffectRecord[] = [];

      for (const item of input.items) {
        const deliveryId = buildApprovalObservabilityDeliveryId(input.approvalId, item.operationId);
        const existing = this.getByIdempotencyKey(deliveryId);
        const existingEnvelope = existing ? readStoredApprovalObservabilityEnvelope(existing.payload) : undefined;
        const envelope: ApprovalObservabilityEnvelope = existingEnvelope
          ? { ...existingEnvelope, delivery: item.delivery }
          : {
              schemaVersion: "approval_observability.v1",
              deliveryId,
              operationId: item.operationId,
              occurredAt: input.occurredAt,
              orderIndex,
              ...(predecessorDeliveryId ? { predecessorDeliveryId } : {}),
              ...(input.attribution ? { attribution: input.attribution } : {}),
              delivery: item.delivery,
            };
        const createdAt = new Date(nextCreatedAtMs).toISOString();
        effects.push(
          this.upsert({
            approvalId: input.approvalId,
            effectKind: "approval_observability",
            targetKind: "approval",
            targetId: item.operationId,
            idempotencyKey: deliveryId,
            payload: envelope as unknown as Record<string, unknown>,
            ...(!existingEnvelope ? { createdAt, updatedAt: createdAt } : {}),
          }),
        );
        if (!existingEnvelope) {
          predecessorDeliveryId = deliveryId;
          orderIndex += 1;
          nextCreatedAtMs += 1;
        }
      }

      return effects;
    });
  }

  public claimNextPendingEffect(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit = 25,
  ): ApprovalEffectRecord | undefined {
    return this.claimNextEffectFrom(this.claimCandidatesStmt, workerId, now, leaseExpiresAt, limit);
  }

  public claimNextPendingObservabilityEffect(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit = 25,
  ): ApprovalEffectRecord | undefined {
    return this.claimNextEffectFrom(this.claimObservabilityCandidatesStmt, workerId, now, leaseExpiresAt, limit);
  }

  private claimNextEffectFrom(
    candidatesStmt: { all(...params: unknown[]): unknown[] },
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ): ApprovalEffectRecord | undefined {
    const candidates = candidatesStmt.all({
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

  public deferEffectForRetry(
    effectId: string,
    workerId: string,
    _expectedVersion: number,
    input: {
      result: Record<string, unknown>;
      lastError: string;
      retryAt: string;
      updatedAt?: string;
    },
  ): ApprovalEffectRecord | undefined {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const update = this.deferEffectStmt.run({
      effectId,
      workerId,
      resultJson: JSON.stringify(input.result),
      lastError: input.lastError,
      leaseExpiresAt: input.retryAt,
      updatedAt,
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

export function buildApprovalObservabilityDeliveryId(approvalId: string, operationId: string): string {
  return `approval-observability:${approvalId}:${operationId}`;
}

function assertApprovalEffectIdempotencyMatch(
  persisted: ApprovalEffectRecord,
  input: Pick<ApprovalEffectRecord, "approvalId" | "effectKind" | "targetKind" | "targetId" | "payload">,
): void {
  const identityMatches =
    persisted.approvalId === input.approvalId &&
    persisted.effectKind === input.effectKind &&
    persisted.targetKind === input.targetKind &&
    persisted.targetId === input.targetId;
  const payloadMatches = stableJson(persisted.payload) === stableJson(input.payload);
  if (identityMatches && payloadMatches) {
    return;
  }
  throw new ConflictError({
    code: "STATE_CONFLICT",
    message: `Approval effect idempotency payload mismatch for ${persisted.idempotencyKey}.`,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readStoredApprovalObservabilityEnvelope(
  payload: Record<string, unknown>,
): ApprovalObservabilityEnvelope | undefined {
  if (
    payload.schemaVersion !== "approval_observability.v1" ||
    typeof payload.deliveryId !== "string" ||
    !payload.deliveryId.trim() ||
    typeof payload.operationId !== "string" ||
    !payload.operationId.trim() ||
    typeof payload.occurredAt !== "string" ||
    typeof payload.orderIndex !== "number" ||
    !Number.isInteger(payload.orderIndex) ||
    payload.orderIndex < 1 ||
    !payload.delivery ||
    typeof payload.delivery !== "object" ||
    Array.isArray(payload.delivery)
  ) {
    return undefined;
  }
  return payload as unknown as ApprovalObservabilityEnvelope;
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

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { CommsSendResult } from "@goatcitadel/contracts";

interface CommsDeliveryRow {
  delivery_id: string;
  connection_id: string;
  channel_key: string;
  target: string;
  payload_hash: string;
  payload_json: string | null;
  status: "queued" | "sent" | "failed";
  delivery_status: string | null;
  idempotency_key: string | null;
  attempts: number | null;
  max_attempts: number | null;
  next_attempt_at: string | null;
  stale_after_ms: number | null;
  base_backoff_ms: number | null;
  max_backoff_ms: number | null;
  provider_msg_id: string | null;
  error: string | null;
  stale_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommsDeliveryRecord extends CommsSendResult {
  connectionId: string;
  payloadHash: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  staleAfterMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  staleReason?: string;
}

export class CommsDeliveryRepository {
  private readonly insertStmt;
  private readonly markAttemptStmt;
  private readonly markRetryingStmt;
  private readonly markSentStmt;
  private readonly markFailedStmt;
  private readonly listStmt;
  private readonly listByConnectionStmt;
  private readonly getByIdempotencyKeyStmt;
  private readonly listDueStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO comms_deliveries (
        delivery_id, connection_id, channel_key, target, payload_hash, payload_json,
        status, delivery_status, idempotency_key, attempts, max_attempts, next_attempt_at,
        stale_after_ms, base_backoff_ms, max_backoff_ms, provider_msg_id, error, stale_reason,
        created_at, updated_at
      ) VALUES (
        @deliveryId, @connectionId, @channelKey, @target, @payloadHash, @payloadJson,
        @status, @deliveryStatus, @idempotencyKey, @attempts, @maxAttempts, @nextAttemptAt,
        @staleAfterMs, @baseBackoffMs, @maxBackoffMs, @providerMsgId, @error, @staleReason,
        @createdAt, @updatedAt
      )
    `);
    this.markAttemptStmt = db.prepare(`
      UPDATE comms_deliveries
      SET status = 'queued',
          attempts = @attempts,
          delivery_status = 'retrying',
          error = NULL,
          stale_reason = NULL,
          updated_at = @updatedAt
      WHERE delivery_id = @deliveryId
    `);
    this.markRetryingStmt = db.prepare(`
      UPDATE comms_deliveries
      SET status = 'queued',
          delivery_status = 'retrying',
          attempts = @attempts,
          next_attempt_at = @nextAttemptAt,
          error = @error,
          stale_reason = NULL,
          updated_at = @updatedAt
      WHERE delivery_id = @deliveryId
    `);
    this.markSentStmt = db.prepare(`
      UPDATE comms_deliveries
      SET status = 'sent',
          delivery_status = 'sent',
          provider_msg_id = @providerMsgId,
          error = NULL,
          stale_reason = NULL,
          next_attempt_at = NULL,
          updated_at = @updatedAt
      WHERE delivery_id = @deliveryId
    `);
    this.markFailedStmt = db.prepare(`
      UPDATE comms_deliveries
      SET status = 'failed',
          delivery_status = @deliveryStatus,
          provider_msg_id = NULL,
          error = @error,
          stale_reason = @staleReason,
          next_attempt_at = NULL,
          updated_at = @updatedAt
      WHERE delivery_id = @deliveryId
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM comms_deliveries
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByConnectionStmt = db.prepare(`
      SELECT * FROM comms_deliveries
      WHERE connection_id = @connectionId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.getByIdempotencyKeyStmt = db.prepare(`
      SELECT * FROM comms_deliveries
      WHERE idempotency_key = @idempotencyKey
      LIMIT 1
    `);
    this.listDueStmt = db.prepare(`
      SELECT * FROM comms_deliveries
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
      ORDER BY created_at ASC
      LIMIT @limit
    `);
  }

  public createQueued(
    input: {
      connectionId: string;
      channelKey: string;
      target: string;
      payload: Record<string, unknown>;
      idempotencyKey?: string;
      maxAttempts?: number;
      staleAfterMs?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
    },
    now = new Date().toISOString(),
  ): CommsDeliveryRecord {
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return existing;
      }
    }
    const deliveryId = randomUUID();
    const payloadJson = JSON.stringify(input.payload);
    const payloadHash = fingerprintPayload(input.payload);
    this.insertStmt.run({
      deliveryId,
      connectionId: input.connectionId,
      channelKey: input.channelKey,
      target: input.target,
      payloadHash,
      payloadJson,
      status: "queued",
      deliveryStatus: "retrying",
      idempotencyKey: input.idempotencyKey ?? null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      nextAttemptAt: null,
      staleAfterMs: input.staleAfterMs ?? null,
      baseBackoffMs: input.baseBackoffMs ?? null,
      maxBackoffMs: input.maxBackoffMs ?? null,
      providerMsgId: null,
      error: null,
      staleReason: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      deliveryId,
      connectionId: input.connectionId,
      status: "queued",
      channelKey: input.channelKey,
      target: input.target,
      payloadHash,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      deliveryStatus: "retrying",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      staleAfterMs: input.staleAfterMs,
      baseBackoffMs: input.baseBackoffMs,
      maxBackoffMs: input.maxBackoffMs,
      createdAt: now,
      updatedAt: now,
    };
  }

  public markAttempt(deliveryId: string, attempts: number, updatedAt = new Date().toISOString()): void {
    this.markAttemptStmt.run({ deliveryId, attempts, updatedAt });
  }

  public markRetrying(
    deliveryId: string,
    input: { attempts: number; error: string; nextAttemptAt: string },
    updatedAt = new Date().toISOString(),
  ): void {
    this.markRetryingStmt.run({
      deliveryId,
      attempts: input.attempts,
      error: input.error,
      nextAttemptAt: input.nextAttemptAt,
      updatedAt,
    });
  }

  public markSent(deliveryId: string, providerMessageId?: string, updatedAt = new Date().toISOString()): void {
    this.markSentStmt.run({
      deliveryId,
      providerMsgId: providerMessageId ?? null,
      updatedAt,
    });
  }

  public markFailed(
    deliveryId: string,
    error: string,
    updatedAt = new Date().toISOString(),
    deliveryStatus = "degraded",
    staleReason?: string,
  ): void {
    this.markFailedStmt.run({
      deliveryId,
      deliveryStatus,
      error,
      staleReason: staleReason ?? null,
      updatedAt,
    });
  }

  public findByIdempotencyKey(idempotencyKey: string): CommsDeliveryRecord | undefined {
    const row = this.getByIdempotencyKeyStmt.get({ idempotencyKey }) as unknown;
    return isCommsDeliveryRow(row) ? toCommsDeliveryRecord(row) : undefined;
  }

  public listDue(now = new Date().toISOString(), limit = 25): CommsDeliveryRecord[] {
    const rows = toCommsDeliveryRows(
      this.listDueStmt.all({
        now,
        limit,
      }),
    );
    return rows.map(toCommsDeliveryRecord);
  }

  public list(connectionId?: string, limit = 200): CommsDeliveryRecord[] {
    const rows = toCommsDeliveryRows(
      connectionId
        ? this.listByConnectionStmt.all({
            connectionId,
            limit,
          })
        : this.listStmt.all({
            limit,
          }),
    );
    return rows.map(toCommsDeliveryRecord);
  }
}

function toCommsDeliveryRows(value: unknown): CommsDeliveryRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isCommsDeliveryRow);
}

function isCommsDeliveryRow(value: unknown): value is CommsDeliveryRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.delivery_id === "string" &&
    typeof value.connection_id === "string" &&
    typeof value.channel_key === "string" &&
    typeof value.target === "string" &&
    typeof value.payload_hash === "string" &&
    (typeof value.payload_json === "string" || value.payload_json === null || value.payload_json === undefined) &&
    typeof value.status === "string" &&
    (typeof value.delivery_status === "string" ||
      value.delivery_status === null ||
      value.delivery_status === undefined) &&
    (typeof value.idempotency_key === "string" ||
      value.idempotency_key === null ||
      value.idempotency_key === undefined) &&
    (typeof value.attempts === "number" || value.attempts === null || value.attempts === undefined) &&
    (typeof value.max_attempts === "number" || value.max_attempts === null || value.max_attempts === undefined) &&
    (typeof value.next_attempt_at === "string" ||
      value.next_attempt_at === null ||
      value.next_attempt_at === undefined) &&
    (typeof value.stale_after_ms === "number" || value.stale_after_ms === null || value.stale_after_ms === undefined) &&
    (typeof value.base_backoff_ms === "number" ||
      value.base_backoff_ms === null ||
      value.base_backoff_ms === undefined) &&
    (typeof value.max_backoff_ms === "number" || value.max_backoff_ms === null || value.max_backoff_ms === undefined) &&
    (typeof value.provider_msg_id === "string" || value.provider_msg_id === null) &&
    (typeof value.error === "string" || value.error === null) &&
    (typeof value.stale_reason === "string" || value.stale_reason === null || value.stale_reason === undefined) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function toCommsDeliveryRecord(row: CommsDeliveryRow): CommsDeliveryRecord {
  return {
    deliveryId: row.delivery_id,
    connectionId: row.connection_id,
    status: row.status,
    deliveryStatus: isCommsDeliveryStatus(row.delivery_status) ? row.delivery_status : undefined,
    providerMessageId: row.provider_msg_id ?? undefined,
    channelKey: row.channel_key,
    target: row.target,
    payloadHash: row.payload_hash,
    payload: parsePayload(row.payload_json),
    idempotencyKey: row.idempotency_key ?? undefined,
    attempts: row.attempts ?? 0,
    maxAttempts: row.max_attempts ?? 3,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    staleAfterMs: row.stale_after_ms ?? undefined,
    baseBackoffMs: row.base_backoff_ms ?? undefined,
    maxBackoffMs: row.max_backoff_ms ?? undefined,
    error: row.error ?? undefined,
    staleReason: row.stale_reason ?? undefined,
    fallbackReason: row.error ?? row.stale_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePayload(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isCommsDeliveryStatus(value: string | null): value is NonNullable<CommsSendResult["deliveryStatus"]> {
  return (
    value === "sent" ||
    value === "retrying" ||
    value === "degraded" ||
    value === "blocked" ||
    value === "not_available" ||
    value === "manual_reconciliation_required"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fingerprintPayload(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(sortValue(payload)))
    .digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

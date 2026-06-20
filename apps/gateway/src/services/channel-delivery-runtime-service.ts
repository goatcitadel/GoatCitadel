import { createHash } from "node:crypto";
import type { ChannelDeliveryDiagnostics, ChannelDeliveryStatus, CommsSendResult } from "@goatcitadel/contracts";
import { planChannelTextDelivery, type ChannelDeliveryRichFormat } from "@goatcitadel/gateway-core";

export type ChannelDeliveryRuntimeStatus = "queued" | "running" | "retrying" | "sent" | "failed" | "stale";

export interface ChannelDeliveryRuntimeRecord {
  deliveryId: string;
  connectionId: string;
  channelKey: string;
  target: string;
  status: ChannelDeliveryRuntimeStatus;
  deliveryStatus?: ChannelDeliveryStatus;
  idempotencyKey?: string;
  payloadHash?: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  staleReason?: string;
  providerMessageId?: string;
  error?: string;
  fallbackReason?: string;
  deliveryDiagnostics?: ChannelDeliveryDiagnostics;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelDeliveryRuntimeRepository {
  createQueued(
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
    now?: string,
  ): CommsSendResult & {
    connectionId?: string;
    payloadHash?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
    attempts?: number;
    maxAttempts?: number;
    nextAttemptAt?: string;
    staleAfterMs?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    staleReason?: string;
    deliveryDiagnostics?: ChannelDeliveryDiagnostics;
  };
  findByIdempotencyKey?(idempotencyKey: string):
    | (CommsSendResult & {
        connectionId?: string;
        payloadHash?: string;
        payload?: Record<string, unknown>;
        idempotencyKey?: string;
        attempts?: number;
        maxAttempts?: number;
        nextAttemptAt?: string;
        staleAfterMs?: number;
        baseBackoffMs?: number;
        maxBackoffMs?: number;
        staleReason?: string;
        deliveryDiagnostics?: ChannelDeliveryDiagnostics;
      })
    | undefined;
  listDue?(
    now?: string,
    limit?: number,
  ): Array<
    CommsSendResult & {
      connectionId?: string;
      payloadHash?: string;
      payload?: Record<string, unknown>;
      idempotencyKey?: string;
      attempts?: number;
      maxAttempts?: number;
      nextAttemptAt?: string;
      staleAfterMs?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
      staleReason?: string;
      deliveryDiagnostics?: ChannelDeliveryDiagnostics;
    }
  >;
  markAttempt?(deliveryId: string, attempts: number, updatedAt?: string): void;
  markRetrying?(
    deliveryId: string,
    input: { attempts: number; error: string; nextAttemptAt: string },
    updatedAt?: string,
  ): void;
  markSent(deliveryId: string, providerMessageId?: string, updatedAt?: string): void;
  markFailed(
    deliveryId: string,
    error: string,
    updatedAt?: string,
    deliveryStatus?: string,
    staleReason?: string,
  ): void;
}

export interface ChannelDeliveryRuntimeEnqueueInput {
  connectionId: string;
  channelKey: string;
  target: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  staleAfterMs?: number;
}

export interface ChannelDeliveryRuntimeSendInput extends ChannelDeliveryRuntimeRecord {
  payload: Record<string, unknown>;
}

export interface ChannelDeliveryRuntimeSendResult {
  providerMessageId?: string;
  providerMessageIds?: string[];
  deliveryDiagnostics?: ChannelDeliveryDiagnostics;
}

interface QueuedRuntimeDelivery {
  record: ChannelDeliveryRuntimeRecord;
  payload: Record<string, unknown>;
  payloadFingerprint: string;
  baseBackoffMs: number;
  maxBackoffMs: number;
  staleAfterMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 120_000;
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

export class ChannelDeliveryRuntimeService {
  private readonly deliveries = new Map<string, QueuedRuntimeDelivery>();
  private readonly idempotencyIndex = new Map<string, string>();

  public constructor(
    private readonly deps: {
      repository: ChannelDeliveryRuntimeRepository;
      send: (input: ChannelDeliveryRuntimeSendInput) => Promise<ChannelDeliveryRuntimeSendResult>;
      now?: () => Date;
    },
  ) {}

  public enqueue(input: ChannelDeliveryRuntimeEnqueueInput): ChannelDeliveryRuntimeRecord {
    const now = this.now();
    const plannedPayload = applyChannelDeliveryPlan(input.channelKey, input.payload);
    const payloadFingerprint = fingerprintPayload(plannedPayload);
    const idempotencyKey = input.idempotencyKey?.trim() || undefined;
    if (idempotencyKey) {
      const existingId = this.idempotencyIndex.get(idempotencyKey);
      const existing = existingId ? this.deliveries.get(existingId) : undefined;
      if (existing) {
        if (existing.payloadFingerprint !== payloadFingerprint) {
          throw new Error(`Delivery idempotency key ${idempotencyKey} was reused with a different payload.`);
        }
        return copyRecord(existing.record);
      }
      const persisted = this.deps.repository.findByIdempotencyKey?.(idempotencyKey);
      if (persisted) {
        if (persisted.payloadHash && persisted.payloadHash !== payloadFingerprint) {
          throw new Error(`Delivery idempotency key ${idempotencyKey} was reused with a different payload.`);
        }
        const hydrated = this.hydratePersistedDelivery(persisted, plannedPayload, payloadFingerprint);
        return copyRecord(hydrated.record);
      }
    }

    const queued = this.deps.repository.createQueued(
      {
        connectionId: input.connectionId,
        channelKey: input.channelKey,
        target: input.target,
        payload: plannedPayload,
        idempotencyKey,
        maxAttempts: Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
        staleAfterMs: Math.max(1, input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
        baseBackoffMs: Math.max(1, input.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS),
        maxBackoffMs: Math.max(1, input.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
      },
      now,
    );
    const record: ChannelDeliveryRuntimeRecord = {
      deliveryId: queued.deliveryId,
      connectionId: input.connectionId,
      channelKey: input.channelKey,
      target: input.target,
      status: "queued",
      idempotencyKey,
      payloadHash: queued.payloadHash ?? payloadFingerprint,
      attempts: queued.attempts ?? 0,
      maxAttempts: Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      nextAttemptAt: queued.nextAttemptAt,
      deliveryDiagnostics: queued.deliveryDiagnostics ?? readDeliveryDiagnostics(plannedPayload.deliveryDiagnostics),
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
    };
    this.deliveries.set(record.deliveryId, {
      record,
      payload: plannedPayload,
      payloadFingerprint,
      baseBackoffMs: Math.max(1, input.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS),
      maxBackoffMs: Math.max(1, input.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
      staleAfterMs: Math.max(1, input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    });
    if (idempotencyKey) {
      this.idempotencyIndex.set(idempotencyKey, record.deliveryId);
    }
    return copyRecord(record);
  }

  public get(deliveryId: string): ChannelDeliveryRuntimeRecord | undefined {
    const delivery = this.deliveries.get(deliveryId);
    return delivery ? copyRecord(delivery.record) : undefined;
  }

  public list(): ChannelDeliveryRuntimeRecord[] {
    return [...this.deliveries.values()].map((item) => copyRecord(item.record));
  }

  public markStaleDeliveries(): ChannelDeliveryRuntimeRecord[] {
    const now = this.now();
    const stale: ChannelDeliveryRuntimeRecord[] = [];
    for (const delivery of this.deliveries.values()) {
      if (!isActiveStatus(delivery.record.status) || !isStale(delivery, now)) {
        continue;
      }
      this.markFailed(delivery, "stale", "Delivery became stale before it could be sent.", now);
      stale.push(copyRecord(delivery.record));
    }
    return stale;
  }

  public async drainDue(limit = 25): Promise<ChannelDeliveryRuntimeRecord[]> {
    const now = this.now();
    this.hydrateDueDeliveries(now, limit);
    const due = [...this.deliveries.values()]
      .filter((delivery) => isActiveStatus(delivery.record.status))
      .filter(
        (delivery) => !delivery.record.nextAttemptAt || Date.parse(delivery.record.nextAttemptAt) <= Date.parse(now),
      )
      .sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt))
      .slice(0, Math.max(1, limit));
    const results: ChannelDeliveryRuntimeRecord[] = [];
    for (const delivery of due) {
      results.push(await this.processDelivery(delivery));
    }
    return results;
  }

  private hydrateDueDeliveries(now: string, limit: number): void {
    const persisted = this.deps.repository.listDue?.(now, limit) ?? [];
    for (const record of persisted) {
      if (this.deliveries.has(record.deliveryId) || !record.payload) {
        continue;
      }
      this.hydratePersistedDelivery(record, record.payload, record.payloadHash ?? fingerprintPayload(record.payload));
    }
  }

  private hydratePersistedDelivery(
    persisted: CommsSendResult & {
      connectionId?: string;
      payloadHash?: string;
      payload?: Record<string, unknown>;
      idempotencyKey?: string;
      attempts?: number;
      maxAttempts?: number;
      nextAttemptAt?: string;
      staleAfterMs?: number;
      baseBackoffMs?: number;
      maxBackoffMs?: number;
      staleReason?: string;
    },
    payload: Record<string, unknown>,
    payloadFingerprint: string,
  ): QueuedRuntimeDelivery {
    const record: ChannelDeliveryRuntimeRecord = {
      deliveryId: persisted.deliveryId,
      connectionId: persisted.connectionId ?? "",
      channelKey: persisted.channelKey,
      target: persisted.target,
      status: mapPersistedStatus(persisted.status, persisted.deliveryStatus),
      deliveryStatus: persisted.deliveryStatus,
      idempotencyKey: persisted.idempotencyKey,
      payloadHash: persisted.payloadHash ?? payloadFingerprint,
      attempts: persisted.attempts ?? 0,
      maxAttempts: Math.max(1, persisted.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      nextAttemptAt: persisted.nextAttemptAt,
      staleReason: persisted.staleReason,
      providerMessageId: persisted.providerMessageId,
      error: persisted.error,
      fallbackReason: persisted.fallbackReason,
      deliveryDiagnostics: persisted.deliveryDiagnostics ?? readDeliveryDiagnostics(payload.deliveryDiagnostics),
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
    };
    const delivery = {
      record,
      payload,
      payloadFingerprint,
      baseBackoffMs: Math.max(1, persisted.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS),
      maxBackoffMs: Math.max(1, persisted.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
      staleAfterMs: Math.max(1, persisted.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    };
    this.deliveries.set(record.deliveryId, delivery);
    if (record.idempotencyKey) {
      this.idempotencyIndex.set(record.idempotencyKey, record.deliveryId);
    }
    return delivery;
  }

  private async processDelivery(delivery: QueuedRuntimeDelivery): Promise<ChannelDeliveryRuntimeRecord> {
    const startedAt = this.now();
    if (isStale(delivery, startedAt)) {
      this.markFailed(delivery, "stale", "Delivery became stale before it could be sent.", startedAt);
      return copyRecord(delivery.record);
    }
    delivery.record.status = "running";
    delivery.record.attempts += 1;
    delivery.record.updatedAt = startedAt;
    this.deps.repository.markAttempt?.(delivery.record.deliveryId, delivery.record.attempts, startedAt);
    try {
      const result = await this.deps.send({ ...copyRecord(delivery.record), payload: delivery.payload });
      const completedAt = this.now();
      delivery.record.status = "sent";
      delivery.record.deliveryStatus = "sent";
      delivery.record.providerMessageId = result.providerMessageId;
      delivery.record.deliveryDiagnostics = result.deliveryDiagnostics ?? delivery.record.deliveryDiagnostics;
      delivery.record.error = undefined;
      delivery.record.fallbackReason = undefined;
      delivery.record.nextAttemptAt = undefined;
      delivery.record.updatedAt = completedAt;
      this.deps.repository.markSent(delivery.record.deliveryId, result.providerMessageId, completedAt);
    } catch (error) {
      this.handleDeliveryFailure(delivery, error);
    }
    return copyRecord(delivery.record);
  }

  private handleDeliveryFailure(delivery: QueuedRuntimeDelivery, error: unknown): void {
    const now = this.now();
    const message = error instanceof Error ? error.message : String(error);
    const deliveryStatus = classifyChannelDeliveryFailure(message);
    const canRetry =
      delivery.record.attempts < delivery.record.maxAttempts &&
      deliveryStatus === "degraded" &&
      !isStale(delivery, now);
    if (!canRetry) {
      this.markFailed(delivery, deliveryStatus, message, now);
      return;
    }
    delivery.record.status = "retrying";
    delivery.record.deliveryStatus = "retrying";
    delivery.record.error = message;
    delivery.record.fallbackReason = message;
    delivery.record.nextAttemptAt = new Date(Date.parse(now) + computeBackoffMs(delivery)).toISOString();
    delivery.record.updatedAt = now;
    this.deps.repository.markRetrying?.(
      delivery.record.deliveryId,
      {
        attempts: delivery.record.attempts,
        error: message,
        nextAttemptAt: delivery.record.nextAttemptAt,
      },
      now,
    );
  }

  private markFailed(
    delivery: QueuedRuntimeDelivery,
    deliveryStatus: ChannelDeliveryStatus | "stale",
    error: string,
    now: string,
  ): void {
    delivery.record.status = deliveryStatus === "stale" ? "stale" : "failed";
    delivery.record.deliveryStatus = deliveryStatus === "stale" ? "degraded" : deliveryStatus;
    delivery.record.error = error;
    delivery.record.staleReason = deliveryStatus === "stale" ? error : undefined;
    delivery.record.fallbackReason = error;
    delivery.record.nextAttemptAt = undefined;
    delivery.record.updatedAt = now;
    this.deps.repository.markFailed(
      delivery.record.deliveryId,
      error,
      now,
      delivery.record.deliveryStatus,
      delivery.record.staleReason,
    );
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

export function classifyChannelDeliveryFailure(message: string): ChannelDeliveryStatus {
  const normalized = message.toLowerCase();
  if (
    ["408", "429", "502", "503", "504", "timeout", "temporarily", "network"].some((term) => normalized.includes(term))
  ) {
    return "degraded";
  }
  if (
    ["allowlist", "blocked", "unsafe", "forbidden", "unauthorized", "permission", "manual retry required"].some(
      (term) => normalized.includes(term),
    )
  ) {
    return "blocked";
  }
  if (
    (normalized.includes("missing") && normalized.includes("url")) ||
    ["not supported", "does not support", "unavailable", "not configured"].some((term) => normalized.includes(term))
  ) {
    return "not_available";
  }
  return "degraded";
}

function isActiveStatus(status: ChannelDeliveryRuntimeStatus): boolean {
  return status === "queued" || status === "retrying" || status === "running";
}

function isStale(delivery: QueuedRuntimeDelivery, now: string): boolean {
  return Date.parse(now) - Date.parse(delivery.record.createdAt) >= delivery.staleAfterMs;
}

function computeBackoffMs(delivery: QueuedRuntimeDelivery): number {
  const exponent = Math.max(0, delivery.record.attempts - 1);
  return Math.min(delivery.maxBackoffMs, delivery.baseBackoffMs * 2 ** exponent);
}

function mapPersistedStatus(
  status: CommsSendResult["status"],
  deliveryStatus?: ChannelDeliveryStatus,
): ChannelDeliveryRuntimeStatus {
  if (status === "sent") {
    return "sent";
  }
  if (status === "failed") {
    return "failed";
  }
  return deliveryStatus === "retrying" ? "retrying" : "queued";
}

function applyChannelDeliveryPlan(channelKey: string, payload: Record<string, unknown>): Record<string, unknown> {
  const textField = readTextPayloadField(payload);
  if (!textField) {
    return payload;
  }
  const richFormat = readRichFormat(payload);
  const plan = planChannelTextDelivery(channelKey, textField.text, { richFormat });
  const existingDiagnostics = readDeliveryDiagnostics(payload.deliveryDiagnostics);
  const diagnostics: ChannelDeliveryDiagnostics = {
    ...existingDiagnostics,
    chunking: existingDiagnostics?.chunking ?? {
      mode: plan.chunks.length > 1 ? "unicode_safe" : "none",
      originalCodePointLength: Array.from(textField.text).length,
      partCount: plan.chunks.length,
      maxPartUtf16Length: plan.maxChunkCodeUnits,
      parts: plan.chunks.map((chunk, index) => ({
        partIndex: index,
        codePointLength: Array.from(chunk).length,
        utf16Length: chunk.length,
      })),
    },
    richFormatting: existingDiagnostics?.richFormatting ?? {
      ...(richFormat ? { requestedFormat: richFormat } : {}),
      posture: plan.richFormatPosture,
      notes: plan.notes,
    },
  };
  return {
    ...payload,
    deliveryChunks: plan.chunks,
    deliveryDiagnostics: diagnostics,
  };
}

function readTextPayloadField(payload: Record<string, unknown>): { key: string; text: string } | undefined {
  for (const key of ["message", "text", "content", "body"] as const) {
    const value = payload[key];
    if (typeof value === "string") {
      return { key, text: value };
    }
  }
  return undefined;
}

function readRichFormat(payload: Record<string, unknown>): ChannelDeliveryRichFormat | undefined {
  const raw = payload.richFormat ?? payload.format ?? payload.contentFormat;
  return raw === "plain_text" || raw === "html" || raw === "markdown" || raw === "provider_native" ? raw : undefined;
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
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

function readDeliveryDiagnostics(value: unknown): ChannelDeliveryDiagnostics | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as ChannelDeliveryDiagnostics;
}

function copyRecord(record: ChannelDeliveryRuntimeRecord): ChannelDeliveryRuntimeRecord {
  return { ...record };
}

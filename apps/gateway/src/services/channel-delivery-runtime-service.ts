import { createHash } from "node:crypto";
import type {
  ChannelAttachmentInput,
  ChannelDeliveryDiagnostics,
  ChannelDeliveryStatus,
  CommsSendResult,
} from "@goatcitadel/contracts";
import {
  planChannelRichMessageDelivery,
  planChannelTextDelivery,
  type ChannelDeliveryRichFormat,
  type ChannelRichMessageDeliveryPlan,
} from "@goatcitadel/gateway-core";

export type ChannelDeliveryRuntimeStatus =
  | "queued"
  | "running"
  | "retrying"
  | "sent"
  | "failed"
  | "stale"
  | "manual_reconciliation_required";

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
  commitmentId?: string;
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
  claimAttempt?(
    deliveryId: string,
    expectedAttempts: number,
    attempts: number,
    claimExpiresAt: string,
    updatedAt?: string,
  ): boolean;
  quarantineAttempt?(
    deliveryId: string,
    expectedAttempts: number,
    expectedNextAttemptAt: string | undefined,
    error: string,
    updatedAt?: string,
  ): boolean;
  markStaleIfUnchanged?(
    deliveryId: string,
    expectedAttempts: number,
    expectedNextAttemptAt: string | undefined,
    error: string,
    updatedAt?: string,
  ): boolean;
  finalizeAttemptSent?(
    deliveryId: string,
    expectedAttempts: number,
    expectedClaimExpiresAt: string,
    providerMessageId: string | undefined,
    updatedAt?: string,
  ): boolean;
  finalizeAttemptRetrying?(
    deliveryId: string,
    expectedAttempts: number,
    expectedClaimExpiresAt: string,
    input: { error: string; nextAttemptAt: string },
    updatedAt?: string,
  ): boolean;
  finalizeAttemptFailed?(
    deliveryId: string,
    expectedAttempts: number,
    expectedClaimExpiresAt: string,
    input: {
      error: string;
      deliveryStatus: string;
      staleReason?: string;
      providerMessageId?: string;
    },
    updatedAt?: string,
  ): boolean;
  recordManualProviderOutcome?(
    deliveryId: string,
    expectedAttempts: number,
    providerMessageId: string | undefined,
    error: string,
    updatedAt?: string,
  ): boolean;
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
    providerMessageId?: string,
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
  recoveryQuarantineOnDue: boolean;
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
      onDeliverySent?: (record: ChannelDeliveryRuntimeRecord) => void;
      onDeliveryFailed?: (record: ChannelDeliveryRuntimeRecord) => void;
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
        if (hydrated) {
          return copyRecord(hydrated.record);
        }
        const refreshed = this.deps.repository.findByIdempotencyKey?.(idempotencyKey);
        if (refreshed) {
          const refreshedPayload = refreshed.payload ?? plannedPayload;
          const refreshedDelivery = this.hydratePersistedDelivery(
            refreshed,
            refreshedPayload,
            refreshed.payloadHash ?? fingerprintPayload(refreshedPayload),
          );
          if (refreshedDelivery) {
            return copyRecord(refreshedDelivery.record);
          }
        }
        throw new Error(`Delivery ${persisted.deliveryId} changed concurrently; retry the idempotent lookup.`);
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
      commitmentId: readOptionalPayloadString(plannedPayload.commitmentId),
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
      recoveryQuarantineOnDue: false,
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
      if (delivery.recoveryQuarantineOnDue) {
        if (isDue(delivery.record.nextAttemptAt, now)) {
          if (this.quarantineRecoveredDelivery(delivery, now, "in another runtime")) {
            stale.push(copyRecord(delivery.record));
          } else {
            this.evictDelivery(delivery);
          }
        }
        continue;
      }
      if (!isActiveStatus(delivery.record.status) || !isStale(delivery, now)) {
        continue;
      }
      if (this.markStaleIfCurrent(delivery, now)) {
        stale.push(copyRecord(delivery.record));
      } else {
        this.evictDelivery(delivery);
      }
    }
    return stale;
  }

  public async drainDue(limit = 25): Promise<ChannelDeliveryRuntimeRecord[]> {
    const now = this.now();
    this.hydrateDueDeliveries(now, limit);
    const due = [...this.deliveries.values()]
      .filter((delivery) => isDrainEligibleStatus(delivery.record.status))
      .filter(
        (delivery) => !delivery.record.nextAttemptAt || Date.parse(delivery.record.nextAttemptAt) <= Date.parse(now),
      )
      .sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt))
      .slice(0, Math.max(1, limit));
    const results: ChannelDeliveryRuntimeRecord[] = [];
    for (const delivery of due) {
      const result = await this.processDelivery(delivery);
      if (result) {
        results.push(result);
      }
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
  ): QueuedRuntimeDelivery | undefined {
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
      commitmentId: readOptionalPayloadString(payload.commitmentId),
      providerMessageId: persisted.providerMessageId,
      error: persisted.error,
      fallbackReason: persisted.fallbackReason,
      deliveryDiagnostics: persisted.deliveryDiagnostics ?? readDeliveryDiagnostics(payload.deliveryDiagnostics),
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
    };
    const hydratedAt = this.now();
    const recoveryQuarantineOnDue = isActiveStatus(record.status) && record.attempts > 0;
    const delivery = {
      record,
      payload,
      payloadFingerprint,
      baseBackoffMs: Math.max(1, persisted.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS),
      maxBackoffMs: Math.max(1, persisted.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
      staleAfterMs: Math.max(1, persisted.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
      recoveryQuarantineOnDue,
    };
    if (recoveryQuarantineOnDue && isDue(record.nextAttemptAt, hydratedAt)) {
      if (!this.quarantineRecoveredDelivery(delivery, hydratedAt, "before restart")) {
        return undefined;
      }
    }
    this.deliveries.set(record.deliveryId, delivery);
    if (record.idempotencyKey) {
      this.idempotencyIndex.set(record.idempotencyKey, record.deliveryId);
    }
    return delivery;
  }

  private async processDelivery(delivery: QueuedRuntimeDelivery): Promise<ChannelDeliveryRuntimeRecord | undefined> {
    const startedAt = this.now();
    if (delivery.recoveryQuarantineOnDue) {
      if (!this.quarantineRecoveredDelivery(delivery, startedAt, "in another runtime")) {
        this.evictDelivery(delivery);
        return undefined;
      }
      return copyRecord(delivery.record);
    }
    if (isStale(delivery, startedAt)) {
      if (!this.markStaleIfCurrent(delivery, startedAt)) {
        this.evictDelivery(delivery);
        return undefined;
      }
      return copyRecord(delivery.record);
    }
    const expectedAttempts = delivery.record.attempts;
    const nextAttempts = expectedAttempts + 1;
    const claimExpiresAt = new Date(Date.parse(startedAt) + delivery.staleAfterMs).toISOString();
    const claimed = this.deps.repository.claimAttempt
      ? this.deps.repository.claimAttempt(
          delivery.record.deliveryId,
          expectedAttempts,
          nextAttempts,
          claimExpiresAt,
          startedAt,
        )
      : true;
    if (!claimed) {
      this.deliveries.delete(delivery.record.deliveryId);
      if (delivery.record.idempotencyKey) {
        this.idempotencyIndex.delete(delivery.record.idempotencyKey);
      }
      return undefined;
    }
    delivery.record.status = "running";
    delivery.record.attempts = nextAttempts;
    delivery.record.nextAttemptAt = claimExpiresAt;
    delivery.record.updatedAt = startedAt;
    if (!this.deps.repository.claimAttempt) {
      this.deps.repository.markAttempt?.(delivery.record.deliveryId, delivery.record.attempts, startedAt);
    }
    let result: ChannelDeliveryRuntimeSendResult;
    try {
      result = await this.deps.send({ ...copyRecord(delivery.record), payload: delivery.payload });
    } catch (error) {
      return this.handleDeliveryFailure(delivery, error) ? copyRecord(delivery.record) : undefined;
    }

    const completedAt = this.now();
    delivery.record.providerMessageId = result.providerMessageId;
    delivery.record.deliveryDiagnostics = result.deliveryDiagnostics ?? delivery.record.deliveryDiagnostics;
    try {
      const finalized = this.deps.repository.finalizeAttemptSent
        ? this.deps.repository.finalizeAttemptSent(
            delivery.record.deliveryId,
            delivery.record.attempts,
            delivery.record.nextAttemptAt ?? "",
            result.providerMessageId,
            completedAt,
          )
        : (this.deps.repository.markSent(delivery.record.deliveryId, result.providerMessageId, completedAt), true);
      if (!finalized) {
        this.markLostClaimAfterProviderSuccess(delivery, result, completedAt);
        return copyRecord(delivery.record);
      }
      delivery.record.status = "sent";
      delivery.record.deliveryStatus = "sent";
      delivery.record.error = undefined;
      delivery.record.fallbackReason = undefined;
      delivery.record.nextAttemptAt = undefined;
      delivery.record.updatedAt = completedAt;
      if (delivery.record.commitmentId) {
        this.deps.onDeliverySent?.(copyRecord(delivery.record));
      }
    } catch (error) {
      this.markPostSendBookkeepingFailure(delivery, error, completedAt);
    }
    return copyRecord(delivery.record);
  }

  private markLostClaimAfterProviderSuccess(
    delivery: QueuedRuntimeDelivery,
    result: ChannelDeliveryRuntimeSendResult,
    now: string,
  ): void {
    const message =
      "post_send_claim_lost: provider dispatch completed after this runtime lost the durable attempt claim; " +
      "manual reconciliation is required.";
    delivery.record.providerMessageId = result.providerMessageId;
    delivery.record.deliveryDiagnostics = result.deliveryDiagnostics ?? delivery.record.deliveryDiagnostics;
    this.applyFailedRecord(delivery, "manual_reconciliation_required", message, now);
    this.deps.repository.recordManualProviderOutcome?.(
      delivery.record.deliveryId,
      delivery.record.attempts,
      result.providerMessageId,
      message,
      now,
    );
  }

  private markStaleIfCurrent(delivery: QueuedRuntimeDelivery, now: string): boolean {
    const message = "Delivery became stale before it could be sent.";
    if (this.deps.repository.markStaleIfUnchanged) {
      const marked = this.deps.repository.markStaleIfUnchanged(
        delivery.record.deliveryId,
        delivery.record.attempts,
        delivery.record.nextAttemptAt,
        message,
        now,
      );
      if (!marked) {
        return false;
      }
      this.applyFailedRecord(delivery, "stale", message, now);
      if (delivery.record.commitmentId) {
        this.notifyDeliveryFailedBestEffort(delivery.record);
      }
    } else {
      this.markFailed(delivery, "stale", message, now);
    }
    return true;
  }

  private markPostSendBookkeepingFailure(delivery: QueuedRuntimeDelivery, error: unknown, now: string): void {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `post_send_bookkeeping_failed: provider dispatch completed, but sent-state finalization failed; manual reconciliation required. ${detail}`;
    delivery.record.status = "manual_reconciliation_required";
    delivery.record.deliveryStatus = "manual_reconciliation_required";
    delivery.record.error = message;
    delivery.record.fallbackReason = message;
    delivery.record.nextAttemptAt = undefined;
    delivery.record.updatedAt = now;
    try {
      this.deps.repository.markFailed(
        delivery.record.deliveryId,
        message,
        now,
        "manual_reconciliation_required",
        undefined,
        delivery.record.providerMessageId,
      );
    } catch (persistenceError) {
      const persistenceDetail = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
      delivery.record.error = `${message} Failed to persist quarantine state: ${persistenceDetail}`;
      delivery.record.fallbackReason = delivery.record.error;
    }
    if (delivery.record.commitmentId) {
      this.notifyDeliveryFailedBestEffort(delivery.record);
    }
  }

  private quarantineRecoveredDelivery(delivery: QueuedRuntimeDelivery, now: string, boundaryContext: string): boolean {
    const message =
      `Delivery had already crossed its dispatch attempt boundary ${boundaryContext}; ` +
      "manual reconciliation is required.";
    if (this.deps.repository.quarantineAttempt) {
      const quarantined = this.deps.repository.quarantineAttempt(
        delivery.record.deliveryId,
        delivery.record.attempts,
        delivery.record.nextAttemptAt,
        message,
        now,
      );
      if (!quarantined) {
        return false;
      }
      this.applyFailedRecord(delivery, "manual_reconciliation_required", message, now);
      if (delivery.record.commitmentId) {
        this.notifyDeliveryFailedBestEffort(delivery.record);
      }
    } else {
      this.markFailed(delivery, "manual_reconciliation_required", message, now);
    }
    delivery.recoveryQuarantineOnDue = false;
    return true;
  }

  private evictDelivery(delivery: QueuedRuntimeDelivery): void {
    this.deliveries.delete(delivery.record.deliveryId);
    if (delivery.record.idempotencyKey) {
      this.idempotencyIndex.delete(delivery.record.idempotencyKey);
    }
  }

  private notifyDeliveryFailedBestEffort(record: ChannelDeliveryRuntimeRecord): void {
    try {
      this.deps.onDeliveryFailed?.(copyRecord(record));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record.error = `${record.error ?? "Delivery failed."} Failure callback also failed: ${detail}`;
      record.fallbackReason = record.error;
    }
  }

  private handleDeliveryFailure(delivery: QueuedRuntimeDelivery, error: unknown): boolean {
    const now = this.now();
    const message = error instanceof Error ? error.message : String(error);
    const providerMessageId = readStructuredProviderMessageId(error);
    if (providerMessageId) {
      delivery.record.providerMessageId = providerMessageId;
    }
    const deliveryStatus = providerMessageId ? "manual_reconciliation_required" : classifyChannelDeliveryFailure(error);
    const canRetry =
      delivery.record.attempts < delivery.record.maxAttempts &&
      deliveryStatus === "degraded" &&
      !isStale(delivery, now);
    if (!canRetry) {
      if (this.deps.repository.finalizeAttemptFailed) {
        const finalized = this.deps.repository.finalizeAttemptFailed(
          delivery.record.deliveryId,
          delivery.record.attempts,
          delivery.record.nextAttemptAt ?? "",
          {
            error: message,
            deliveryStatus,
            providerMessageId: delivery.record.providerMessageId,
          },
          now,
        );
        if (!finalized) {
          if (delivery.record.providerMessageId) {
            this.deps.repository.recordManualProviderOutcome?.(
              delivery.record.deliveryId,
              delivery.record.attempts,
              delivery.record.providerMessageId,
              message,
              now,
            );
          }
          this.evictDelivery(delivery);
          return false;
        }
        this.applyFailedRecord(delivery, deliveryStatus, message, now);
        if (delivery.record.commitmentId) {
          this.notifyDeliveryFailedBestEffort(delivery.record);
        }
      } else {
        this.markFailed(delivery, deliveryStatus, message, now);
      }
      return true;
    }
    const nextAttemptAt = new Date(Date.parse(now) + computeBackoffMs(delivery)).toISOString();
    if (this.deps.repository.finalizeAttemptRetrying) {
      const finalized = this.deps.repository.finalizeAttemptRetrying(
        delivery.record.deliveryId,
        delivery.record.attempts,
        delivery.record.nextAttemptAt ?? "",
        { error: message, nextAttemptAt },
        now,
      );
      if (!finalized) {
        this.evictDelivery(delivery);
        return false;
      }
    }
    delivery.record.status = "retrying";
    delivery.record.deliveryStatus = "retrying";
    delivery.record.error = message;
    delivery.record.fallbackReason = message;
    delivery.record.nextAttemptAt = nextAttemptAt;
    delivery.record.updatedAt = now;
    if (!this.deps.repository.finalizeAttemptRetrying) {
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
    return true;
  }

  private markFailed(
    delivery: QueuedRuntimeDelivery,
    deliveryStatus: ChannelDeliveryStatus | "stale",
    error: string,
    now: string,
  ): void {
    this.applyFailedRecord(delivery, deliveryStatus, error, now);
    if (delivery.record.providerMessageId) {
      this.deps.repository.markFailed(
        delivery.record.deliveryId,
        error,
        now,
        delivery.record.deliveryStatus,
        delivery.record.staleReason,
        delivery.record.providerMessageId,
      );
    } else {
      this.deps.repository.markFailed(
        delivery.record.deliveryId,
        error,
        now,
        delivery.record.deliveryStatus,
        delivery.record.staleReason,
      );
    }
    if (delivery.record.commitmentId) {
      this.notifyDeliveryFailedBestEffort(delivery.record);
    }
  }

  private applyFailedRecord(
    delivery: QueuedRuntimeDelivery,
    deliveryStatus: ChannelDeliveryStatus | "stale",
    error: string,
    now: string,
  ): void {
    delivery.record.status =
      deliveryStatus === "stale"
        ? "stale"
        : deliveryStatus === "manual_reconciliation_required"
          ? "manual_reconciliation_required"
          : "failed";
    delivery.record.deliveryStatus = deliveryStatus === "stale" ? "degraded" : deliveryStatus;
    delivery.record.error = error;
    delivery.record.staleReason = deliveryStatus === "stale" ? error : undefined;
    delivery.record.fallbackReason = error;
    delivery.record.nextAttemptAt = undefined;
    delivery.record.updatedAt = now;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

export function classifyChannelDeliveryFailure(error: unknown): ChannelDeliveryStatus {
  const structuredStatus = readStructuredFailureStatus(error);
  if (structuredStatus) {
    return structuredStatus;
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    [
      "partial_channel_delivery_sent",
      "unknown_after_send",
      "unknown external outcome",
      "unknown_external_outcome",
      "manual reconciliation",
      "manual_reconciliation_required",
      "may have been sent",
      "external boundary may have been crossed",
    ].some((term) => normalized.includes(term))
  ) {
    return "manual_reconciliation_required";
  }
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

function readStructuredFailureStatus(error: unknown): ChannelDeliveryStatus | undefined {
  if (!error || typeof error !== "object" || !("deliveryStatus" in error)) {
    return undefined;
  }
  const status = (error as { deliveryStatus?: unknown }).deliveryStatus;
  return status === "degraded" ||
    status === "blocked" ||
    status === "not_available" ||
    status === "manual_reconciliation_required"
    ? status
    : undefined;
}

function readStructuredProviderMessageId(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("providerMessageId" in error)) {
    return undefined;
  }
  const providerMessageId = (error as { providerMessageId?: unknown }).providerMessageId;
  return typeof providerMessageId === "string" && providerMessageId.trim() ? providerMessageId.trim() : undefined;
}

function isActiveStatus(status: ChannelDeliveryRuntimeStatus): boolean {
  return status === "queued" || status === "retrying" || status === "running";
}

function isDrainEligibleStatus(status: ChannelDeliveryRuntimeStatus): boolean {
  return status === "queued" || status === "retrying";
}

function isDue(nextAttemptAt: string | undefined, now: string): boolean {
  return !nextAttemptAt || Date.parse(nextAttemptAt) <= Date.parse(now);
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
    if (deliveryStatus === "manual_reconciliation_required") {
      return "manual_reconciliation_required";
    }
    return "failed";
  }
  return deliveryStatus === "retrying" ? "retrying" : "queued";
}

function applyChannelDeliveryPlan(channelKey: string, payload: Record<string, unknown>): Record<string, unknown> {
  const textField = readTextPayloadField(payload);
  const attachments = readPayloadAttachments(payload.attachments);
  const attachmentIds = readPayloadAttachmentIds(payload.attachmentIds);
  const richFormat = readRichFormat(payload);
  const richPlan = planChannelRichMessageDelivery(channelKey, {
    text: textField?.text,
    richFormat,
    attachments,
    attachmentIds,
  });
  if (richPlan) {
    assertRichMessagePlanSendable(richPlan);
  }
  if (!textField && !richPlan) {
    return payload;
  }
  const text = textField?.text ?? "";
  const plan = textField ? planChannelTextDelivery(channelKey, text, { richFormat }) : undefined;
  const plannedText = plan && textField ? textField.text : "";
  const existingDiagnostics = readDeliveryDiagnostics(payload.deliveryDiagnostics);
  const diagnostics: ChannelDeliveryDiagnostics = {
    ...existingDiagnostics,
    ...(plan
      ? {
          chunking: existingDiagnostics?.chunking ?? {
            mode: plan.chunks.length > 1 ? "unicode_safe" : "none",
            originalCodePointLength: Array.from(plannedText).length,
            partCount: plan.chunks.length,
            maxPartUtf16Length: plan.maxChunkCodeUnits,
            parts: plan.chunks.map((chunk: string, index: number) => ({
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
        }
      : {}),
    ...(richPlan && shouldAttachRichMessageDiagnostics(richPlan, richFormat)
      ? { richMessage: existingDiagnostics?.richMessage ?? richPlan }
      : {}),
  };
  return {
    ...payload,
    ...(plan && plan.chunks.length > 1 ? { messageParts: plan.chunks, deliveryChunks: plan.chunks } : {}),
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

function readPayloadAttachments(value: unknown): ChannelAttachmentInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attachments = value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const attachment = item as Record<string, unknown>;
      return {
        url: readOptionalPayloadString(attachment.url),
        title: readOptionalPayloadString(attachment.title),
        mimeType: readOptionalPayloadString(attachment.mimeType),
        dataBase64: readOptionalPayloadString(attachment.dataBase64),
        attachmentId: readOptionalPayloadString(attachment.attachmentId),
      };
    })
    .filter((item) => item.url || item.title || item.mimeType || item.dataBase64 || item.attachmentId);
  return attachments.length > 0 ? attachments : undefined;
}

function readPayloadAttachmentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value.map((item) => readOptionalPayloadString(item)).filter((item): item is string => Boolean(item));
  return ids.length > 0 ? ids : undefined;
}

function readOptionalPayloadString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function shouldAttachRichMessageDiagnostics(
  plan: ChannelRichMessageDeliveryPlan,
  richFormat: ChannelDeliveryRichFormat | undefined,
): boolean {
  return (
    plan.attachmentCount > 0 || plan.pendingAttachmentIdCount > 0 || Boolean(richFormat && richFormat !== "plain_text")
  );
}

function assertRichMessagePlanSendable(plan: ChannelRichMessageDeliveryPlan): void {
  const blocked = plan.attachments.find((attachment) => attachment.disposition === "blocked");
  if (!blocked) {
    return;
  }
  throw new Error(
    `${plan.capabilityLabel} blocked attachment ${blocked.index + 1}: ${
      blocked.reason ?? "attachment cannot be delivered safely"
    }`,
  );
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

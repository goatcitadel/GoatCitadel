import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  NotFoundError,
  ValidationError,
  type MobilePushApprovalRefreshPayload,
  type MobilePushProvider,
} from "@goatcitadel/contracts";
import { buildActiveGrantExpiryPredicate } from "./active-grant-predicate.js";
import type { DatabaseClient } from "./db.js";

export type MobilePushRegistrationLifecycle = "active" | "revoked";
export type MobilePushDeliveryStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "delivered"
  | "invalid_token"
  | "unknown_after_send"
  | "dead_lettered"
  | "custody_blocked"
  | "cancelled_revoked";
export type MobilePushDeliveryClassification =
  | "delivered"
  | "invalid_token"
  | "retryable"
  | "unknown_after_send"
  | "provider_unavailable"
  | "custody_unavailable"
  | "grant_validation_unavailable"
  | "custody_mismatch"
  | "registration_revoked";

export interface MobilePushRegistrationRecord {
  registrationId: string;
  grantId: string;
  provider: MobilePushProvider;
  tokenSecretRef: string;
  tokenSha256?: string;
  lifecycleState: MobilePushRegistrationLifecycle;
  revision: number;
  companionSessionId?: string;
  deviceLabel?: string;
  appVersion?: string;
  registeredAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface MobilePushDeliveryRecord {
  deliveryId: string;
  registrationId: string;
  sourceRealtimeEventId: string;
  approvalId: string;
  eventKind: "approval_refresh";
  payload: MobilePushApprovalRefreshPayload;
  payloadSha256: string;
  status: MobilePushDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  claimedBy?: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  version: number;
  lastClassification?: MobilePushDeliveryClassification;
  providerReceiptSha256?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface MobilePushRegistrationRow {
  registration_id: string;
  grant_id: string;
  provider: string;
  token_secret_ref: string;
  token_sha256: string | null;
  lifecycle_state: string;
  revision: number;
  companion_session_id: string | null;
  device_label: string | null;
  app_version: string | null;
  registered_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface MobilePushDeliveryRow {
  delivery_id: string;
  registration_id: string;
  source_realtime_event_id: string;
  approval_id: string;
  event_kind: string;
  payload_json: string;
  payload_sha256: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  version: number;
  last_classification: string | null;
  provider_receipt_sha256: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const TERMINAL_DELIVERY_STATUSES = new Set<MobilePushDeliveryStatus>([
  "delivered",
  "invalid_token",
  "unknown_after_send",
  "dead_lettered",
  "custody_blocked",
  "cancelled_revoked",
]);

/**
 * Outcome of arming the atomic revoke/send fence immediately before a provider
 * send. `armed: false` means the send MUST NOT happen: the registration was
 * revoked or rotated after claim, or the worker lost its lease. A revocation
 * that commits after the fence is armed races an in-flight send; the running
 * delivery then settles exactly once through the worker's honest finalize.
 */
export type MobilePushSendFenceOutcome =
  | { armed: true; delivery: MobilePushDeliveryRecord }
  | { armed: false; reason: "lease_lost" | "registration_revoked" | "registration_rotated" };

export class MobilePushRepository {
  private readonly getRegistrationByGrantProviderStmt;
  private readonly getRegistrationByIdStmt;
  private readonly listRegistrationsByGrantStmt;
  private readonly listActiveRegistrationsStmt;
  private readonly getActiveGrantForUpdateStmt;
  private readonly upsertActiveRegistrationStmt;
  private readonly ensureRevokedRegistrationStmt;
  private readonly revokeRegistrationByIdStmt;
  private readonly cancelPendingDeliveriesForRegistrationStmt;
  private readonly insertDeliveryStmt;
  private readonly getDeliveryStmt;
  private readonly listDeliveriesStmt;
  private readonly listDueDeliveriesStmt;
  private readonly claimDeliveryStmt;
  private readonly getRegistrationForSendFenceStmt;
  private readonly armDeliverySendFenceStmt;
  private readonly quarantineExpiredRunningDeliveryStmt;
  private readonly finalizeDeliveryStmt;

  public constructor(private readonly db: DatabaseClient) {
    const distinct = (left: string, right: string) =>
      db.dialect === "postgres" ? `${left} IS DISTINCT FROM ${right}` : `${left} IS NOT ${right}`;
    const registrationChanged = [
      distinct("mobile_push_registrations.token_secret_ref", "excluded.token_secret_ref"),
      distinct("mobile_push_registrations.token_sha256", "excluded.token_sha256"),
      distinct("mobile_push_registrations.lifecycle_state", "excluded.lifecycle_state"),
      distinct("mobile_push_registrations.companion_session_id", "excluded.companion_session_id"),
      distinct("mobile_push_registrations.device_label", "excluded.device_label"),
      distinct("mobile_push_registrations.app_version", "excluded.app_version"),
    ].join(" OR ");
    const revokedRegistrationChanged = [
      "mobile_push_registrations.lifecycle_state <> 'revoked'",
      "mobile_push_registrations.token_sha256 IS NOT NULL",
      distinct("mobile_push_registrations.companion_session_id", "excluded.companion_session_id"),
      `(
        excluded.device_label IS NOT NULL
        AND ${distinct("mobile_push_registrations.device_label", "excluded.device_label")}
      )`,
      `(
        excluded.app_version IS NOT NULL
        AND ${distinct("mobile_push_registrations.app_version", "excluded.app_version")}
      )`,
    ].join(" OR ");

    this.getRegistrationByGrantProviderStmt = db.prepare(`
      SELECT * FROM mobile_push_registrations
      WHERE grant_id = @grantId AND provider = @provider
      LIMIT 1
    `);
    this.getRegistrationByIdStmt = db.prepare(`
      SELECT * FROM mobile_push_registrations
      WHERE registration_id = @registrationId
      LIMIT 1
    `);
    this.listRegistrationsByGrantStmt = db.prepare(`
      SELECT * FROM mobile_push_registrations
      WHERE grant_id = @grantId
      ORDER BY provider ASC, registration_id ASC
    `);
    this.listActiveRegistrationsStmt = db.prepare(`
      SELECT registration.*
      FROM mobile_push_registrations registration
      INNER JOIN auth_device_grants grant_authority
        ON grant_authority.grant_id = registration.grant_id
      WHERE registration.lifecycle_state = 'active'
        AND grant_authority.revoked_at IS NULL
        AND (
          grant_authority.expires_at IS NULL
          OR ${buildActiveGrantExpiryPredicate(db.dialect, "grant_authority.expires_at")}
        )
      ORDER BY registration.registered_at ASC, registration.registration_id ASC
      LIMIT @limit
    `);
    this.getActiveGrantForUpdateStmt = db.prepare(`
      SELECT grant_id
      FROM auth_device_grants
      WHERE grant_id = @grantId
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR ${buildActiveGrantExpiryPredicate(db.dialect, "expires_at")})
      LIMIT 1${db.dialect === "postgres" ? " FOR UPDATE" : ""}
    `);
    this.upsertActiveRegistrationStmt = db.prepare(`
      INSERT INTO mobile_push_registrations (
        registration_id, grant_id, provider, token_secret_ref, token_sha256, lifecycle_state,
        revision, companion_session_id, device_label, app_version, registered_at, updated_at, revoked_at
      ) VALUES (
        @registrationId, @grantId, @provider, @tokenSecretRef, @tokenSha256, 'active',
        1, @companionSessionId, @deviceLabel, @appVersion, @registeredAt, @updatedAt, NULL
      )
      ON CONFLICT(grant_id, provider) DO UPDATE SET
        token_secret_ref = excluded.token_secret_ref,
        token_sha256 = excluded.token_sha256,
        lifecycle_state = 'active',
        revision = CASE WHEN ${registrationChanged}
          THEN mobile_push_registrations.revision + 1
          ELSE mobile_push_registrations.revision END,
        companion_session_id = excluded.companion_session_id,
        device_label = excluded.device_label,
        app_version = excluded.app_version,
        updated_at = CASE WHEN ${registrationChanged}
          THEN excluded.updated_at ELSE mobile_push_registrations.updated_at END,
        revoked_at = NULL
    `);
    this.ensureRevokedRegistrationStmt = db.prepare(`
      INSERT INTO mobile_push_registrations (
        registration_id, grant_id, provider, token_secret_ref, token_sha256, lifecycle_state,
        revision, companion_session_id, device_label, app_version, registered_at, updated_at, revoked_at
      ) VALUES (
        @registrationId, @grantId, @provider, @tokenSecretRef, NULL, 'revoked',
        1, @companionSessionId, @deviceLabel, @appVersion, @registeredAt, @updatedAt, @revokedAt
      )
      ON CONFLICT(grant_id, provider) DO UPDATE SET
        token_sha256 = NULL,
        lifecycle_state = 'revoked',
        revision = CASE WHEN ${revokedRegistrationChanged}
          THEN mobile_push_registrations.revision + 1
          ELSE mobile_push_registrations.revision END,
        companion_session_id = excluded.companion_session_id,
        device_label = COALESCE(excluded.device_label, mobile_push_registrations.device_label),
        app_version = COALESCE(excluded.app_version, mobile_push_registrations.app_version),
        updated_at = CASE WHEN ${revokedRegistrationChanged}
          THEN excluded.updated_at ELSE mobile_push_registrations.updated_at END,
        revoked_at = CASE WHEN ${revokedRegistrationChanged}
          THEN excluded.revoked_at ELSE mobile_push_registrations.revoked_at END
    `);
    this.revokeRegistrationByIdStmt = db.prepare(`
      UPDATE mobile_push_registrations
      SET token_sha256 = NULL,
          lifecycle_state = 'revoked',
          revision = revision + 1,
          updated_at = @revokedAt,
          revoked_at = @revokedAt
      WHERE registration_id = @registrationId
        AND lifecycle_state = 'active'
    `);
    this.cancelPendingDeliveriesForRegistrationStmt = db.prepare(`
      UPDATE mobile_push_deliveries
      SET status = 'cancelled_revoked',
          next_attempt_at = NULL,
          version = version + 1,
          last_classification = 'registration_revoked',
          updated_at = @updatedAt,
          completed_at = @updatedAt
      WHERE registration_id = @registrationId
        AND status IN ('queued', 'retry_scheduled')
    `);
    this.insertDeliveryStmt = db.prepare(`
      INSERT INTO mobile_push_deliveries (
        delivery_id, registration_id, source_realtime_event_id, approval_id, event_kind, payload_json,
        payload_sha256, status, attempt_count, max_attempts, next_attempt_at, claimed_by,
        claimed_at, lease_expires_at, version, last_classification, provider_receipt_sha256,
        created_at, updated_at, completed_at
      ) VALUES (
        @deliveryId, @registrationId, @sourceRealtimeEventId, @approvalId, 'approval_refresh', @payloadJson,
        @payloadSha256, 'queued', 0, @maxAttempts, NULL, NULL,
        NULL, NULL, 1, NULL, NULL, @createdAt, @updatedAt, NULL
      )
      ON CONFLICT(registration_id, approval_id, event_kind) DO NOTHING
    `);
    this.getDeliveryStmt = db.prepare(`
      SELECT * FROM mobile_push_deliveries
      WHERE delivery_id = @deliveryId
      LIMIT 1
    `);
    this.listDeliveriesStmt = db.prepare(`
      SELECT * FROM mobile_push_deliveries
      WHERE (@registrationId IS NULL OR registration_id = @registrationId)
      ORDER BY created_at ASC, delivery_id ASC
      LIMIT @limit
    `);
    this.listDueDeliveriesStmt = db.prepare(`
      SELECT * FROM mobile_push_deliveries
      WHERE (
        status IN ('queued', 'retry_scheduled')
        AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
      ) OR (
        status = 'running'
        AND (lease_expires_at IS NULL OR lease_expires_at <= @now)
      )
      ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, created_at ASC, delivery_id ASC
      LIMIT @limit
    `);
    this.claimDeliveryStmt = db.prepare(`
      UPDATE mobile_push_deliveries
      SET status = 'running',
          attempt_count = attempt_count + 1,
          next_attempt_at = NULL,
          claimed_by = @workerId,
          claimed_at = @claimedAt,
          lease_expires_at = @leaseExpiresAt,
          version = version + 1,
          last_classification = NULL,
          updated_at = @claimedAt
      WHERE delivery_id = @deliveryId
        AND version = @expectedVersion
        AND status IN ('queued', 'retry_scheduled')
        AND (next_attempt_at IS NULL OR next_attempt_at <= @claimedAt)
    `);
    this.getRegistrationForSendFenceStmt = db.prepare(`
      SELECT lifecycle_state, revision
      FROM mobile_push_registrations
      WHERE registration_id = @registrationId
      LIMIT 1${db.dialect === "postgres" ? " FOR UPDATE" : ""}
    `);
    this.armDeliverySendFenceStmt = db.prepare(`
      UPDATE mobile_push_deliveries
      SET version = version + 1,
          updated_at = @armedAt
      WHERE delivery_id = @deliveryId
        AND status = 'running'
        AND claimed_by = @workerId
        AND version = @expectedVersion
        AND lease_expires_at = @expectedLeaseExpiresAt
    `);
    this.quarantineExpiredRunningDeliveryStmt = db.prepare(`
      UPDATE mobile_push_deliveries
      SET status = 'unknown_after_send',
          next_attempt_at = NULL,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          version = version + 1,
          last_classification = 'unknown_after_send',
          updated_at = @updatedAt,
          completed_at = @updatedAt
      WHERE delivery_id = @deliveryId
        AND status = 'running'
        AND version = @expectedVersion
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= @updatedAt
    `);
    this.finalizeDeliveryStmt = db.prepare(`
      UPDATE mobile_push_deliveries
      SET status = @status,
          next_attempt_at = @nextAttemptAt,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          version = version + 1,
          last_classification = @lastClassification,
          provider_receipt_sha256 = @providerReceiptSha256,
          updated_at = @updatedAt,
          completed_at = @completedAt
      WHERE delivery_id = @deliveryId
        AND status = 'running'
        AND claimed_by = @workerId
        AND version = @expectedVersion
        AND lease_expires_at = @expectedLeaseExpiresAt
    `);
  }

  public getRegistration(grantId: string, provider: MobilePushProvider): MobilePushRegistrationRecord | undefined {
    const row = this.getRegistrationByGrantProviderStmt.get({ grantId, provider });
    return row ? mapRegistration(row as MobilePushRegistrationRow) : undefined;
  }

  public getRegistrationById(registrationId: string): MobilePushRegistrationRecord | undefined {
    const row = this.getRegistrationByIdStmt.get({ registrationId });
    return row ? mapRegistration(row as MobilePushRegistrationRow) : undefined;
  }

  public listRegistrationsByGrant(grantId: string): MobilePushRegistrationRecord[] {
    return (this.listRegistrationsByGrantStmt.all({ grantId }) as MobilePushRegistrationRow[]).map(mapRegistration);
  }

  public listActiveRegistrations(limit = 500): MobilePushRegistrationRecord[] {
    return (this.listActiveRegistrationsStmt.all({ limit: clampLimit(limit, 500) }) as MobilePushRegistrationRow[]).map(
      mapRegistration,
    );
  }

  public upsertActiveRegistration(input: {
    registrationId: string;
    grantId: string;
    provider: MobilePushProvider;
    tokenSecretRef: string;
    tokenSha256: string;
    companionSessionId?: string;
    deviceLabel?: string;
    appVersion?: string;
    now?: string;
  }): MobilePushRegistrationRecord {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      const activeGrant = this.getActiveGrantForUpdateStmt.get({ grantId: input.grantId });
      if (!activeGrant) {
        throw new ValidationError({ message: "An active durable device grant is required for mobile push." });
      }
      this.upsertActiveRegistrationStmt.run({
        registrationId: input.registrationId,
        grantId: input.grantId,
        provider: input.provider,
        tokenSecretRef: input.tokenSecretRef,
        tokenSha256: input.tokenSha256,
        companionSessionId: input.companionSessionId ?? null,
        deviceLabel: input.deviceLabel ?? null,
        appVersion: input.appVersion ?? null,
        registeredAt: now,
        updatedAt: now,
      });
      return this.requireRegistration(input.grantId, input.provider);
    });
  }

  public ensureRevokedRegistration(input: {
    registrationId: string;
    grantId: string;
    provider: MobilePushProvider;
    tokenSecretRef: string;
    companionSessionId?: string;
    deviceLabel?: string;
    appVersion?: string;
    now?: string;
  }): MobilePushRegistrationRecord {
    const now = input.now ?? new Date().toISOString();
    return this.db.transaction("immediate", () => this.ensureRevokedRegistrationInTransaction(input, now));
  }

  private ensureRevokedRegistrationInTransaction(
    input: {
      registrationId: string;
      grantId: string;
      provider: MobilePushProvider;
      tokenSecretRef: string;
      companionSessionId?: string;
      deviceLabel?: string;
      appVersion?: string;
    },
    now: string,
  ): MobilePushRegistrationRecord {
    this.ensureRevokedRegistrationStmt.run({
      registrationId: input.registrationId,
      grantId: input.grantId,
      provider: input.provider,
      tokenSecretRef: input.tokenSecretRef,
      companionSessionId: input.companionSessionId ?? null,
      deviceLabel: input.deviceLabel ?? null,
      appVersion: input.appVersion ?? null,
      registeredAt: now,
      updatedAt: now,
      revokedAt: now,
    });
    const registration = this.requireRegistration(input.grantId, input.provider);
    this.cancelPendingDeliveriesForRegistrationStmt.run({
      registrationId: registration.registrationId,
      updatedAt: now,
    });
    return registration;
  }

  public revokeAllByGrant(grantId: string, now = new Date().toISOString()): MobilePushRegistrationRecord[] {
    return this.db.transaction("immediate", () =>
      this.listRegistrationsByGrant(grantId).map((registration) =>
        this.ensureRevokedRegistrationInTransaction(
          {
            registrationId: registration.registrationId,
            grantId: registration.grantId,
            provider: registration.provider,
            tokenSecretRef: registration.tokenSecretRef,
            companionSessionId: registration.companionSessionId,
            deviceLabel: registration.deviceLabel,
            appVersion: registration.appVersion,
          },
          now,
        ),
      ),
    );
  }

  public enqueueApprovalRefresh(input: {
    sourceRealtimeEventId: string;
    approvalId: string;
    maxAttempts?: number;
    now?: string;
  }): MobilePushDeliveryRecord[] {
    const now = input.now ?? new Date().toISOString();
    const payload: MobilePushApprovalRefreshPayload = {
      schemaVersion: 1,
      type: "approval_refresh",
      realtimeEventId: input.sourceRealtimeEventId,
      approvalId: input.approvalId,
      deepLink: { kind: "approval", approvalId: input.approvalId },
    };
    const payloadJson = canonicalJsonString(payload);
    const payloadSha256 = sha256(payloadJson);
    const maxAttempts = Math.max(1, Math.min(20, Math.floor(input.maxAttempts ?? 5)));
    return this.db.transaction("immediate", () => {
      const active = this.listActiveRegistrations(500);
      return active.map((registration) => {
        const deliveryId = deriveMobilePushDeliveryId(registration.registrationId, input.approvalId);
        this.insertDeliveryStmt.run({
          deliveryId,
          registrationId: registration.registrationId,
          sourceRealtimeEventId: input.sourceRealtimeEventId,
          approvalId: input.approvalId,
          payloadJson,
          payloadSha256,
          maxAttempts,
          createdAt: now,
          updatedAt: now,
        });
        return this.getDelivery(deliveryId);
      });
    });
  }

  public getDelivery(deliveryId: string): MobilePushDeliveryRecord {
    const row = this.getDeliveryStmt.get({ deliveryId });
    if (!row) throw new NotFoundError({ entity: "mobile push delivery", id: deliveryId });
    return mapDelivery(row as MobilePushDeliveryRow);
  }

  public listDeliveries(registrationId?: string, limit = 200): MobilePushDeliveryRecord[] {
    return (
      (
        this.listDeliveriesStmt.all({ registrationId: registrationId ?? null, limit: clampLimit(limit, 200) }) as
          | MobilePushDeliveryRow[]
          | undefined
      )?.map(mapDelivery) ?? []
    );
  }

  public listDueDeliveries(now = new Date().toISOString(), limit = 25): MobilePushDeliveryRecord[] {
    return (this.listDueDeliveriesStmt.all({ now, limit: clampLimit(limit, 100) }) as MobilePushDeliveryRow[]).map(
      mapDelivery,
    );
  }

  public claimDelivery(input: {
    deliveryId: string;
    expectedVersion: number;
    workerId: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): MobilePushDeliveryRecord | undefined {
    const result = this.claimDeliveryStmt.run(input);
    return Number(result.changes ?? 0) > 0 ? this.getDelivery(input.deliveryId) : undefined;
  }

  /**
   * Atomic revoke/send fence: the last durable commit point before the provider
   * network boundary. Inside one immediate transaction the registration row is
   * re-read (row-locked on PostgreSQL, so a concurrent revoke serializes) and
   * the running delivery's version is advanced by CAS. A revocation or token
   * rotation that committed before this fence therefore always wins: the fence
   * refuses and no send happens. Once armed, a racing revocation can no longer
   * cancel the running row (revoke only cancels queued/retry_scheduled), so the
   * in-flight send settles exactly once through finalize with the post-fence
   * version and an honest receipt.
   */
  public armDeliverySendFence(input: {
    deliveryId: string;
    registrationId: string;
    expectedVersion: number;
    expectedRegistrationRevision: number;
    expectedLeaseExpiresAt: string;
    workerId: string;
    armedAt?: string;
  }): MobilePushSendFenceOutcome {
    const armedAt = input.armedAt ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      const registration = this.getRegistrationForSendFenceStmt.get({ registrationId: input.registrationId }) as
        | { lifecycle_state: string; revision: number }
        | undefined;
      if (!registration || registration.lifecycle_state !== "active") {
        return { armed: false, reason: "registration_revoked" } as const;
      }
      if (Number(registration.revision) !== input.expectedRegistrationRevision) {
        return { armed: false, reason: "registration_rotated" } as const;
      }
      const result = this.armDeliverySendFenceStmt.run({
        deliveryId: input.deliveryId,
        workerId: input.workerId,
        expectedVersion: input.expectedVersion,
        expectedLeaseExpiresAt: input.expectedLeaseExpiresAt,
        armedAt,
      });
      if (Number(result.changes ?? 0) === 0) {
        return { armed: false, reason: "lease_lost" } as const;
      }
      return { armed: true, delivery: this.getDelivery(input.deliveryId) } as const;
    });
  }

  /**
   * A crashed running lease may already have crossed the provider boundary.
   * Quarantine it as ambiguous instead of reclaiming and risking a duplicate.
   */
  public quarantineExpiredRunningDelivery(
    deliveryId: string,
    expectedVersion: number,
    updatedAt = new Date().toISOString(),
  ): MobilePushDeliveryRecord | undefined {
    const result = this.quarantineExpiredRunningDeliveryStmt.run({ deliveryId, expectedVersion, updatedAt });
    return Number(result.changes ?? 0) > 0 ? this.getDelivery(deliveryId) : undefined;
  }

  public finalizeDelivery(input: {
    deliveryId: string;
    expectedVersion: number;
    expectedLeaseExpiresAt: string;
    workerId: string;
    status: Exclude<MobilePushDeliveryStatus, "queued" | "running">;
    lastClassification: MobilePushDeliveryClassification;
    nextAttemptAt?: string;
    providerReceiptSha256?: string;
    updatedAt?: string;
  }): MobilePushDeliveryRecord | undefined {
    const terminal = TERMINAL_DELIVERY_STATUSES.has(input.status);
    if (!terminal && input.status !== "retry_scheduled") {
      throw new ValidationError({ message: `Invalid mobile push delivery final status: ${input.status}` });
    }
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const result = this.finalizeDeliveryStmt.run({
      ...input,
      nextAttemptAt: input.nextAttemptAt ?? null,
      providerReceiptSha256: input.providerReceiptSha256 ?? null,
      updatedAt,
      completedAt: terminal ? updatedAt : null,
    });
    return Number(result.changes ?? 0) > 0 ? this.getDelivery(input.deliveryId) : undefined;
  }

  public finalizeAndRevokeRegistration(input: {
    deliveryId: string;
    expectedVersion: number;
    expectedLeaseExpiresAt: string;
    workerId: string;
    status: "invalid_token" | "custody_blocked" | "cancelled_revoked";
    lastClassification: "invalid_token" | "custody_mismatch" | "registration_revoked";
    updatedAt?: string;
  }): { delivery?: MobilePushDeliveryRecord; registration?: MobilePushRegistrationRecord } {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    return this.db.transaction("immediate", () => {
      const delivery = this.finalizeDelivery({ ...input, updatedAt });
      if (!delivery) return {};
      this.revokeRegistrationByIdStmt.run({ registrationId: delivery.registrationId, revokedAt: updatedAt });
      this.cancelPendingDeliveriesForRegistrationStmt.run({
        registrationId: delivery.registrationId,
        updatedAt,
      });
      return { delivery, registration: this.getRegistrationById(delivery.registrationId) };
    });
  }

  private requireRegistration(grantId: string, provider: MobilePushProvider): MobilePushRegistrationRecord {
    const record = this.getRegistration(grantId, provider);
    if (!record) {
      throw new NotFoundError({ entity: "mobile push registration", id: `${grantId}:${provider}` });
    }
    return record;
  }
}

export function deriveMobilePushRegistrationId(grantId: string, provider: MobilePushProvider): string {
  return `mpr_${sha256(`grant:${grantId.trim()}\nprovider:${provider}`).slice(0, 40)}`;
}

export function deriveMobilePushDeliveryId(registrationId: string, approvalId: string): string {
  return `mpd_${sha256(`registration:${registrationId}\napproval:${approvalId}`).slice(0, 40)}`;
}

function mapRegistration(row: MobilePushRegistrationRow): MobilePushRegistrationRecord {
  if ((row.provider !== "expo" && row.provider !== "fcm") || !isRegistrationLifecycle(row.lifecycle_state)) {
    throw new ValidationError({ message: "Stored mobile push registration is invalid." });
  }
  return {
    registrationId: row.registration_id,
    grantId: row.grant_id,
    provider: row.provider,
    tokenSecretRef: row.token_secret_ref,
    tokenSha256: row.token_sha256 ?? undefined,
    lifecycleState: row.lifecycle_state,
    revision: Number(row.revision),
    companionSessionId: row.companion_session_id ?? undefined,
    deviceLabel: row.device_label ?? undefined,
    appVersion: row.app_version ?? undefined,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function mapDelivery(row: MobilePushDeliveryRow): MobilePushDeliveryRecord {
  const payload = parseApprovalRefreshPayload(row.payload_json);
  if (
    row.event_kind !== "approval_refresh" ||
    row.approval_id !== payload.approvalId ||
    !isDeliveryStatus(row.status) ||
    (row.last_classification !== null && !isDeliveryClassification(row.last_classification))
  ) {
    throw new ValidationError({ message: "Stored mobile push delivery is invalid." });
  }
  return {
    deliveryId: row.delivery_id,
    registrationId: row.registration_id,
    sourceRealtimeEventId: row.source_realtime_event_id,
    approvalId: row.approval_id,
    eventKind: "approval_refresh",
    payload,
    payloadSha256: row.payload_sha256,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    version: Number(row.version),
    lastClassification: row.last_classification ?? undefined,
    providerReceiptSha256: row.provider_receipt_sha256 ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function parseApprovalRefreshPayload(value: string): MobilePushApprovalRefreshPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ValidationError({ message: "Stored mobile push payload is invalid." });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError({ message: "Stored mobile push payload is invalid." });
  }
  const record = parsed as Record<string, unknown>;
  const deepLink = record.deepLink;
  if (
    record.schemaVersion !== 1 ||
    record.type !== "approval_refresh" ||
    typeof record.realtimeEventId !== "string" ||
    typeof record.approvalId !== "string" ||
    !deepLink ||
    typeof deepLink !== "object" ||
    Array.isArray(deepLink) ||
    (deepLink as Record<string, unknown>).kind !== "approval" ||
    (deepLink as Record<string, unknown>).approvalId !== record.approvalId ||
    Object.keys(record).some(
      (key) => !["schemaVersion", "type", "realtimeEventId", "approvalId", "deepLink"].includes(key),
    ) ||
    Object.keys(deepLink).some((key) => !["kind", "approvalId"].includes(key))
  ) {
    throw new ValidationError({ message: "Stored mobile push payload is invalid." });
  }
  return record as unknown as MobilePushApprovalRefreshPayload;
}

function isRegistrationLifecycle(value: string): value is MobilePushRegistrationLifecycle {
  return value === "active" || value === "revoked";
}

function isDeliveryStatus(value: string): value is MobilePushDeliveryStatus {
  return [
    "queued",
    "running",
    "retry_scheduled",
    "delivered",
    "invalid_token",
    "unknown_after_send",
    "dead_lettered",
    "custody_blocked",
    "cancelled_revoked",
  ].includes(value);
}

function isDeliveryClassification(value: string): value is MobilePushDeliveryClassification {
  return [
    "delivered",
    "invalid_token",
    "retryable",
    "unknown_after_send",
    "provider_unavailable",
    "custody_unavailable",
    "grant_validation_unavailable",
    "custody_mismatch",
    "registration_revoked",
  ].includes(value);
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

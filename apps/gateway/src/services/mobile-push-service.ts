import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  canonicalJsonString,
  redactSecretText,
  type MobilePushApprovalRefreshPayload,
  type MobilePushProvider,
  type MobilePushRegistrationRequest,
  type MobilePushRegistrationResponse,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import {
  deriveMobilePushRegistrationId,
  type AsyncStorage as Storage,
  type MobilePushDeliveryClassification,
  type MobilePushDeliveryRecord,
  type MobilePushRegistrationRecord,
} from "@goatcitadel/storage";
import { SecretStoreUnavailableError, type SecretStoreService } from "./secret-store-service.js";

const MOBILE_PUSH_SECRET_REF_PREFIX = "keychain:goatcitadel:mobile-push:";
const DELIVERY_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;

type MobilePushSecretStore = Pick<
  SecretStoreService,
  "isAvailable" | "isWriteCustodySafe" | "setSecret" | "getSecret" | "deleteSecret"
>;
type MobilePushStorage = Pick<Storage, "mobilePush">;

export type MobilePushProviderResult =
  | { classification: "delivered"; receiptId?: string }
  | { classification: "invalid_token" }
  | { classification: "retryable"; retryAfterMs?: number }
  | { classification: "unknown_after_send" }
  | { classification: "provider_unavailable"; retryAfterMs?: number };

export interface MobilePushProviderPort {
  isAvailable(): boolean;
  send(input: {
    deliveryId: string;
    provider: MobilePushProvider;
    token: string;
    payload: MobilePushApprovalRefreshPayload;
  }): Promise<MobilePushProviderResult>;
}

export interface MobilePushActorContext {
  grantId?: string;
  companionSessionId?: string;
}

export interface MobilePushDeliverySweepResult {
  providerAvailable: boolean;
  attempted: number;
  outcomes: Array<{
    deliveryId: string;
    status: MobilePushDeliveryRecord["status"] | "lease_lost";
    classification?: MobilePushDeliveryClassification;
  }>;
}

export interface MobilePushDiagnostic {
  event: "mobile_push.keychain_cleanup_failed";
  message: string;
  context: { registrationId: string; operation: "disable" | "grant_revoke" | "delivery_revoke" };
}

export class MobilePushCustodyError extends SecretStoreUnavailableError {
  public constructor(message = "Mobile push token custody is unavailable.") {
    super(message);
  }
}

/** Explicit production default until a credentialed Expo/FCM adapter is configured. */
export function createUnavailableMobilePushProvider(): MobilePushProviderPort {
  return {
    isAvailable: () => false,
    send: async () => ({ classification: "provider_unavailable" }),
  };
}

export class MobilePushService {
  private readonly workerId: string;

  public constructor(
    private readonly deps: {
      storage: MobilePushStorage;
      secretStore: MobilePushSecretStore;
      provider: MobilePushProviderPort;
      isGrantActive: (grantId: string) => Promise<boolean>;
      recordDiagnostic?: (diagnostic: MobilePushDiagnostic) => void;
      now?: () => Date;
      workerId?: string;
    },
  ) {
    this.workerId = deps.workerId ?? `gateway-mobile-push:${randomUUID()}`;
  }

  public async register(
    input: MobilePushRegistrationRequest,
    actor: MobilePushActorContext,
  ): Promise<MobilePushRegistrationResponse> {
    const grantId = requireGrantId(actor.grantId);
    const registrationId = deriveMobilePushRegistrationId(grantId, input.provider);
    const tokenSecretRef = buildMobilePushTokenSecretRef(registrationId);
    const rawToken = input.enabled ? input.token : undefined;
    const deviceLabel = sanitizeRegistrationMetadata(input.deviceLabel, rawToken);
    const appVersion = sanitizeRegistrationMetadata(input.appVersion, rawToken);
    if (!input.enabled) {
      const revoked = await this.revokeProvider({
        registrationId,
        grantId,
        provider: input.provider,
        tokenSecretRef,
        companionSessionId: actor.companionSessionId,
        deviceLabel,
        appVersion,
      });
      return registrationResponse(revoked, this.providerAvailable());
    }

    this.assertWriteCustodyAvailable();
    const account = accountFromMobilePushSecretRef(tokenSecretRef);
    const tokenSha256 = sha256(input.token);
    let previous: string | undefined;
    let tokenWriteAttempted = false;
    try {
      previous = this.deps.secretStore.getSecret(account);
      if (!previous || !safeDigestEqual(sha256(previous), tokenSha256)) {
        tokenWriteAttempted = true;
        this.deps.secretStore.setSecret(account, input.token);
      }
    } catch {
      if (tokenWriteAttempted) {
        try {
          if (previous) this.deps.secretStore.setSecret(account, previous);
          else this.deps.secretStore.deleteSecret(account);
        } catch {
          throw new MobilePushCustodyError(
            "Mobile push token custody failed and the prior keychain value could not be restored.",
          );
        }
      }
      throw new MobilePushCustodyError();
    }

    try {
      const registration = await this.deps.storage.mobilePush.upsertActiveRegistration({
        registrationId,
        grantId,
        provider: input.provider,
        tokenSecretRef,
        tokenSha256,
        companionSessionId: actor.companionSessionId,
        deviceLabel,
        appVersion,
        now: this.nowIso(),
      });
      return registrationResponse(registration, this.providerAvailable());
    } catch (error) {
      try {
        if (previous) this.deps.secretStore.setSecret(account, previous);
        else this.deps.secretStore.deleteSecret(account);
      } catch {
        throw new MobilePushCustodyError(
          "Mobile push registration failed and prior keychain custody could not be restored.",
        );
      }
      throw error;
    }
  }

  public async revokeGrant(grantIdInput: string | undefined): Promise<MobilePushRegistrationRecord[]> {
    const grantId = requireGrantId(grantIdInput);
    const revoked = await this.deps.storage.mobilePush.revokeAllByGrant(grantId, this.nowIso());
    for (const registration of revoked) {
      this.deleteSecretBestEffort(registration, "grant_revoke");
    }
    return revoked;
  }

  public async deliverDue(limit = 25): Promise<MobilePushDeliverySweepResult> {
    const providerAvailable = this.providerAvailable();
    const now = this.now();
    const due = await this.deps.storage.mobilePush.listDueDeliveries(now.toISOString(), Math.min(100, limit));
    const outcomes: MobilePushDeliverySweepResult["outcomes"] = [];
    for (const candidate of due) {
      if (candidate.status === "running") {
        const quarantined = await this.deps.storage.mobilePush.quarantineExpiredRunningDelivery(
          candidate.deliveryId,
          candidate.version,
          now.toISOString(),
        );
        if (quarantined) {
          outcomes.push({
            deliveryId: quarantined.deliveryId,
            status: quarantined.status,
            classification: quarantined.lastClassification,
          });
        }
        continue;
      }
      if (!providerAvailable) continue;
      const leaseExpiresAt = new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString();
      const claimed = await this.deps.storage.mobilePush.claimDelivery({
        deliveryId: candidate.deliveryId,
        expectedVersion: candidate.version,
        workerId: this.workerId,
        claimedAt: now.toISOString(),
        leaseExpiresAt,
      });
      if (!claimed) continue;
      outcomes.push(await this.deliverClaimed(claimed));
    }
    return { providerAvailable, attempted: outcomes.length, outcomes };
  }

  private async revokeProvider(input: {
    registrationId: string;
    grantId: string;
    provider: MobilePushProvider;
    tokenSecretRef: string;
    companionSessionId?: string;
    deviceLabel?: string;
    appVersion?: string;
  }): Promise<MobilePushRegistrationRecord> {
    const revoked = await this.deps.storage.mobilePush.ensureRevokedRegistration({ ...input, now: this.nowIso() });
    try {
      const expectedRef = buildMobilePushTokenSecretRef(input.registrationId);
      this.deps.secretStore.deleteSecret(accountFromMobilePushSecretRef(expectedRef));
    } catch {
      this.recordCleanupFailure(revoked.registrationId, "disable");
    }
    return revoked;
  }

  private async deliverClaimed(
    delivery: MobilePushDeliveryRecord,
  ): Promise<MobilePushDeliverySweepResult["outcomes"][number]> {
    const registration = await this.deps.storage.mobilePush.getRegistrationById(delivery.registrationId);
    if (!registration || registration.lifecycleState !== "active") {
      return await this.finalize(delivery, "cancelled_revoked", "registration_revoked");
    }
    let grantActive: boolean;
    try {
      grantActive = await this.deps.isGrantActive(registration.grantId);
    } catch {
      return await this.retry(delivery, "grant_validation_unavailable");
    }
    if (!grantActive) {
      return await this.revokeInactiveGrant(delivery, registration);
    }
    const payloadSha256 = sha256(canonicalJsonString(delivery.payload));
    if (!safeDigestEqual(payloadSha256, delivery.payloadSha256)) {
      return await this.finalize(delivery, "custody_blocked", "custody_mismatch");
    }
    let token: string | undefined;
    try {
      const expectedRef = buildMobilePushTokenSecretRef(registration.registrationId);
      if (registration.tokenSecretRef !== expectedRef) {
        return await this.blockMismatchedCustody(delivery, registration);
      }
      token = this.deps.secretStore.getSecret(accountFromMobilePushSecretRef(expectedRef))?.trim();
    } catch {
      return await this.retry(delivery, "custody_unavailable");
    }
    if (!token || !registration.tokenSha256 || !safeDigestEqual(sha256(token), registration.tokenSha256)) {
      return await this.blockMismatchedCustody(delivery, registration);
    }

    let providerResult: MobilePushProviderResult;
    try {
      providerResult = await this.deps.provider.send({
        deliveryId: delivery.deliveryId,
        provider: registration.provider,
        token,
        payload: delivery.payload,
      });
    } catch {
      providerResult = { classification: "unknown_after_send" };
    }
    switch (providerResult.classification) {
      case "delivered":
        return await this.finalize(
          delivery,
          "delivered",
          "delivered",
          providerResult.receiptId ? sha256(providerResult.receiptId) : undefined,
        );
      case "invalid_token":
        return await this.invalidateToken(delivery, registration);
      case "retryable":
        return await this.retry(delivery, "retryable", providerResult.retryAfterMs);
      case "provider_unavailable":
        return await this.retry(delivery, "provider_unavailable", providerResult.retryAfterMs);
      case "unknown_after_send":
        return await this.finalize(delivery, "unknown_after_send", "unknown_after_send");
    }
  }

  private async invalidateToken(
    delivery: MobilePushDeliveryRecord,
    registration: MobilePushRegistrationRecord,
  ): Promise<MobilePushDeliverySweepResult["outcomes"][number]> {
    const outcome = await this.deps.storage.mobilePush.finalizeAndRevokeRegistration({
      deliveryId: delivery.deliveryId,
      expectedVersion: delivery.version,
      expectedLeaseExpiresAt: delivery.leaseExpiresAt!,
      workerId: this.workerId,
      status: "invalid_token",
      lastClassification: "invalid_token",
      updatedAt: this.nowIso(),
    });
    if (!outcome.delivery) return { deliveryId: delivery.deliveryId, status: "lease_lost" };
    this.deleteSecretBestEffort(registration, "delivery_revoke");
    return {
      deliveryId: delivery.deliveryId,
      status: outcome.delivery.status,
      classification: outcome.delivery.lastClassification,
    };
  }

  private async blockMismatchedCustody(
    delivery: MobilePushDeliveryRecord,
    registration: MobilePushRegistrationRecord,
  ): Promise<MobilePushDeliverySweepResult["outcomes"][number]> {
    const outcome = await this.deps.storage.mobilePush.finalizeAndRevokeRegistration({
      deliveryId: delivery.deliveryId,
      expectedVersion: delivery.version,
      expectedLeaseExpiresAt: delivery.leaseExpiresAt!,
      workerId: this.workerId,
      status: "custody_blocked",
      lastClassification: "custody_mismatch",
      updatedAt: this.nowIso(),
    });
    if (!outcome.delivery) return { deliveryId: delivery.deliveryId, status: "lease_lost" };
    this.deleteSecretBestEffort(registration, "delivery_revoke");
    return {
      deliveryId: delivery.deliveryId,
      status: outcome.delivery.status,
      classification: outcome.delivery.lastClassification,
    };
  }

  private async revokeInactiveGrant(
    delivery: MobilePushDeliveryRecord,
    registration: MobilePushRegistrationRecord,
  ): Promise<MobilePushDeliverySweepResult["outcomes"][number]> {
    const outcome = await this.deps.storage.mobilePush.finalizeAndRevokeRegistration({
      deliveryId: delivery.deliveryId,
      expectedVersion: delivery.version,
      expectedLeaseExpiresAt: delivery.leaseExpiresAt!,
      workerId: this.workerId,
      status: "cancelled_revoked",
      lastClassification: "registration_revoked",
      updatedAt: this.nowIso(),
    });
    if (!outcome.delivery) return { deliveryId: delivery.deliveryId, status: "lease_lost" };
    this.deleteSecretBestEffort(registration, "delivery_revoke");
    return {
      deliveryId: delivery.deliveryId,
      status: outcome.delivery.status,
      classification: outcome.delivery.lastClassification,
    };
  }

  private async retry(
    delivery: MobilePushDeliveryRecord,
    classification: "retryable" | "provider_unavailable" | "custody_unavailable" | "grant_validation_unavailable",
    requestedRetryAfterMs?: number,
  ): Promise<MobilePushDeliverySweepResult["outcomes"][number]> {
    if (delivery.attemptCount >= delivery.maxAttempts) {
      return await this.finalize(delivery, "dead_lettered", classification);
    }
    const retryAfterMs = clampRetryDelay(requestedRetryAfterMs, delivery.attemptCount);
    const outcome = await this.deps.storage.mobilePush.finalizeDelivery({
      deliveryId: delivery.deliveryId,
      expectedVersion: delivery.version,
      expectedLeaseExpiresAt: delivery.leaseExpiresAt!,
      workerId: this.workerId,
      status: "retry_scheduled",
      lastClassification: classification,
      nextAttemptAt: new Date(this.now().getTime() + retryAfterMs).toISOString(),
      updatedAt: this.nowIso(),
    });
    return outcome
      ? { deliveryId: delivery.deliveryId, status: outcome.status, classification: outcome.lastClassification }
      : { deliveryId: delivery.deliveryId, status: "lease_lost" };
  }

  private async finalize(
    delivery: MobilePushDeliveryRecord,
    status: "delivered" | "unknown_after_send" | "dead_lettered" | "custody_blocked" | "cancelled_revoked",
    classification: MobilePushDeliveryClassification,
    providerReceiptSha256?: string,
  ): Promise<MobilePushDeliverySweepResult["outcomes"][number]> {
    const outcome = await this.deps.storage.mobilePush.finalizeDelivery({
      deliveryId: delivery.deliveryId,
      expectedVersion: delivery.version,
      expectedLeaseExpiresAt: delivery.leaseExpiresAt!,
      workerId: this.workerId,
      status,
      lastClassification: classification,
      providerReceiptSha256,
      updatedAt: this.nowIso(),
    });
    return outcome
      ? { deliveryId: delivery.deliveryId, status: outcome.status, classification: outcome.lastClassification }
      : { deliveryId: delivery.deliveryId, status: "lease_lost" };
  }

  private assertWriteCustodyAvailable(): void {
    if (!this.deps.secretStore.isAvailable() || !this.deps.secretStore.isWriteCustodySafe()) {
      throw new MobilePushCustodyError();
    }
  }

  private providerAvailable(): boolean {
    try {
      return this.deps.provider.isAvailable();
    } catch {
      return false;
    }
  }

  private deleteSecretBestEffort(
    registration: Pick<MobilePushRegistrationRecord, "registrationId">,
    operation: MobilePushDiagnostic["context"]["operation"],
  ): void {
    try {
      const expectedRef = buildMobilePushTokenSecretRef(registration.registrationId);
      this.deps.secretStore.deleteSecret(accountFromMobilePushSecretRef(expectedRef));
    } catch {
      this.recordCleanupFailure(registration.registrationId, operation);
    }
  }

  private recordCleanupFailure(registrationId: string, operation: MobilePushDiagnostic["context"]["operation"]): void {
    try {
      this.deps.recordDiagnostic?.({
        event: "mobile_push.keychain_cleanup_failed",
        message: "Mobile push metadata was revoked, but orphaned keychain custody requires operator cleanup.",
        context: { registrationId, operation },
      });
    } catch {
      // Durable revocation remains authoritative even if diagnostic reporting is unavailable.
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

export async function enqueueMobilePushApprovalRefresh(
  storage: MobilePushStorage,
  event: RealtimeEvent,
): Promise<number> {
  if (
    event.eventType !== "approval_created" ||
    event.source !== "approvals" ||
    event.eventClass !== "domain_fact" ||
    event.eventAuthority !== "retained_stream"
  ) {
    return 0;
  }
  const payloadApprovalId = readOpaqueId(event.payload.approvalId);
  const linkedApprovalId = readOpaqueId(event.links?.approvalId);
  const realtimeEventId = readOpaqueId(event.eventId);
  if (!payloadApprovalId || payloadApprovalId !== linkedApprovalId || !realtimeEventId) return 0;
  return (
    await storage.mobilePush.enqueueApprovalRefresh({
      sourceRealtimeEventId: realtimeEventId,
      approvalId: payloadApprovalId,
    })
  ).length;
}

export function buildMobilePushTokenSecretRef(registrationId: string): string {
  if (!/^mpr_[0-9a-f]{40}$/u.test(registrationId)) {
    throw new MobilePushCustodyError("Mobile push registration custody reference is invalid.");
  }
  return `${MOBILE_PUSH_SECRET_REF_PREFIX}${registrationId}`;
}

function accountFromMobilePushSecretRef(secretRef: string): string {
  if (!secretRef.startsWith(MOBILE_PUSH_SECRET_REF_PREFIX)) {
    throw new MobilePushCustodyError("Mobile push registration custody reference is invalid.");
  }
  const registrationId = secretRef.slice(MOBILE_PUSH_SECRET_REF_PREFIX.length);
  buildMobilePushTokenSecretRef(registrationId);
  return `mobile-push:${registrationId}`;
}

function registrationResponse(
  registration: MobilePushRegistrationRecord,
  providerAvailable: boolean,
): MobilePushRegistrationResponse {
  return {
    registrationId: registration.registrationId,
    provider: registration.provider,
    registeredAt: registration.registeredAt,
    updatedAt: registration.updatedAt,
    enabled: registration.lifecycleState === "active",
    deliveryAvailability: providerAvailable ? "available" : "unavailable",
    revision: registration.revision,
  };
}

function requireGrantId(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 256) {
    throw new MobilePushCustodyError("A durable companion grant is required for mobile push registration.");
  }
  return normalized;
}

function readOpaqueId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value) ? value : undefined;
}

function sanitizeRegistrationMetadata(value: string | undefined, rawToken: string | undefined): string | undefined {
  if (!value) return undefined;
  let sanitized = redactSecretText(value).value;
  if (rawToken && sanitized.includes(rawToken)) sanitized = sanitized.split(rawToken).join("[REDACTED]");
  return sanitized;
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function clampRetryDelay(requestedMs: number | undefined, attemptCount: number): number {
  if (Number.isFinite(requestedMs)) {
    return Math.max(1_000, Math.min(MAX_RETRY_MS, Math.floor(requestedMs!)));
  }
  return Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS * 2 ** Math.max(0, attemptCount - 1));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

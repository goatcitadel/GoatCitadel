import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Storage, deriveMobilePushRegistrationId } from "./index.js";
import { MOBILE_PUSH_POSTGRES_SCHEMA_SQL } from "./postgres/mobile-push-schema.js";

function createStorage(): Storage {
  return new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
}

function secretRef(registrationId: string): string {
  return `keychain:goatcitadel:mobile-push:${registrationId}`;
}

describe("MobilePushRepository", () => {
  it("keeps registration rotation and revocation idempotent", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-1");
    const registrationId = deriveMobilePushRegistrationId("grant-1", "expo");
    const base = {
      registrationId,
      grantId: "grant-1",
      provider: "expo" as const,
      tokenSecretRef: secretRef(registrationId),
      tokenSha256: "a".repeat(64),
      companionSessionId: "companion-1",
      deviceLabel: "Pixel",
      appVersion: "1.0.0",
    };

    const created = storage.mobilePush.upsertActiveRegistration({ ...base, now: "2026-08-09T01:00:00.000Z" });
    const replayed = storage.mobilePush.upsertActiveRegistration({ ...base, now: "2026-08-09T01:01:00.000Z" });
    assert.equal(created.revision, 1);
    assert.equal(replayed.revision, 1);
    assert.equal(replayed.updatedAt, created.updatedAt);

    const rotated = storage.mobilePush.upsertActiveRegistration({
      ...base,
      tokenSha256: "b".repeat(64),
      now: "2026-08-09T01:02:00.000Z",
    });
    assert.equal(rotated.registrationId, registrationId);
    assert.equal(rotated.revision, 2);
    assert.equal(rotated.tokenSha256, "b".repeat(64));
    const [pending] = storage.mobilePush.enqueueApprovalRefresh({
      sourceRealtimeEventId: "event-before-revoke",
      approvalId: "approval-before-revoke",
      now: "2026-08-09T01:02:30.000Z",
    });
    assert.equal(pending?.status, "queued");

    const revoked = storage.mobilePush.ensureRevokedRegistration({
      ...base,
      now: "2026-08-09T01:03:00.000Z",
    });
    const replayedRevoke = storage.mobilePush.ensureRevokedRegistration({
      ...base,
      now: "2026-08-09T01:04:00.000Z",
    });
    assert.equal(revoked.lifecycleState, "revoked");
    assert.equal(revoked.tokenSha256, undefined);
    assert.equal(replayedRevoke.revision, revoked.revision);
    assert.equal(replayedRevoke.revokedAt, revoked.revokedAt);
    assert.equal(storage.mobilePush.getDelivery(pending!.deliveryId).status, "cancelled_revoked");
    storage.close();
  });

  it("stores one content-free approval refresh delivery per active registration and approval", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-2");
    const registrationId = deriveMobilePushRegistrationId("grant-2", "fcm");
    storage.mobilePush.upsertActiveRegistration({
      registrationId,
      grantId: "grant-2",
      provider: "fcm",
      tokenSecretRef: secretRef(registrationId),
      tokenSha256: "c".repeat(64),
      now: "2026-08-09T02:00:00.000Z",
    });

    const first = storage.mobilePush.enqueueApprovalRefresh({
      sourceRealtimeEventId: "event-1",
      approvalId: "approval-1",
      now: "2026-08-09T02:01:00.000Z",
    });
    const replay = storage.mobilePush.enqueueApprovalRefresh({
      sourceRealtimeEventId: "event-duplicate-observability-retry",
      approvalId: "approval-1",
      now: "2026-08-09T02:02:00.000Z",
    });
    assert.equal(first.length, 1);
    assert.equal(replay[0]?.deliveryId, first[0]?.deliveryId);
    assert.equal(storage.mobilePush.listDeliveries().length, 1);
    assert.equal(replay[0]?.sourceRealtimeEventId, "event-1");
    assert.equal(replay[0]?.approvalId, "approval-1");
    assert.deepEqual(first[0]?.payload, {
      schemaVersion: 1,
      type: "approval_refresh",
      realtimeEventId: "event-1",
      approvalId: "approval-1",
      deepLink: { kind: "approval", approvalId: "approval-1" },
    });
    const raw = storage.db
      .prepare("SELECT payload_json FROM mobile_push_deliveries WHERE delivery_id = ?")
      .get(first[0]!.deliveryId) as { payload_json: string };
    assert.doesNotMatch(raw.payload_json, /title|message|preview|risk|token|secret/i);
    storage.close();
  });

  it("claims with CAS and atomically revokes an invalid provider token", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-3");
    const registrationId = deriveMobilePushRegistrationId("grant-3", "expo");
    storage.mobilePush.upsertActiveRegistration({
      registrationId,
      grantId: "grant-3",
      provider: "expo",
      tokenSecretRef: secretRef(registrationId),
      tokenSha256: "d".repeat(64),
      now: "2026-08-09T03:00:00.000Z",
    });
    const [queued] = storage.mobilePush.enqueueApprovalRefresh({
      sourceRealtimeEventId: "event-2",
      approvalId: "approval-2",
      now: "2026-08-09T03:01:00.000Z",
    });
    assert.ok(queued);
    const claim = storage.mobilePush.claimDelivery({
      deliveryId: queued.deliveryId,
      expectedVersion: queued.version,
      workerId: "worker-1",
      claimedAt: "2026-08-09T03:02:00.000Z",
      leaseExpiresAt: "2026-08-09T03:03:00.000Z",
    });
    assert.ok(claim);
    assert.equal(
      storage.mobilePush.claimDelivery({
        deliveryId: queued.deliveryId,
        expectedVersion: queued.version,
        workerId: "worker-2",
        claimedAt: "2026-08-09T03:02:00.000Z",
        leaseExpiresAt: "2026-08-09T03:03:00.000Z",
      }),
      undefined,
    );

    const outcome = storage.mobilePush.finalizeAndRevokeRegistration({
      deliveryId: claim.deliveryId,
      expectedVersion: claim.version,
      expectedLeaseExpiresAt: claim.leaseExpiresAt!,
      workerId: "worker-1",
      status: "invalid_token",
      lastClassification: "invalid_token",
      updatedAt: "2026-08-09T03:02:30.000Z",
    });
    assert.equal(outcome.delivery?.status, "invalid_token");
    assert.equal(outcome.registration?.lifecycleState, "revoked");
    assert.equal(outcome.registration?.tokenSha256, undefined);
    storage.close();
  });

  it("fences registration on the durable grant row and retains the grant foreign key", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-fenced");
    const registrationId = deriveMobilePushRegistrationId("grant-fenced", "expo");
    const registered = storage.mobilePush.upsertActiveRegistration({
      registrationId,
      grantId: "grant-fenced",
      provider: "expo",
      tokenSecretRef: secretRef(registrationId),
      tokenSha256: "e".repeat(64),
      now: "2026-08-09T04:00:00.000Z",
    });

    const foreignKeys = storage.db.prepare("PRAGMA foreign_key_list(mobile_push_registrations)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    assert.ok(
      foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === "auth_device_grants" &&
          foreignKey.from === "grant_id" &&
          foreignKey.to === "grant_id" &&
          foreignKey.on_delete === "RESTRICT",
      ),
    );
    assert.match(
      MOBILE_PUSH_POSTGRES_SCHEMA_SQL,
      /grant_id TEXT NOT NULL REFERENCES auth_device_grants\(grant_id\) ON DELETE RESTRICT/u,
    );
    assert.throws(
      () => storage.db.prepare("DELETE FROM auth_device_grants WHERE grant_id = ?").run("grant-fenced"),
      /FOREIGN KEY constraint failed/u,
    );

    storage.db
      .prepare("UPDATE auth_device_grants SET revoked_at = ? WHERE grant_id = ?")
      .run("2026-08-09T04:01:00.000Z", "grant-fenced");
    assert.throws(
      () =>
        storage.mobilePush.upsertActiveRegistration({
          registrationId,
          grantId: "grant-fenced",
          provider: "expo",
          tokenSecretRef: secretRef(registrationId),
          tokenSha256: "f".repeat(64),
          now: "2026-08-09T04:02:00.000Z",
        }),
      /active durable device grant/u,
    );
    assert.equal(storage.mobilePush.getRegistrationById(registrationId)?.tokenSha256, registered.tokenSha256);

    seedActiveGrant(storage, "grant-expired", { expiresAt: "2000-01-01T00:00:00.000Z" });
    const expiredRegistrationId = deriveMobilePushRegistrationId("grant-expired", "fcm");
    assert.throws(
      () =>
        storage.mobilePush.upsertActiveRegistration({
          registrationId: expiredRegistrationId,
          grantId: "grant-expired",
          provider: "fcm",
          tokenSecretRef: secretRef(expiredRegistrationId),
          tokenSha256: "a".repeat(64),
        }),
      /active durable device grant/u,
    );
    storage.close();
  });

  it("refuses the send fence after a revocation or rotation commits, and settles an armed send exactly once", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-fence");
    const registrationId = deriveMobilePushRegistrationId("grant-fence", "expo");
    const base = {
      registrationId,
      grantId: "grant-fence",
      provider: "expo" as const,
      tokenSecretRef: secretRef(registrationId),
      tokenSha256: "a".repeat(64),
    };
    const registration = storage.mobilePush.upsertActiveRegistration({ ...base, now: "2026-08-11T06:00:00.000Z" });
    const [queued] = storage.mobilePush.enqueueApprovalRefresh({
      sourceRealtimeEventId: "event-fence",
      approvalId: "approval-fence",
      now: "2026-08-11T06:01:00.000Z",
    });
    assert.ok(queued);
    const claimed = storage.mobilePush.claimDelivery({
      deliveryId: queued.deliveryId,
      expectedVersion: queued.version,
      workerId: "worker-fence",
      claimedAt: "2026-08-11T06:02:00.000Z",
      leaseExpiresAt: "2026-08-11T06:03:00.000Z",
    });
    assert.ok(claimed);

    // A revocation committing before the fence wins: no send may follow.
    storage.mobilePush.ensureRevokedRegistration({ ...base, now: "2026-08-11T06:02:10.000Z" });
    const refusedRevoked = storage.mobilePush.armDeliverySendFence({
      deliveryId: claimed.deliveryId,
      registrationId,
      expectedVersion: claimed.version,
      expectedRegistrationRevision: registration.revision,
      expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
      workerId: "worker-fence",
      armedAt: "2026-08-11T06:02:20.000Z",
    });
    assert.deepEqual(refusedRevoked, { armed: false, reason: "registration_revoked" });
    // The claimed running row is untouched by the refusal and still settles once.
    assert.equal(storage.mobilePush.getDelivery(claimed.deliveryId).status, "running");
    assert.equal(storage.mobilePush.getDelivery(claimed.deliveryId).version, claimed.version);

    // Re-arm path: a token rotation after claim refuses the fence too.
    const reactivated = storage.mobilePush.upsertActiveRegistration({ ...base, now: "2026-08-11T06:04:00.000Z" });
    const refusedRotated = storage.mobilePush.armDeliverySendFence({
      deliveryId: claimed.deliveryId,
      registrationId,
      expectedVersion: claimed.version,
      expectedRegistrationRevision: reactivated.revision - 1,
      expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
      workerId: "worker-fence",
      armedAt: "2026-08-11T06:04:10.000Z",
    });
    assert.deepEqual(refusedRotated, { armed: false, reason: "registration_rotated" });

    // With an active, unrotated registration the fence arms and bumps the CAS version.
    const armed = storage.mobilePush.armDeliverySendFence({
      deliveryId: claimed.deliveryId,
      registrationId,
      expectedVersion: claimed.version,
      expectedRegistrationRevision: reactivated.revision,
      expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
      workerId: "worker-fence",
      armedAt: "2026-08-11T06:05:00.000Z",
    });
    assert.ok(armed.armed);
    assert.equal(armed.delivery.version, claimed.version + 1);
    assert.equal(armed.delivery.status, "running");

    // The fence is single-use: replaying with the pre-fence version loses the lease.
    const replayedFence = storage.mobilePush.armDeliverySendFence({
      deliveryId: claimed.deliveryId,
      registrationId,
      expectedVersion: claimed.version,
      expectedRegistrationRevision: reactivated.revision,
      expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
      workerId: "worker-fence",
      armedAt: "2026-08-11T06:05:10.000Z",
    });
    assert.deepEqual(replayedFence, { armed: false, reason: "lease_lost" });

    // A finalize with the stale pre-fence version cannot settle the delivery...
    assert.equal(
      storage.mobilePush.finalizeDelivery({
        deliveryId: claimed.deliveryId,
        expectedVersion: claimed.version,
        expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
        workerId: "worker-fence",
        status: "delivered",
        lastClassification: "delivered",
        updatedAt: "2026-08-11T06:06:00.000Z",
      }),
      undefined,
    );
    // ...while the armed worker settles exactly once with the honest receipt.
    const settled = storage.mobilePush.finalizeDelivery({
      deliveryId: claimed.deliveryId,
      expectedVersion: armed.delivery.version,
      expectedLeaseExpiresAt: armed.delivery.leaseExpiresAt!,
      workerId: "worker-fence",
      status: "delivered",
      lastClassification: "delivered",
      providerReceiptSha256: "b".repeat(64),
      updatedAt: "2026-08-11T06:06:30.000Z",
    });
    assert.equal(settled?.status, "delivered");
    assert.equal(settled?.providerReceiptSha256, "b".repeat(64));
    assert.equal(
      storage.mobilePush.finalizeDelivery({
        deliveryId: claimed.deliveryId,
        expectedVersion: armed.delivery.version,
        expectedLeaseExpiresAt: armed.delivery.leaseExpiresAt!,
        workerId: "worker-fence",
        status: "delivered",
        lastClassification: "delivered",
        updatedAt: "2026-08-11T06:07:00.000Z",
      }),
      undefined,
    );
    storage.close();
  });

  it("keeps an armed in-flight send settling honestly when revocation races after the fence", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-fence-race");
    const registrationId = deriveMobilePushRegistrationId("grant-fence-race", "expo");
    const base = {
      registrationId,
      grantId: "grant-fence-race",
      provider: "expo" as const,
      tokenSecretRef: secretRef(registrationId),
      tokenSha256: "c".repeat(64),
    };
    const registration = storage.mobilePush.upsertActiveRegistration({ ...base, now: "2026-08-11T07:00:00.000Z" });
    const [queued] = storage.mobilePush.enqueueApprovalRefresh({
      sourceRealtimeEventId: "event-fence-race",
      approvalId: "approval-fence-race",
      now: "2026-08-11T07:01:00.000Z",
    });
    const claimed = storage.mobilePush.claimDelivery({
      deliveryId: queued!.deliveryId,
      expectedVersion: queued!.version,
      workerId: "worker-race",
      claimedAt: "2026-08-11T07:02:00.000Z",
      leaseExpiresAt: "2026-08-11T07:03:00.000Z",
    });
    const armed = storage.mobilePush.armDeliverySendFence({
      deliveryId: claimed!.deliveryId,
      registrationId,
      expectedVersion: claimed!.version,
      expectedRegistrationRevision: registration.revision,
      expectedLeaseExpiresAt: claimed!.leaseExpiresAt!,
      workerId: "worker-race",
      armedAt: "2026-08-11T07:02:30.000Z",
    });
    assert.ok(armed.armed);

    // Revocation lands while the send is in flight: it cancels only pending
    // rows and leaves the running one for the worker's honest settlement.
    storage.mobilePush.ensureRevokedRegistration({ ...base, now: "2026-08-11T07:02:40.000Z" });
    assert.equal(storage.mobilePush.getDelivery(claimed!.deliveryId).status, "running");

    const settled = storage.mobilePush.finalizeDelivery({
      deliveryId: claimed!.deliveryId,
      expectedVersion: armed.delivery.version,
      expectedLeaseExpiresAt: armed.delivery.leaseExpiresAt!,
      workerId: "worker-race",
      status: "delivered",
      lastClassification: "delivered",
      providerReceiptSha256: "d".repeat(64),
      updatedAt: "2026-08-11T07:02:50.000Z",
    });
    assert.equal(settled?.status, "delivered");
    assert.equal(settled?.providerReceiptSha256, "d".repeat(64));
    assert.equal(storage.mobilePush.getRegistrationById(registrationId)?.lifecycleState, "revoked");
    storage.close();
  });

  it("does not grow the outbox across an auth-revoke crash gap or expired grant", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-crash-gap");
    const revokedRegistrationId = deriveMobilePushRegistrationId("grant-crash-gap", "expo");
    storage.mobilePush.upsertActiveRegistration({
      registrationId: revokedRegistrationId,
      grantId: "grant-crash-gap",
      provider: "expo",
      tokenSecretRef: secretRef(revokedRegistrationId),
      tokenSha256: "1".repeat(64),
    });
    storage.db
      .prepare("UPDATE auth_device_grants SET revoked_at = ? WHERE grant_id = ?")
      .run("2026-08-09T05:00:00.000Z", "grant-crash-gap");

    assert.deepEqual(
      storage.mobilePush.enqueueApprovalRefresh({
        sourceRealtimeEventId: "event-after-auth-revoke",
        approvalId: "approval-after-auth-revoke",
      }),
      [],
    );
    assert.equal(storage.mobilePush.getRegistrationById(revokedRegistrationId)?.lifecycleState, "active");

    seedActiveGrant(storage, "grant-expires-after-registration");
    const expiredRegistrationId = deriveMobilePushRegistrationId("grant-expires-after-registration", "fcm");
    storage.mobilePush.upsertActiveRegistration({
      registrationId: expiredRegistrationId,
      grantId: "grant-expires-after-registration",
      provider: "fcm",
      tokenSecretRef: secretRef(expiredRegistrationId),
      tokenSha256: "2".repeat(64),
    });
    storage.db
      .prepare("UPDATE auth_device_grants SET expires_at = ? WHERE grant_id = ?")
      .run("2000-01-01T00:00:00.000Z", "grant-expires-after-registration");

    assert.deepEqual(
      storage.mobilePush.enqueueApprovalRefresh({
        sourceRealtimeEventId: "event-after-grant-expiry",
        approvalId: "approval-after-grant-expiry",
      }),
      [],
    );
    assert.deepEqual(storage.mobilePush.listActiveRegistrations(), []);
    assert.deepEqual(storage.mobilePush.listDeliveries(), []);
    storage.close();
  });
});

function seedActiveGrant(
  storage: Storage,
  grantId: string,
  options: { expiresAt?: string; revokedAt?: string } = {},
): void {
  const requestId = `request-${sha256(grantId).slice(0, 24)}`;
  storage.db
    .prepare(
      `INSERT INTO auth_device_requests (
         request_id, approval_id, request_secret_hash, device_label, device_type, status,
         created_at, expires_at, resolved_at, resolved_by, principal_purpose
       ) VALUES (
         @requestId, @approvalId, @requestSecretHash, 'Push test device', 'test', 'approved',
         @createdAt, @requestExpiresAt, @createdAt, 'operator:test', 'general_companion'
       )`,
    )
    .run({
      requestId,
      approvalId: `approval-${sha256(grantId).slice(0, 24)}`,
      requestSecretHash: sha256(`request-secret:${grantId}`),
      createdAt: "2026-08-09T00:00:00.000Z",
      requestExpiresAt: "2999-01-01T00:00:00.000Z",
    });
  storage.db
    .prepare(
      `INSERT INTO auth_device_grants (
         grant_id, request_id, token_hash, device_label, device_type, granted_by,
         created_at, expires_at, revoked_at, metadata_json, principal_purpose
       ) VALUES (
         @grantId, @requestId, @tokenHash, 'Push test device', 'test', 'operator:test',
         @createdAt, @expiresAt, @revokedAt, '{}', 'general_companion'
       )`,
    )
    .run({
      grantId,
      requestId,
      tokenHash: sha256(`device-token:${grantId}`),
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: options.expiresAt ?? null,
      revokedAt: options.revokedAt ?? null,
    });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, deriveMobilePushRegistrationId, Storage } from "@goatcitadel/storage";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import {
  createUnavailableMobilePushProvider,
  enqueueMobilePushApprovalRefresh,
  MobilePushCustodyError,
  MobilePushService,
  type MobilePushProviderPort,
} from "./mobile-push-service.js";

const stores: Storage[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("MobilePushService", () => {
  it("computes the authoritative hash and keeps the raw token in deterministic keychain custody", async () => {
    const harness = createHarness();
    harness.seedGrant("grant-1");
    const token = "ExpoPushToken[raw-provider-secret]";

    const first = await harness.service.register(
      { provider: "expo", enabled: true, token, deviceLabel: "Pixel" },
      { grantId: "grant-1", companionSessionId: "companion-1" },
    );
    const replay = await harness.service.register(
      { provider: "expo", enabled: true, token, deviceLabel: "Pixel" },
      { grantId: "grant-1", companionSessionId: "companion-1" },
    );

    expect(replay).toEqual(first);
    expect(first.revision).toBe(1);
    expect(first.deliveryAvailability).toBe("unavailable");
    expect([...harness.secrets.values()]).toEqual([token]);
    const row = harness.sync.db
      .prepare("SELECT token_sha256, token_secret_ref FROM mobile_push_registrations WHERE registration_id = ?")
      .get(first.registrationId) as { token_sha256: string; token_secret_ref: string };
    expect(row.token_sha256).toBe(sha256(token));
    expect(row.token_secret_ref).toBe(`keychain:goatcitadel:mobile-push:${first.registrationId}`);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("restores the prior keychain value when metadata persistence fails", async () => {
    const registrationId = deriveMobilePushRegistrationId("synthetic-grant", "expo");
    const account = `mobile-push:${registrationId}`;
    const secrets = new Map([[account, "prior-token"]]);
    const secretStore = createSecretStore(secrets);
    const service = new MobilePushService({
      storage: {
        mobilePush: {
          upsertActiveRegistration: vi.fn(async () => {
            throw new Error("database unavailable");
          }),
        },
      } as never,
      secretStore: secretStore as never,
      provider: createUnavailableMobilePushProvider(),
      isGrantActive: async () => true,
    });

    await expect(
      service.register({ provider: "expo", enabled: true, token: "replacement-token" }, { grantId: "synthetic-grant" }),
    ).rejects.toThrow("database unavailable");
    expect(secrets.get(account)).toBe("prior-token");
  });

  it("restores the prior keychain value when a token write mutates and then fails", async () => {
    const grantId = "partial-write-grant";
    const registrationId = deriveMobilePushRegistrationId(grantId, "expo");
    const account = `mobile-push:${registrationId}`;
    const secrets = new Map([[account, "prior-token"]]);
    const secretStore = createSecretStore(secrets);
    let writeCount = 0;
    secretStore.setSecret.mockImplementation((key, secret) => {
      secrets.set(key, secret);
      writeCount += 1;
      if (writeCount === 1) throw new Error(`partial write exposed ${secret}`);
    });
    const harness = createHarness(createUnavailableMobilePushProvider(), undefined, secretStore);

    await expect(
      harness.service.register({ provider: "expo", enabled: true, token: "replacement-token" }, { grantId }),
    ).rejects.toBeInstanceOf(MobilePushCustodyError);

    expect(secrets.get(account)).toBe("prior-token");
    expect(writeCount).toBe(2);
  });

  it("projects only a minimal idempotent approval refresh and hashes provider receipts", async () => {
    const provider: MobilePushProviderPort = {
      isAvailable: () => true,
      send: vi.fn(async () => ({ classification: "delivered", receiptId: "provider-receipt-secret" })),
    };
    const harness = createHarness(provider);
    harness.seedGrant("grant-2");
    const token = "fcm-raw-token";
    await expect(
      harness.service.register({ provider: "fcm", enabled: true, token }, { grantId: "grant-2" }),
    ).resolves.toMatchObject({ enabled: true, deliveryAvailability: "available" });
    const event = approvalCreatedEvent("event-1", "approval-1");

    await expect(enqueueMobilePushApprovalRefresh(harness.storage, event)).resolves.toBe(1);
    await expect(
      enqueueMobilePushApprovalRefresh(
        harness.storage,
        approvalCreatedEvent("event-observability-retry", "approval-1"),
      ),
    ).resolves.toBe(1);
    const sweep = await harness.service.deliverDue();

    expect(sweep.outcomes).toEqual([expect.objectContaining({ status: "delivered", classification: "delivered" })]);
    const deliveries = await harness.storage.mobilePush.listDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toEqual({
      schemaVersion: 1,
      type: "approval_refresh",
      realtimeEventId: "event-1",
      approvalId: "approval-1",
      deepLink: { kind: "approval", approvalId: "approval-1" },
    });
    expect(deliveries[0]?.providerReceiptSha256).toBe(sha256("provider-receipt-secret"));
    expect(JSON.stringify(deliveries)).not.toContain(token);
    expect(JSON.stringify(deliveries)).not.toContain("provider-receipt-secret");
  });

  it("classifies retry and an ambiguous provider throw without duplicate retry", async () => {
    let clock = Date.parse("2026-08-09T04:00:00.000Z");
    const send = vi
      .fn<MobilePushProviderPort["send"]>()
      .mockResolvedValueOnce({ classification: "retryable", retryAfterMs: 1_000 })
      .mockRejectedValueOnce(new Error("ambiguous provider failure"));
    const harness = createHarness({ isAvailable: () => true, send }, () => new Date(clock));
    harness.seedGrant("grant-3");
    await harness.service.register(
      { provider: "expo", enabled: true, token: "ExpoPushToken[retry-token]" },
      { grantId: "grant-3" },
    );
    await enqueueMobilePushApprovalRefresh(harness.storage, approvalCreatedEvent("event-2", "approval-2"));

    const first = await harness.service.deliverDue();
    expect(first.outcomes[0]).toMatchObject({ status: "retry_scheduled", classification: "retryable" });
    clock += 1_000;
    const second = await harness.service.deliverDue();
    expect(second.outcomes[0]).toMatchObject({
      status: "unknown_after_send",
      classification: "unknown_after_send",
    });
    expect(send).toHaveBeenCalledTimes(2);
    clock += 60_000;
    await expect(harness.service.deliverDue()).resolves.toMatchObject({ attempted: 0 });
  });

  it("refuses to send when a revocation commits between claim and the provider boundary", async () => {
    const send = vi.fn<MobilePushProviderPort["send"]>(async () => ({ classification: "delivered" }));
    const harness = createHarness({ isAvailable: () => true, send });
    harness.seedGrant("grant-fence-revoke");
    const token = "ExpoPushToken[fence-revoke]";
    await harness.service.register({ provider: "expo", enabled: true, token }, { grantId: "grant-fence-revoke" });
    await enqueueMobilePushApprovalRefresh(harness.storage, approvalCreatedEvent("event-fence-1", "approval-fence-1"));
    const [pending] = await harness.storage.mobilePush.listDeliveries();
    const registrationId = pending!.registrationId;

    // The revocation lands after the sweep's in-memory registration read but
    // before the provider boundary; the durable send fence must win.
    harness.secretStore.getSecret.mockImplementationOnce((account: string) => {
      const registration = harness.sync.mobilePush.getRegistrationById(registrationId)!;
      harness.sync.mobilePush.ensureRevokedRegistration({
        registrationId,
        grantId: registration.grantId,
        provider: registration.provider,
        tokenSecretRef: registration.tokenSecretRef,
      });
      return harness.secrets.get(account);
    });

    const sweep = await harness.service.deliverDue();
    expect(sweep.outcomes).toEqual([
      expect.objectContaining({ status: "cancelled_revoked", classification: "registration_revoked" }),
    ]);
    expect(send).not.toHaveBeenCalled();
    const delivery = await harness.storage.mobilePush.getDelivery(pending!.deliveryId);
    expect(delivery.status).toBe("cancelled_revoked");
    expect(delivery.completedAt).toBeDefined();
    // Settled exactly once: nothing remains due afterwards.
    await expect(harness.service.deliverDue()).resolves.toMatchObject({ attempted: 0 });
  });

  it("re-reads rotated custody through the fence and settles exactly once with the fresh token", async () => {
    let clock = Date.parse("2026-08-11T09:00:00.000Z");
    const send = vi.fn<MobilePushProviderPort["send"]>(async () => ({ classification: "delivered", receiptId: "r-1" }));
    const harness = createHarness({ isAvailable: () => true, send }, () => new Date(clock));
    harness.seedGrant("grant-fence-rotate");
    const oldToken = "ExpoPushToken[fence-old]";
    const newToken = "ExpoPushToken[fence-new]";
    await harness.service.register(
      { provider: "expo", enabled: true, token: oldToken },
      { grantId: "grant-fence-rotate" },
    );
    await enqueueMobilePushApprovalRefresh(harness.storage, approvalCreatedEvent("event-fence-2", "approval-fence-2"));
    const [pending] = await harness.storage.mobilePush.listDeliveries();
    const registrationId = pending!.registrationId;

    // Token rotation commits between the stale in-memory read and the send.
    harness.secretStore.getSecret.mockImplementationOnce(() => {
      const registration = harness.sync.mobilePush.getRegistrationById(registrationId)!;
      harness.sync.mobilePush.upsertActiveRegistration({
        registrationId,
        grantId: registration.grantId,
        provider: registration.provider,
        tokenSecretRef: registration.tokenSecretRef,
        tokenSha256: sha256(newToken),
      });
      harness.secrets.set(`mobile-push:${registrationId}`, newToken);
      return oldToken;
    });

    const first = await harness.service.deliverDue();
    expect(first.outcomes).toEqual([
      expect.objectContaining({ status: "retry_scheduled", classification: "retryable" }),
    ]);
    expect(send).not.toHaveBeenCalled();

    clock += 60_000;
    const second = await harness.service.deliverDue();
    expect(second.outcomes).toEqual([expect.objectContaining({ status: "delivered", classification: "delivered" })]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ token: newToken }));
    clock += 60_000;
    await expect(harness.service.deliverDue()).resolves.toMatchObject({ attempted: 0 });
  });

  it("quarantines an expired running lease even while the provider is unavailable", async () => {
    let clock = Date.parse("2026-08-09T05:00:00.000Z");
    const provider: MobilePushProviderPort = {
      isAvailable: () => false,
      send: vi.fn(async () => ({ classification: "delivered" })),
    };
    const harness = createHarness(provider, () => new Date(clock));
    harness.seedGrant("grant-expired-lease");
    await harness.service.register(
      { provider: "expo", enabled: true, token: "ExpoPushToken[expired-lease]" },
      { grantId: "grant-expired-lease" },
    );
    await enqueueMobilePushApprovalRefresh(
      harness.storage,
      approvalCreatedEvent("event-queued-before-expired-lease", "approval-queued-before-expired-lease"),
    );
    await enqueueMobilePushApprovalRefresh(
      harness.storage,
      approvalCreatedEvent("event-expired-lease", "approval-expired-lease"),
    );
    const [queuedBefore, queued] = await harness.storage.mobilePush.listDeliveries();
    expect(queuedBefore).toBeTruthy();
    expect(queued).toBeTruthy();
    const claimed = await harness.storage.mobilePush.claimDelivery({
      deliveryId: queued!.deliveryId,
      expectedVersion: queued!.version,
      workerId: "crashed-worker",
      claimedAt: new Date(clock).toISOString(),
      leaseExpiresAt: new Date(clock + 1_000).toISOString(),
    });
    expect(claimed).toMatchObject({ status: "running", attemptCount: 1 });

    clock += 1_000;
    const sweep = await harness.service.deliverDue(1);

    expect(sweep.providerAvailable).toBe(false);
    expect(sweep.outcomes).toEqual([
      expect.objectContaining({ status: "unknown_after_send", classification: "unknown_after_send" }),
    ]);
    expect(provider.send).not.toHaveBeenCalled();
    await expect(harness.storage.mobilePush.getDelivery(queuedBefore!.deliveryId)).resolves.toMatchObject({
      status: "queued",
      attemptCount: 0,
    });
    clock += 60_000;
    await expect(harness.service.deliverDue()).resolves.toMatchObject({ attempted: 0 });
  });

  it("fails closed on a token/hash mismatch and never calls the provider", async () => {
    const provider: MobilePushProviderPort = { isAvailable: () => true, send: vi.fn() };
    const harness = createHarness(provider);
    harness.seedGrant("grant-4");
    const registered = await harness.service.register(
      { provider: "expo", enabled: true, token: "ExpoPushToken[expected]" },
      { grantId: "grant-4" },
    );
    harness.secrets.set(`mobile-push:${registered.registrationId}`, "ExpoPushToken[replaced]");
    await enqueueMobilePushApprovalRefresh(harness.storage, approvalCreatedEvent("event-3", "approval-3"));

    const sweep = await harness.service.deliverDue();

    expect(sweep.outcomes[0]).toMatchObject({ status: "custody_blocked", classification: "custody_mismatch" });
    expect(provider.send).not.toHaveBeenCalled();
    await expect(harness.storage.mobilePush.getRegistrationById(registered.registrationId)).resolves.toMatchObject({
      lifecycleState: "revoked",
      tokenSha256: undefined,
    });
    expect(harness.secrets.has(`mobile-push:${registered.registrationId}`)).toBe(false);
  });

  it("atomically revokes custody when the durable device grant is no longer active", async () => {
    const provider: MobilePushProviderPort = { isAvailable: () => true, send: vi.fn() };
    const harness = createHarness(provider, undefined, undefined, async () => false);
    harness.seedGrant("grant-revoked");
    const registered = await harness.service.register(
      { provider: "expo", enabled: true, token: "ExpoPushToken[revoked-grant]" },
      { grantId: "grant-revoked" },
    );
    await enqueueMobilePushApprovalRefresh(harness.storage, approvalCreatedEvent("event-revoked", "approval-revoked"));

    const sweep = await harness.service.deliverDue();

    expect(sweep.outcomes).toEqual([
      expect.objectContaining({ status: "cancelled_revoked", classification: "registration_revoked" }),
    ]);
    expect(provider.send).not.toHaveBeenCalled();
    await expect(harness.storage.mobilePush.getRegistrationById(registered.registrationId)).resolves.toMatchObject({
      lifecycleState: "revoked",
      tokenSha256: undefined,
    });
    expect(harness.secrets.has(`mobile-push:${registered.registrationId}`)).toBe(false);
  });

  it("retries without sending when durable grant validation is unavailable", async () => {
    const provider: MobilePushProviderPort = { isAvailable: () => true, send: vi.fn() };
    const harness = createHarness(provider, undefined, undefined, async () => {
      throw new Error("auth storage unavailable");
    });
    harness.seedGrant("grant-validation-unavailable");
    await harness.service.register(
      { provider: "fcm", enabled: true, token: "fcm-grant-validation" },
      { grantId: "grant-validation-unavailable" },
    );
    await enqueueMobilePushApprovalRefresh(
      harness.storage,
      approvalCreatedEvent("event-grant-validation", "approval-grant-validation"),
    );

    const sweep = await harness.service.deliverDue();

    expect(sweep.outcomes).toEqual([
      expect.objectContaining({ status: "retry_scheduled", classification: "grant_validation_unavailable" }),
    ]);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("leaves queued work untouched while the production provider is unavailable", async () => {
    const harness = createHarness(createUnavailableMobilePushProvider());
    harness.seedGrant("grant-5");
    await harness.service.register(
      { provider: "expo", enabled: true, token: "ExpoPushToken[queued]" },
      { grantId: "grant-5" },
    );
    await enqueueMobilePushApprovalRefresh(harness.storage, approvalCreatedEvent("event-4", "approval-4"));

    await expect(harness.service.deliverDue()).resolves.toEqual({
      providerAvailable: false,
      attempted: 0,
      outcomes: [],
    });
    await expect(harness.storage.mobilePush.listDeliveries()).resolves.toEqual([
      expect.objectContaining({ status: "queued", attemptCount: 0 }),
    ]);
  });

  it("keeps a committed grant revoke successful when orphaned keychain cleanup fails", async () => {
    const secretStore = createSecretStore();
    const harness = createHarness(createUnavailableMobilePushProvider(), undefined, secretStore);
    harness.seedGrant("grant-cleanup-failure");
    const rawToken = "ExpoPushToken[orphaned-after-revoke]";
    const registered = await harness.service.register(
      { provider: "expo", enabled: true, token: rawToken },
      { grantId: "grant-cleanup-failure" },
    );
    secretStore.deleteSecret.mockImplementation(() => {
      throw new Error("keychain locked");
    });
    harness.diagnostics.mockImplementation(() => {
      throw new Error("diagnostic sink unavailable");
    });

    await expect(harness.service.revokeGrant("grant-cleanup-failure")).resolves.toEqual([
      expect.objectContaining({ registrationId: registered.registrationId, lifecycleState: "revoked" }),
    ]);

    await expect(harness.storage.mobilePush.getRegistrationById(registered.registrationId)).resolves.toMatchObject({
      lifecycleState: "revoked",
      tokenSha256: undefined,
    });
    expect(harness.diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mobile_push.keychain_cleanup_failed",
        context: expect.objectContaining({ registrationId: registered.registrationId, operation: "grant_revoke" }),
      }),
    );
    expect(JSON.stringify(harness.diagnostics.mock.calls)).not.toContain(rawToken);
  });

  it("derives cleanup custody from the registration id instead of trusting a stored secret ref", async () => {
    const harness = createHarness();
    harness.seedGrant("grant-cleanup-target");
    harness.seedGrant("grant-cleanup-unrelated");
    const target = await harness.service.register(
      { provider: "expo", enabled: true, token: "ExpoPushToken[target]" },
      { grantId: "grant-cleanup-target" },
    );
    const unrelated = await harness.service.register(
      { provider: "expo", enabled: true, token: "ExpoPushToken[unrelated]" },
      { grantId: "grant-cleanup-unrelated" },
    );
    harness.sync.db
      .prepare("UPDATE mobile_push_registrations SET token_secret_ref = ? WHERE registration_id = ?")
      .run(`keychain:goatcitadel:mobile-push:${unrelated.registrationId}`, target.registrationId);

    await harness.service.revokeGrant("grant-cleanup-target");

    expect(harness.secrets.has(`mobile-push:${target.registrationId}`)).toBe(false);
    expect(harness.secrets.get(`mobile-push:${unrelated.registrationId}`)).toBe("ExpoPushToken[unrelated]");
  });

  it("redacts keychain failures before they reach route error handling", async () => {
    const leakedToken = "ExpoPushToken[must-not-surface]";
    const secretStore = createSecretStore();
    secretStore.setSecret.mockImplementation(() => {
      throw new Error(`keychain failed for ${leakedToken}`);
    });
    const harness = createHarness(createUnavailableMobilePushProvider(), undefined, secretStore);

    let thrown: unknown;
    try {
      await harness.service.register({ provider: "expo", enabled: true, token: leakedToken }, { grantId: "grant-6" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MobilePushCustodyError);
    expect(String(thrown)).not.toContain(leakedToken);
  });
});

function createHarness(
  provider: MobilePushProviderPort = createUnavailableMobilePushProvider(),
  now?: () => Date,
  providedSecretStore?: ReturnType<typeof createSecretStore>,
  isGrantActive: (grantId: string) => Promise<boolean> = async () => true,
) {
  const sync = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
  stores.push(sync);
  const storage = createSqliteAsyncStorage(sync);
  const secrets = providedSecretStore?.values ?? new Map<string, string>();
  const secretStore = providedSecretStore ?? createSecretStore(secrets);
  const diagnostics = vi.fn();
  const service = new MobilePushService({
    storage,
    secretStore: secretStore as never,
    provider,
    isGrantActive,
    recordDiagnostic: diagnostics,
    now,
    workerId: "worker-test",
  });
  return {
    sync,
    storage,
    secrets,
    secretStore,
    diagnostics,
    service,
    seedGrant: (grantId: string, options?: { expiresAt?: string; revokedAt?: string }) =>
      seedActiveGrant(sync, grantId, options),
  };
}

function createSecretStore(values = new Map<string, string>()) {
  return {
    values,
    isAvailable: vi.fn(() => true),
    isWriteCustodySafe: vi.fn(() => true),
    setSecret: vi.fn((account: string, secret: string) => values.set(account, secret)),
    getSecret: vi.fn((account: string) => values.get(account)),
    deleteSecret: vi.fn((account: string) => values.delete(account)),
  };
}

function approvalCreatedEvent(eventId: string, approvalId: string): RealtimeEvent {
  return {
    eventId,
    sequence: 1,
    eventType: "approval_created",
    source: "approvals",
    timestamp: "2026-08-09T00:00:00.000Z",
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: { approvalId },
    payload: { approvalId, kind: "tool", riskLevel: "high", status: "pending" },
  };
}

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

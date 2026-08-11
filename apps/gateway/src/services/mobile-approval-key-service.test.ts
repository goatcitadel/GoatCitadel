import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAsyncStorage, deriveMobileApprovalKeyId, Storage } from "@goatcitadel/storage";
import {
  buildMobileApprovalDecisionSigningPayload,
  MOBILE_APPROVAL_DECISION_CONTRACT_V1,
  MobileApprovalKeyService,
  normalizeEd25519PublicKey,
} from "./mobile-approval-key-service.js";

const stores: Storage[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("MobileApprovalKeyService", () => {
  it("registers a canonicalized Ed25519 key with a Gateway-computed digest and a dark verification posture", async () => {
    const harness = createHarness();
    harness.seedGrant("grant-ak-1");
    const device = createDeviceKeyPair();

    const first = await harness.service.register(
      {
        enabled: true,
        algorithm: "ed25519",
        publicKeyPem: device.publicKeyPem,
        keyProvenance: "secure_hardware",
        deviceLabel: "Pixel",
      },
      { grantId: "grant-ak-1", companionSessionId: "companion-1" },
    );
    const replay = await harness.service.register(
      {
        enabled: true,
        algorithm: "ed25519",
        publicKeyPem: device.publicKeyPem,
        keyProvenance: "secure_hardware",
        deviceLabel: "Pixel",
      },
      { grantId: "grant-ak-1", companionSessionId: "companion-1" },
    );

    expect(replay).toEqual(first);
    expect(first.keyId).toBe(deriveMobileApprovalKeyId("grant-ak-1"));
    expect(first.algorithm).toBe("ed25519");
    expect(first.enabled).toBe(true);
    expect(first.revision).toBe(1);
    expect(first.publicKeySha256).toBe(device.publicKeySha256);
    // Production-dark pin: a registered key is NOT live signature-gated approval.
    expect(first.verificationAvailability).toBe("unavailable");

    const row = harness.sync.db
      .prepare("SELECT public_key_pem, public_key_sha256 FROM mobile_approval_keys WHERE key_id = ?")
      .get(first.keyId) as { public_key_pem: string; public_key_sha256: string };
    expect(row.public_key_sha256).toBe(device.publicKeySha256);
    expect(row.public_key_pem).toBe(normalizeEd25519PublicKey(device.publicKeyPem).publicKeyPem);
  });

  it("rejects non-Ed25519 and malformed key material before storage", async () => {
    const harness = createHarness();
    harness.seedGrant("grant-ak-2");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();

    await expect(
      harness.service.register(
        { enabled: true, algorithm: "ed25519", publicKeyPem: rsaPem, keyProvenance: "software" },
        { grantId: "grant-ak-2" },
      ),
    ).rejects.toThrow(/Ed25519/u);
    await expect(
      harness.service.register(
        { enabled: true, algorithm: "ed25519", publicKeyPem: "not-a-key", keyProvenance: "software" },
        { grantId: "grant-ak-2" },
      ),
    ).rejects.toThrow(/valid public key/u);
    await expect(
      harness.service.register(
        { enabled: true, algorithm: "ed25519", publicKeyPem: "x", keyProvenance: "software" },
        { grantId: undefined },
      ),
    ).rejects.toThrow(/durable companion grant/u);
    expect(harness.sync.mobileApprovalKeys.list()).toEqual([]);
  });

  it("rotates, disables, and projects grant revocation", async () => {
    const harness = createHarness();
    harness.seedGrant("grant-ak-3");
    const device = createDeviceKeyPair();
    const rotated = createDeviceKeyPair();

    await harness.service.register(
      { enabled: true, algorithm: "ed25519", publicKeyPem: device.publicKeyPem, keyProvenance: "secure_hardware" },
      { grantId: "grant-ak-3", companionSessionId: "companion-1" },
    );
    const afterRotation = await harness.service.register(
      { enabled: true, algorithm: "ed25519", publicKeyPem: rotated.publicKeyPem, keyProvenance: "secure_hardware" },
      { grantId: "grant-ak-3", companionSessionId: "companion-2" },
    );
    expect(afterRotation.revision).toBe(2);
    expect(afterRotation.publicKeySha256).toBe(rotated.publicKeySha256);

    const disabled = await harness.service.register({ enabled: false }, { grantId: "grant-ak-3" });
    expect(disabled.enabled).toBe(false);
    expect(disabled.revision).toBe(3);
    expect(disabled.verificationAvailability).toBe("unavailable");

    // Disabling a grant that never registered is honest 404, not a fabricated record.
    harness.seedGrant("grant-ak-never");
    await expect(harness.service.register({ enabled: false }, { grantId: "grant-ak-never" })).rejects.toThrow(
      /mobile approval key/u,
    );

    const revoked = await harness.service.revokeGrant("grant-ak-3");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.lifecycleState).toBe("revoked");
    const listed = await harness.service.listKeys();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      grantId: "grant-ak-3",
      lifecycleState: "revoked",
      algorithm: "ed25519",
    });
    expect(JSON.stringify(listed)).not.toContain("BEGIN PUBLIC KEY");
  });

  it("verifies a genuine device decision signature and pins the canonical payload contract", async () => {
    const now = () => new Date("2026-08-11T10:00:00.000Z");
    const harness = createHarness(now);
    harness.seedGrant("grant-ak-4");
    const device = createDeviceKeyPair();
    await harness.service.register(
      { enabled: true, algorithm: "ed25519", publicKeyPem: device.publicKeyPem, keyProvenance: "secure_hardware" },
      { grantId: "grant-ak-4", companionSessionId: "companion-1" },
    );

    const decisionInput = {
      approvalId: "approval-77",
      decision: "approve" as const,
      decisionPayloadSha256: sha256("edited-command-payload"),
      signedAt: "2026-08-11T09:59:30.000Z",
      companionSessionId: "companion-1",
      nonce: "nonce-1",
    };
    const payload = buildMobileApprovalDecisionSigningPayload(decisionInput);
    expect(payload).toBe(
      [
        MOBILE_APPROVAL_DECISION_CONTRACT_V1,
        "approvalId:approval-77",
        "decision:approve",
        `payloadSha256:${decisionInput.decisionPayloadSha256}`,
        "signedAt:2026-08-11T09:59:30.000Z",
        "companionSessionId:companion-1",
        "nonce:nonce-1",
      ].join("\n"),
    );

    const signature = sign(null, Buffer.from(payload, "utf8"), device.privateKey).toString("base64url");
    await expect(
      harness.service.verifyApprovalDecisionSignature({ grantId: "grant-ak-4", ...decisionInput, signature }),
    ).resolves.toMatchObject({ verified: true, keyId: deriveMobileApprovalKeyId("grant-ak-4"), revision: 1 });

    // Tampering with any signed field fails closed.
    await expect(
      harness.service.verifyApprovalDecisionSignature({
        grantId: "grant-ak-4",
        ...decisionInput,
        decision: "reject",
        signature,
      }),
    ).resolves.toEqual({ verified: false, reason: "signature_mismatch" });

    // A different device key fails closed.
    const impostor = createDeviceKeyPair();
    const impostorSignature = sign(null, Buffer.from(payload, "utf8"), impostor.privateKey).toString("base64url");
    await expect(
      harness.service.verifyApprovalDecisionSignature({
        grantId: "grant-ak-4",
        ...decisionInput,
        signature: impostorSignature,
      }),
    ).resolves.toEqual({ verified: false, reason: "signature_mismatch" });
  });

  it("fails closed on missing keys, revoked keys, inactive grants, stale timestamps, and malformed input", async () => {
    const now = () => new Date("2026-08-11T10:00:00.000Z");
    let grantActive = true;
    const harness = createHarness(now, async () => grantActive);
    harness.seedGrant("grant-ak-5");
    const device = createDeviceKeyPair();
    const decisionInput = {
      grantId: "grant-ak-5",
      approvalId: "approval-88",
      decision: "reject" as const,
      decisionPayloadSha256: sha256(""),
      signedAt: "2026-08-11T09:59:00.000Z",
      companionSessionId: "companion-1",
      nonce: "nonce-2",
    };
    const signature = sign(
      null,
      Buffer.from(buildMobileApprovalDecisionSigningPayload(decisionInput), "utf8"),
      device.privateKey,
    ).toString("base64url");

    await expect(harness.service.verifyApprovalDecisionSignature({ ...decisionInput, signature })).resolves.toEqual({
      verified: false,
      reason: "no_active_key",
    });

    await harness.service.register(
      { enabled: true, algorithm: "ed25519", publicKeyPem: device.publicKeyPem, keyProvenance: "secure_hardware" },
      { grantId: "grant-ak-5", companionSessionId: "companion-1" },
    );

    grantActive = false;
    await expect(harness.service.verifyApprovalDecisionSignature({ ...decisionInput, signature })).resolves.toEqual({
      verified: false,
      reason: "grant_inactive",
    });
    grantActive = true;

    await expect(
      harness.service.verifyApprovalDecisionSignature({
        ...decisionInput,
        signedAt: "2026-08-11T08:00:00.000Z",
        signature,
      }),
    ).resolves.toEqual({ verified: false, reason: "stale_timestamp" });

    await expect(
      harness.service.verifyApprovalDecisionSignature({
        ...decisionInput,
        decisionPayloadSha256: "not-hex",
        signature,
      }),
    ).resolves.toEqual({ verified: false, reason: "malformed_request" });

    await expect(
      harness.service.verifyApprovalDecisionSignature({ ...decisionInput, signature }),
    ).resolves.toMatchObject({ verified: true });

    await harness.service.register({ enabled: false }, { grantId: "grant-ak-5" });
    await expect(harness.service.verifyApprovalDecisionSignature({ ...decisionInput, signature })).resolves.toEqual({
      verified: false,
      reason: "no_active_key",
    });
  });
});

function createHarness(now?: () => Date, isGrantActive: (grantId: string) => Promise<boolean> = async () => true) {
  const sync = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
  stores.push(sync);
  const storage = createSqliteAsyncStorage(sync);
  const service = new MobileApprovalKeyService({ storage, isGrantActive, now });
  return {
    sync,
    storage,
    service,
    seedGrant: (grantId: string, options?: { expiresAt?: string; revokedAt?: string }) =>
      seedActiveGrant(sync, grantId, options),
  };
}

function createDeviceKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
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
         @requestId, @approvalId, @requestSecretHash, 'Approval key device', 'test', 'approved',
         @createdAt, @requestExpiresAt, @createdAt, 'operator:test', 'general_companion'
       )`,
    )
    .run({
      requestId,
      approvalId: `approval-${sha256(grantId).slice(0, 24)}`,
      requestSecretHash: sha256(`request-secret:${grantId}`),
      createdAt: "2026-08-11T00:00:00.000Z",
      requestExpiresAt: "2999-01-01T00:00:00.000Z",
    });
  storage.db
    .prepare(
      `INSERT INTO auth_device_grants (
         grant_id, request_id, token_hash, device_label, device_type, granted_by,
         created_at, expires_at, revoked_at, metadata_json, principal_purpose
       ) VALUES (
         @grantId, @requestId, @tokenHash, 'Approval key device', 'test', 'operator:test',
         @createdAt, @expiresAt, @revokedAt, '{}', 'general_companion'
       )`,
    )
    .run({
      grantId,
      requestId,
      tokenHash: sha256(`device-token:${grantId}`),
      createdAt: "2026-08-11T00:00:00.000Z",
      expiresAt: options.expiresAt ?? null,
      revokedAt: options.revokedAt ?? null,
    });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { deriveMobileApprovalKeyId, Storage } from "./index.js";
import { MOBILE_APPROVAL_KEY_POSTGRES_SCHEMA_SQL } from "./postgres/mobile-approval-key-schema.js";

function createStorage(): Storage {
  return new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
}

function generateEd25519PublicKey(): { publicKeyPem: string; publicKeySha256: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeySha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  return { publicKeyPem, publicKeySha256 };
}

describe("MobileApprovalKeyRepository", () => {
  it("registers, replays idempotently, and bumps revision only on rotation", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-key-1");
    const keyId = deriveMobileApprovalKeyId("grant-key-1");
    const material = generateEd25519PublicKey();
    const base = {
      keyId,
      grantId: "grant-key-1",
      publicKeyPem: material.publicKeyPem,
      publicKeySha256: material.publicKeySha256,
      keyProvenance: "secure_hardware" as const,
      companionSessionId: "companion-1",
      deviceLabel: "Pixel",
    };

    const created = storage.mobileApprovalKeys.upsertActiveKey({ ...base, now: "2026-08-11T01:00:00.000Z" });
    const replayed = storage.mobileApprovalKeys.upsertActiveKey({ ...base, now: "2026-08-11T01:01:00.000Z" });
    assert.equal(created.keyId, keyId);
    assert.equal(created.algorithm, "ed25519");
    assert.equal(created.revision, 1);
    assert.equal(created.lifecycleState, "active");
    assert.equal(replayed.revision, 1);
    assert.equal(replayed.updatedAt, created.updatedAt);

    const rotated = generateEd25519PublicKey();
    const afterRotation = storage.mobileApprovalKeys.upsertActiveKey({
      ...base,
      publicKeyPem: rotated.publicKeyPem,
      publicKeySha256: rotated.publicKeySha256,
      now: "2026-08-11T01:02:00.000Z",
    });
    assert.equal(afterRotation.keyId, keyId);
    assert.equal(afterRotation.revision, 2);
    assert.equal(afterRotation.publicKeySha256, rotated.publicKeySha256);
    assert.equal(storage.mobileApprovalKeys.getActiveByGrant("grant-key-1")?.publicKeySha256, rotated.publicKeySha256);
    storage.close();
  });

  it("keeps revocation idempotent, retains public material, and re-registers with a bumped revision", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-key-2");
    const keyId = deriveMobileApprovalKeyId("grant-key-2");
    const material = generateEd25519PublicKey();
    storage.mobileApprovalKeys.upsertActiveKey({
      keyId,
      grantId: "grant-key-2",
      publicKeyPem: material.publicKeyPem,
      publicKeySha256: material.publicKeySha256,
      keyProvenance: "software",
      now: "2026-08-11T02:00:00.000Z",
    });

    const revoked = storage.mobileApprovalKeys.ensureRevoked({
      grantId: "grant-key-2",
      now: "2026-08-11T02:01:00.000Z",
    });
    const replayedRevoke = storage.mobileApprovalKeys.ensureRevoked({
      grantId: "grant-key-2",
      now: "2026-08-11T02:02:00.000Z",
    });
    assert.equal(revoked?.lifecycleState, "revoked");
    assert.equal(revoked?.revision, 2);
    assert.equal(revoked?.publicKeySha256, material.publicKeySha256);
    assert.equal(replayedRevoke?.revision, revoked?.revision);
    assert.equal(replayedRevoke?.revokedAt, revoked?.revokedAt);
    assert.equal(storage.mobileApprovalKeys.getActiveByGrant("grant-key-2"), undefined);

    const reRegistered = storage.mobileApprovalKeys.upsertActiveKey({
      keyId,
      grantId: "grant-key-2",
      publicKeyPem: material.publicKeyPem,
      publicKeySha256: material.publicKeySha256,
      keyProvenance: "software",
      now: "2026-08-11T02:03:00.000Z",
    });
    assert.equal(reRegistered.lifecycleState, "active");
    assert.equal(reRegistered.revision, 3);
    assert.equal(reRegistered.revokedAt, undefined);

    assert.deepEqual(storage.mobileApprovalKeys.revokeAllByGrant("grant-without-key"), []);
    storage.close();
  });

  it("fences registration on the durable grant row and rejects cross-grant key reuse", () => {
    const storage = createStorage();
    seedActiveGrant(storage, "grant-key-3");
    seedActiveGrant(storage, "grant-key-4");
    const material = generateEd25519PublicKey();
    storage.mobileApprovalKeys.upsertActiveKey({
      keyId: deriveMobileApprovalKeyId("grant-key-3"),
      grantId: "grant-key-3",
      publicKeyPem: material.publicKeyPem,
      publicKeySha256: material.publicKeySha256,
      keyProvenance: "secure_hardware",
    });

    assert.throws(
      () =>
        storage.mobileApprovalKeys.upsertActiveKey({
          keyId: deriveMobileApprovalKeyId("grant-key-4"),
          grantId: "grant-key-4",
          publicKeyPem: material.publicKeyPem,
          publicKeySha256: material.publicKeySha256,
          keyProvenance: "secure_hardware",
        }),
      /UNIQUE constraint failed/u,
    );

    const foreignKeys = storage.db.prepare("PRAGMA foreign_key_list(mobile_approval_keys)").all() as Array<{
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
      MOBILE_APPROVAL_KEY_POSTGRES_SCHEMA_SQL,
      /grant_id TEXT NOT NULL REFERENCES auth_device_grants\(grant_id\) ON DELETE RESTRICT/u,
    );
    assert.throws(
      () => storage.db.prepare("DELETE FROM auth_device_grants WHERE grant_id = ?").run("grant-key-3"),
      /FOREIGN KEY constraint failed/u,
    );

    storage.db
      .prepare("UPDATE auth_device_grants SET revoked_at = ? WHERE grant_id = ?")
      .run("2026-08-11T03:00:00.000Z", "grant-key-3");
    const rotation = generateEd25519PublicKey();
    assert.throws(
      () =>
        storage.mobileApprovalKeys.upsertActiveKey({
          keyId: deriveMobileApprovalKeyId("grant-key-3"),
          grantId: "grant-key-3",
          publicKeyPem: rotation.publicKeyPem,
          publicKeySha256: rotation.publicKeySha256,
          keyProvenance: "secure_hardware",
        }),
      /active durable device grant/u,
    );

    seedActiveGrant(storage, "grant-key-expired", { expiresAt: "2000-01-01T00:00:00.000Z" });
    const expiredMaterial = generateEd25519PublicKey();
    assert.throws(
      () =>
        storage.mobileApprovalKeys.upsertActiveKey({
          keyId: deriveMobileApprovalKeyId("grant-key-expired"),
          grantId: "grant-key-expired",
          publicKeyPem: expiredMaterial.publicKeyPem,
          publicKeySha256: expiredMaterial.publicKeySha256,
          keyProvenance: "unknown",
        }),
      /active durable device grant/u,
    );
    storage.close();
  });

  it("stores no secret-shaped columns and keeps the schema pair aligned", () => {
    const storage = createStorage();
    const columns = storage.db.prepare("PRAGMA table_info(mobile_approval_keys)").all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name).sort();
    for (const columnName of columnNames) {
      assert.doesNotMatch(columnName, /token|secret|private/iu);
      assert.match(
        MOBILE_APPROVAL_KEY_POSTGRES_SCHEMA_SQL,
        new RegExp(`\\b${columnName}\\b`, "u"),
        `PostgreSQL 141 must declare the ${columnName} column`,
      );
    }
    assert.deepEqual(columnNames, [
      "algorithm",
      "companion_session_id",
      "device_label",
      "grant_id",
      "key_id",
      "key_provenance",
      "lifecycle_state",
      "public_key_pem",
      "public_key_sha256",
      "registered_at",
      "revision",
      "revoked_at",
      "updated_at",
    ]);
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
         @requestId, @approvalId, @requestSecretHash, 'Approval key test device', 'test', 'approved',
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
         @grantId, @requestId, @tokenHash, 'Approval key test device', 'test', 'operator:test',
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

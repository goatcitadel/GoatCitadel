import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { deriveMobileApprovalKeyId, MobileApprovalKeyRepository } from "./mobile-approval-key-repo.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

describe("MobileApprovalKeyRepository live PostgreSQL authority", () => {
  postgresIt(
    "registers, rotates, revokes, and fences the Ed25519 approval key on the durable grant row",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `m8_mobile_approval_key_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const db = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `m8-mobile-approval-key-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        db.exec(`SET search_path TO ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);

        const grantId = `grant-ak-${suffix}`;
        seedActiveGrant(db, grantId);
        const repo = new MobileApprovalKeyRepository(db);
        const keyId = deriveMobileApprovalKeyId(grantId);
        const material = generateEd25519PublicKey();

        const created = repo.upsertActiveKey({
          keyId,
          grantId,
          publicKeyPem: material.publicKeyPem,
          publicKeySha256: material.publicKeySha256,
          keyProvenance: "secure_hardware",
          companionSessionId: `companion-${suffix}`,
          now: "2026-08-11T01:00:00.000Z",
        });
        const replayed = repo.upsertActiveKey({
          keyId,
          grantId,
          publicKeyPem: material.publicKeyPem,
          publicKeySha256: material.publicKeySha256,
          keyProvenance: "secure_hardware",
          companionSessionId: `companion-${suffix}`,
          now: "2026-08-11T01:01:00.000Z",
        });
        assert.equal(created.revision, 1);
        assert.equal(replayed.revision, 1);
        assert.equal(replayed.updatedAt, created.updatedAt);

        const rotated = generateEd25519PublicKey();
        const afterRotation = repo.upsertActiveKey({
          keyId,
          grantId,
          publicKeyPem: rotated.publicKeyPem,
          publicKeySha256: rotated.publicKeySha256,
          keyProvenance: "secure_hardware",
          now: "2026-08-11T01:02:00.000Z",
        });
        assert.equal(afterRotation.revision, 2);
        assert.equal(afterRotation.publicKeySha256, rotated.publicKeySha256);

        // Cross-grant key reuse is refused by the unique digest authority.
        const otherGrantId = `grant-ak-other-${suffix}`;
        seedActiveGrant(db, otherGrantId);
        assert.throws(
          () =>
            repo.upsertActiveKey({
              keyId: deriveMobileApprovalKeyId(otherGrantId),
              grantId: otherGrantId,
              publicKeyPem: rotated.publicKeyPem,
              publicKeySha256: rotated.publicKeySha256,
              keyProvenance: "secure_hardware",
            }),
          /duplicate key|unique/iu,
        );

        const revoked = repo.ensureRevoked({ grantId, now: "2026-08-11T01:03:00.000Z" });
        const replayedRevoke = repo.ensureRevoked({ grantId, now: "2026-08-11T01:04:00.000Z" });
        assert.equal(revoked?.lifecycleState, "revoked");
        assert.equal(revoked?.revision, 3);
        assert.equal(revoked?.publicKeySha256, rotated.publicKeySha256);
        assert.equal(replayedRevoke?.revision, 3);
        assert.equal(replayedRevoke?.revokedAt, revoked?.revokedAt);
        assert.equal(repo.getActiveByGrant(grantId), undefined);

        // Registration is fenced on the durable grant row: a revoked grant refuses.
        db.prepare("UPDATE auth_device_grants SET revoked_at = @revokedAt WHERE grant_id = @grantId").run({
          revokedAt: "2026-08-11T01:05:00.000Z",
          grantId,
        });
        assert.throws(
          () =>
            repo.upsertActiveKey({
              keyId,
              grantId,
              publicKeyPem: material.publicKeyPem,
              publicKeySha256: material.publicKeySha256,
              keyProvenance: "secure_hardware",
            }),
          /active durable device grant/u,
        );

        // The grant FK stays RESTRICT so key rows can never orphan silently.
        assert.throws(
          () => db.prepare("DELETE FROM auth_device_grants WHERE grant_id = @grantId").run({ grantId }),
          /foreign key|violates/iu,
        );
      } finally {
        db.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await adminPool.end();
      }
    },
  );
});

function generateEd25519PublicKey(): { publicKeyPem: string; publicKeySha256: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeySha256: createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex"),
  };
}

function seedActiveGrant(db: PostgresSyncDatabaseClient, grantId: string): void {
  const requestId = `request-${sha256(grantId).slice(0, 24)}`;
  db.prepare(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by, principal_purpose
     ) VALUES (
       @requestId, @approvalId, @requestSecretHash, 'Approval key device', 'test', 'approved',
       @createdAt, @requestExpiresAt, @createdAt, 'operator:test', 'general_companion'
     )`,
  ).run({
    requestId,
    approvalId: `approval-${sha256(grantId).slice(0, 24)}`,
    requestSecretHash: sha256(`request-secret:${grantId}`),
    createdAt: "2026-08-11T00:00:00.000Z",
    requestExpiresAt: "2999-01-01T00:00:00.000Z",
  });
  db.prepare(
    `INSERT INTO auth_device_grants (
       grant_id, request_id, token_hash, device_label, device_type, granted_by,
       created_at, expires_at, revoked_at, metadata_json, principal_purpose
     ) VALUES (
       @grantId, @requestId, @tokenHash, 'Approval key device', 'test', 'operator:test',
       @createdAt, NULL, NULL, '{}', 'general_companion'
     )`,
  ).run({
    grantId,
    requestId,
    tokenHash: sha256(`device-token:${grantId}`),
    createdAt: "2026-08-11T00:00:00.000Z",
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

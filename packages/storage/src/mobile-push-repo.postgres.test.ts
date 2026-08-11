import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { deriveMobilePushRegistrationId, MobilePushRepository } from "./mobile-push-repo.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

describe("MobilePushRepository live PostgreSQL send fence", () => {
  postgresIt(
    "lets a committed revocation win the send fence and settles an armed send exactly once",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `m8_mobile_push_fence_${suffix}`;
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
        applicationName: `m8-mobile-push-fence-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        db.exec(`SET search_path TO ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);

        const grantId = `grant-fence-${suffix}`;
        seedActiveGrant(db, grantId);
        const repo = new MobilePushRepository(db);
        const registrationId = deriveMobilePushRegistrationId(grantId, "expo");
        const base = {
          registrationId,
          grantId,
          provider: "expo" as const,
          tokenSecretRef: `keychain:goatcitadel:mobile-push:${registrationId}`,
          tokenSha256: "a".repeat(64),
        };
        const registration = repo.upsertActiveRegistration({ ...base, now: "2026-08-11T06:00:00.000Z" });
        const [queued] = repo.enqueueApprovalRefresh({
          sourceRealtimeEventId: `event-${suffix}`,
          approvalId: `approval-${suffix}`,
          now: "2026-08-11T06:01:00.000Z",
        });
        assert.ok(queued);
        const claimed = repo.claimDelivery({
          deliveryId: queued.deliveryId,
          expectedVersion: queued.version,
          workerId: "worker-pg",
          claimedAt: "2026-08-11T06:02:00.000Z",
          leaseExpiresAt: "2026-08-11T06:03:00.000Z",
        });
        assert.ok(claimed);

        // Order 1: revocation commits first; the fence must refuse the send.
        repo.ensureRevokedRegistration({ ...base, now: "2026-08-11T06:02:10.000Z" });
        const refused = repo.armDeliverySendFence({
          deliveryId: claimed.deliveryId,
          registrationId,
          expectedVersion: claimed.version,
          expectedRegistrationRevision: registration.revision,
          expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
          workerId: "worker-pg",
          armedAt: "2026-08-11T06:02:20.000Z",
        });
        assert.deepEqual(refused, { armed: false, reason: "registration_revoked" });
        assert.equal(repo.getDelivery(claimed.deliveryId).status, "running");

        // Order 2: reactivate, arm the fence, then revoke mid-flight; the
        // running row must stay for the worker's exactly-once honest settle.
        const reactivated = repo.upsertActiveRegistration({ ...base, now: "2026-08-11T06:04:00.000Z" });
        const armed = repo.armDeliverySendFence({
          deliveryId: claimed.deliveryId,
          registrationId,
          expectedVersion: claimed.version,
          expectedRegistrationRevision: reactivated.revision,
          expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
          workerId: "worker-pg",
          armedAt: "2026-08-11T06:05:00.000Z",
        });
        assert.ok(armed.armed);
        assert.equal(armed.delivery.version, claimed.version + 1);

        repo.ensureRevokedRegistration({ ...base, now: "2026-08-11T06:05:10.000Z" });
        assert.equal(repo.getDelivery(claimed.deliveryId).status, "running");

        // A stale pre-fence finalize can no longer settle the delivery...
        assert.equal(
          repo.finalizeDelivery({
            deliveryId: claimed.deliveryId,
            expectedVersion: claimed.version,
            expectedLeaseExpiresAt: claimed.leaseExpiresAt!,
            workerId: "worker-pg",
            status: "delivered",
            lastClassification: "delivered",
            updatedAt: "2026-08-11T06:06:00.000Z",
          }),
          undefined,
        );
        // ...while the armed worker settles exactly once with the honest receipt.
        const settled = repo.finalizeDelivery({
          deliveryId: claimed.deliveryId,
          expectedVersion: armed.delivery.version,
          expectedLeaseExpiresAt: armed.delivery.leaseExpiresAt!,
          workerId: "worker-pg",
          status: "delivered",
          lastClassification: "delivered",
          providerReceiptSha256: "b".repeat(64),
          updatedAt: "2026-08-11T06:06:30.000Z",
        });
        assert.equal(settled?.status, "delivered");
        assert.equal(
          repo.finalizeDelivery({
            deliveryId: claimed.deliveryId,
            expectedVersion: armed.delivery.version,
            expectedLeaseExpiresAt: armed.delivery.leaseExpiresAt!,
            workerId: "worker-pg",
            status: "delivered",
            lastClassification: "delivered",
            updatedAt: "2026-08-11T06:07:00.000Z",
          }),
          undefined,
        );
        assert.equal(repo.getRegistrationById(registrationId)?.lifecycleState, "revoked");
      } finally {
        db.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await adminPool.end();
      }
    },
  );
});

function seedActiveGrant(db: PostgresSyncDatabaseClient, grantId: string): void {
  const requestId = `request-${sha256(grantId).slice(0, 24)}`;
  db.prepare(
    `INSERT INTO auth_device_requests (
       request_id, approval_id, request_secret_hash, device_label, device_type, status,
       created_at, expires_at, resolved_at, resolved_by, principal_purpose
     ) VALUES (
       @requestId, @approvalId, @requestSecretHash, 'Push fence device', 'test', 'approved',
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
       @grantId, @requestId, @tokenHash, 'Push fence device', 'test', 'operator:test',
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

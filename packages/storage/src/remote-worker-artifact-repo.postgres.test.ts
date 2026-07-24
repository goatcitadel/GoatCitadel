import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactWorkspaceShard,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerSettlementIdentity,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { RemoteWorkerArtifactRepository } from "./remote-worker-artifact-repo.js";
import { seedRemoteWorkerGeneration } from "./remote-worker-artifact-repo.test.js";

// HX-506 live-PostgreSQL artifact-owner proof. Skips with a visible reason when
// GOATCITADEL_TEST_POSTGRES_URL is unset; the hermetic native cluster provisions
// it and runs with the URL set.
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";

interface Scoped {
  schemaName: string;
  adminPool: Pool;
  scopedPool: Pool;
  db: PostgresSyncDatabaseClient;
  teardown: () => Promise<void>;
}

async function scoped(prefix: string): Promise<Scoped> {
  assert.ok(postgresConnectionString);
  const suffix = randomUUID().replaceAll("-", "");
  const schemaName = `${prefix}_${suffix}`;
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
    applicationName: `hx506-${suffix}`,
    pool: { max: 1, connectionTimeoutMs: 10_000 },
  });
  await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  db.exec(`SET search_path TO ${schemaName}`);
  await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
  return {
    schemaName,
    adminPool,
    scopedPool,
    db,
    teardown: async () => {
      db.close();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      await scopedPool.end().catch(() => undefined);
      await adminPool.end().catch(() => undefined);
    },
  };
}

function buildManifest(
  identity: RemoteWorkerSettlementIdentity,
  requiredVerifier: string | null,
): RemoteWorkerArtifactManifest {
  const logicalPath = "dir/file.bin";
  return {
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    identity,
    pathJailSha256: D("jail"),
    workerClaimIds: ["claim-1"],
    workerClaimSha256: D("claims"),
    requiredVerifierProfileSha256: requiredVerifier,
    fileCount: 1,
    totalBytes: 10,
    entries: [
      {
        entryIndex: 0,
        logicalPath,
        logicalPathSha256: D(canonicalJsonString({ logicalPath })),
        blobSha256: D("blob-content"),
        byteCount: 10,
        mimeType: "application/octet-stream",
      },
    ],
  };
}

describe("RemoteWorkerArtifactRepository live PostgreSQL (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "commits, replays, isolates composite identity, and enforces immutable triggers",
    { timeout: 300_000 },
    async () => {
      const scope = await scoped("hx506_artifact");
      try {
        const artifacts = new RemoteWorkerArtifactRepository(scope.db);
        const ctx = seedRemoteWorkerGeneration(scope.db, "artifact");
        const key = {
          registryWorkspaceId: ctx.registryWorkspaceId,
          assignmentId: ctx.assignmentId,
          assignmentGeneration: ctx.assignmentGeneration,
        };

        const opened = artifacts.openUpload({
          ...key,
          uploadAttempt: 1,
          declaredFileCount: 1,
          declaredTotalBytes: 10,
          stagingRootSha256: D("staging"),
          expiresAt: FUTURE,
          idempotencyKey: "open-1",
        });
        artifacts.appendPart({
          ...key,
          uploadId: opened.uploadId,
          part: {
            globalSequence: 1,
            logicalPathSha256: D(canonicalJsonString({ logicalPath: "dir/file.bin" })),
            filePartIndex: 0,
            isFinalPart: true,
            partBytes: 10,
            partSha256: D("blob-content"),
          },
          idempotencyKey: "part-1",
        });
        const blobSha256 = D("blob-content");
        artifacts.commitArtifact({
          ...key,
          uploadId: opened.uploadId,
          manifest: buildManifest(opened.identity, D("verifier-profile")),
          blobs: [
            {
              blobSha256,
              byteCount: 10,
              physicalRelPath: remoteWorkerArtifactBlobRelPath(
                remoteWorkerArtifactWorkspaceShard(opened.identity.executionWorkspaceId),
                blobSha256,
              ),
            },
          ],
          idempotencyKey: "commit-1",
        });
        const committed = artifacts.getUpload(
          key.registryWorkspaceId,
          key.assignmentId,
          key.assignmentGeneration,
          opened.uploadId,
        );
        assert.equal(committed.uploadState, "committed");
        assert.equal(committed.verificationGateState, "pending");

        // Replay is identical; a changed staging root under the same key is a conflict.
        assert.equal(
          artifacts.openUpload({
            ...key,
            uploadAttempt: 1,
            declaredFileCount: 1,
            declaredTotalBytes: 10,
            stagingRootSha256: D("staging"),
            expiresAt: FUTURE,
            idempotencyKey: "open-1",
          }).uploadId,
          opened.uploadId,
        );
        assert.throws(() =>
          artifacts.openUpload({
            ...key,
            uploadAttempt: 1,
            declaredFileCount: 1,
            declaredTotalBytes: 10,
            stagingRootSha256: D("changed"),
            expiresAt: FUTURE,
            idempotencyKey: "open-1",
          }),
        );

        // Composite-FK isolation on the live cluster: a forged worker row is rejected.
        assert.throws(() =>
          scope.db
            .prepare(
              `INSERT INTO remote_worker_artifact_parts (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, upload_id, global_sequence, logical_path_sha256, file_part_index,
              is_final_part, part_bytes, part_sha256, idempotency_key, request_sha256, received_at
            ) VALUES (
              @rw, @ew, @aid, @gen, 'worker-forged', @wg, @rm, @wc, @cc, @am, @uid, 2, @lp, 0, 1, 10, @ps, 'forged', @ps, @now
            )`,
            )
            .run({
              rw: key.registryWorkspaceId,
              ew: opened.identity.executionWorkspaceId,
              aid: key.assignmentId,
              gen: key.assignmentGeneration,
              wg: opened.identity.workerGeneration,
              rm: opened.identity.runtimeManifestSha256,
              wc: opened.identity.workspaceCeilingSha256,
              cc: opened.identity.capabilityCeilingSha256,
              am: opened.identity.assignmentManifestSha256,
              uid: opened.uploadId,
              lp: D("p"),
              ps: D("forged"),
              now: FUTURE,
            }),
        );

        // Insert-only enforcement in PostgreSQL.
        assert.throws(
          () => scope.db.prepare("UPDATE remote_worker_artifact_parts SET part_bytes = 5").run(),
          /insert-only/u,
        );
        assert.throws(() => scope.db.prepare("DELETE FROM remote_worker_artifact_manifests").run(), /insert-only/u);

        // A worker claim never satisfies the gate; a passed Gateway attempt does.
        artifacts.recordWorkerClaim({
          ...key,
          attemptIndex: 1,
          evidence: {
            schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
            kind: "worker_claim",
            attemptState: "worker_reported",
            verifierProfileSha256: null,
            preExecutionManifestSha256: D("pre"),
            postExecutionManifestSha256: D("post"),
            summary: "worker trusted",
            capturedOutputBytes: 0,
          },
          idempotencyKey: "claim-1",
        });
        assert.equal(
          artifacts.getUpload(key.registryWorkspaceId, key.assignmentId, key.assignmentGeneration, opened.uploadId)
            .verificationGateState,
          "pending",
        );
        const attempt = artifacts.openGatewayVerification({
          ...key,
          attemptIndex: 1,
          verifierProfileSha256: D("verifier-profile"),
          wallDeadlineAt: FUTURE,
          evidence: gatewayEvidence("queued", 0),
          idempotencyKey: "attempt-1",
        });
        artifacts.advanceGatewayVerification({
          ...key,
          verificationId: attempt.verificationId,
          expectedAttemptRevision: 1,
          nextState: "running",
          evidence: gatewayEvidence("running", 5),
        });
        const passed = artifacts.advanceGatewayVerification({
          ...key,
          verificationId: attempt.verificationId,
          expectedAttemptRevision: 2,
          nextState: "passed",
          evidence: gatewayEvidence("passed", 10),
        });
        assert.equal(passed.gateState, "satisfied");

        // Cleanup claim uses the live database clock.
        const claimed = artifacts.claimCleanup({
          ...key,
          uploadId: opened.uploadId,
          expectedCleanupRevision: 1,
          claimOwner: "cleaner-a",
        });
        assert.equal(claimed.cleanupState, "pending");
      } finally {
        await scope.teardown();
      }
    },
  );

  postgresIt(
    "declares one winner when two connections open the same upload attempt",
    { timeout: 300_000 },
    async () => {
      const scope = await scoped("hx506_artifact_race");
      try {
        const ctx = seedRemoteWorkerGeneration(scope.db, "race");
        const key = {
          registryWorkspaceId: ctx.registryWorkspaceId,
          assignmentId: ctx.assignmentId,
          assignmentGeneration: ctx.assignmentGeneration,
        };
        const scopedUrl = new URL(postgresConnectionString!);
        scopedUrl.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
        const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
        const second = new PostgresSyncDatabaseClient({
          connectionString: scopedUrl.toString(),
          database,
          applicationName: "hx506-second",
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        try {
          second.exec(`SET search_path TO ${scope.schemaName}`);
          const artifactsA = new RemoteWorkerArtifactRepository(scope.db);
          const artifactsB = new RemoteWorkerArtifactRepository(second);
          const params = {
            ...key,
            uploadAttempt: 1,
            declaredFileCount: 1,
            declaredTotalBytes: 10,
            stagingRootSha256: D("staging"),
            expiresAt: FUTURE,
          } as const;
          artifactsA.openUpload({ ...params, idempotencyKey: "open-a" });
          // The second connection cannot also win attempt 1 for this generation.
          assert.throws(() => artifactsB.openUpload({ ...params, idempotencyKey: "open-b" }));
        } finally {
          second.close();
        }
      } finally {
        await scope.teardown();
      }
    },
  );
});

function gatewayEvidence(attemptState: "queued" | "running" | "passed", capturedOutputBytes: number) {
  return {
    schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    kind: "gateway_attempt" as const,
    attemptState,
    verifierProfileSha256: D("verifier-profile"),
    preExecutionManifestSha256: D("pre"),
    postExecutionManifestSha256: D("post"),
    summary: attemptState,
    capturedOutputBytes,
  };
}

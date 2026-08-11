import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  remoteWorkerProtectedAdmissionContextSha256,
  remoteWorkerProtectedAdmissionRemoteCallerBindingSha256,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerAssignmentEventInput,
  type RemoteWorkerAssignmentManifest,
  type RemoteWorkerBootstrapRecord,
  type RemoteWorkerProtectedAdmissionSignerPin,
  type RemoteWorkerRuntimeCredentialRecord,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import {
  RemoteWorkerAdmissionRepository,
  type FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
} from "./remote-worker-admission-repo.js";
import {
  RemoteWorkerAssignmentRepository,
  type RemoteWorkerAssignmentProtectedCommitFence,
} from "./remote-worker-assignment-repo.js";
import { RemoteWorkerMeshNodeAdmissionRepository } from "./remote-worker-mesh-node-admission-repo.js";
import type { RemoteWorkerNonceConsumeInput } from "./remote-worker-nonce-repo.js";
import { TaskRepository } from "./task-repo.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const DBytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";

describe("RemoteWorkerAssignmentRepository live PostgreSQL authority", () => {
  postgresIt(
    "migrates SQL and serializes parent heartbeat/context drift against worker progress",
    { timeout: 120_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx501_assignment_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const setupDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx501-assignment-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const h = seedPostgresHarness(setupDb, suffix);
        const started = h.assignments.startGeneration(h.startInput);
        assert.equal(started.lease.parentDispatchAuthority.durableRunVersion, 1);
        assert.ok(started.lease.expiresAt <= started.lease.parentDispatchAuthority.durableRunLeaseExpiresAt);

        const protectedAdmissionEnvelopeSha256 = D(`${suffix}:protected-envelope`);
        const protectedAdmissionContextSha256 = D(`${suffix}:protected-context`);
        const protectedCommitFence = {
          credentialAuthority: {
            registryWorkspaceId: h.worker.generation.registryWorkspaceId,
            bootstrapId: h.worker.generation.bootstrapId,
            workerId: h.worker.generation.workerId,
            workerGeneration: h.worker.generation.workerGeneration,
            credentialId: h.worker.credential.credentialId,
            credentialGeneration: h.worker.credential.credentialGeneration,
            authorizationCredentialSha256: D(`${suffix}:credential`),
            nodeId: h.worker.generation.nodeId,
            clientCertificateSha256: h.worker.generation.clientCertificateSha256,
            runtimeManifestSha256: h.worker.generation.runtimeManifestSha256,
            workspaceCeilingSha256: h.worker.generation.workspaceCeilingSha256,
            capabilityCeilingSha256: h.worker.generation.capabilityCeilingSha256,
            protectedAdmissionEnvelopeSha256,
            protectedAdmissionContextSha256,
            claimsSha256: h.worker.credential.claimsSha256,
          },
          meshAdmission: {
            schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
            registryWorkspaceId: h.worker.generation.registryWorkspaceId,
            bootstrapId: h.worker.generation.bootstrapId,
            workerId: h.worker.generation.workerId,
            workerGeneration: h.worker.generation.workerGeneration,
            credentialId: h.worker.credential.credentialId,
            credentialGeneration: h.worker.credential.credentialGeneration,
            workspaceId: "default",
            nodeId: h.worker.generation.nodeId,
            admissionGeneration: h.nodeAdmission.admissionGeneration,
            joinAuthorityGeneration: 1,
            joinCredentialSha256: D(`${suffix}:protected-join`),
            protectedAdmissionEnvelopeSha256,
            protectedAdmissionContextSha256,
          },
        } as const;
        h.workerAdmissions.rotateRuntimeCredential({
          registryWorkspaceId: h.worker.generation.registryWorkspaceId,
          workerId: h.worker.generation.workerId,
          workerGeneration: h.worker.generation.workerGeneration,
          expectedCredentialId: h.worker.credential.credentialId,
          expectedCredentialGeneration: h.worker.credential.credentialGeneration,
          verifiedTransportReceiptSha256: D(`${suffix}:rotation-transport`),
          verifiedProofOfPossessionReceiptSha256: D(`${suffix}:rotation-pop`),
          credentialIssuanceProofSha256: D(`${suffix}:rotation-issuance`),
          expiresInSeconds: 600,
          credentialTokenSha256: D(`${suffix}:rotation-credential`),
          idempotencyKey: `${suffix}:rotation`,
        });
        assert.throws(
          () =>
            h.assignments.resolveActiveAuthorityByLeaseTokenHash(h.startInput.leaseTokenSha256, protectedCommitFence),
          /protected commit authority/u,
        );

        const missingManifestField = { ...h.manifest } as Record<string, unknown>;
        delete missingManifestField.maxEventBytes;
        const missingManifestJson = JSON.stringify(missingManifestField);
        assertDirectPostgresManifestRejected(setupDb, h, `${suffix}:manifest-missing-field`, missingManifestJson);
        const validManifestJson = JSON.stringify(h.manifest);
        const duplicateManifestJson = `${validManifestJson.slice(0, -1)},"maxEventBytes":${h.manifest.maxEventBytes}}`;
        assertDirectPostgresManifestRejected(setupDb, h, `${suffix}:manifest-duplicate-key`, duplicateManifestJson);

        const parentV2 = h.durableRuns.renewLeaseWithDatabaseClock({
          runId: h.durableRunId,
          workerId: "gateway-a",
          leaseDurationMs: 120_000,
        });
        assert.equal(parentV2?.version, 2);
        const firstEvent = statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 5);
        assert.throws(() =>
          h.assignments.appendEvents({
            registryWorkspaceId: "default",
            assignmentId: h.assignmentId,
            expectedAssignmentGeneration: 1,
            expectedLeaseRevision: 1,
            leaseTokenSha256: h.startInput.leaseTokenSha256,
            events: [firstEvent],
          }),
        );

        const leaseV2Token = D(`${suffix}:lease:2`);
        const leaseV2 = h.assignments.renewLease({
          registryWorkspaceId: "default",
          assignmentId: h.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          expectedLeaseTokenSha256: h.startInput.leaseTokenSha256,
          leaseTokenSha256: leaseV2Token,
          workerSentThrough: 5,
          idempotencyKey: `${suffix}:renew:2`,
        }).lease;
        assert.equal(leaseV2.parentDispatchAuthority.durableRunVersion, 2);
        assert.equal(leaseV2.parentDispatchAuthority.durableRunLeaseExpiresAt, parentV2?.leaseExpiresAt);
        assert.ok(leaseV2.expiresAt <= leaseV2.parentDispatchAuthority.durableRunLeaseExpiresAt);
        const appended = h.assignments.appendEvents({
          registryWorkspaceId: "default",
          assignmentId: h.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 2,
          leaseTokenSha256: leaseV2Token,
          events: [firstEvent],
        });
        assert.equal(appended.acknowledgedThrough, 1);

        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:status-duplicate-key`,
          "status",
          `{"schemaVersion":"${REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION}","phase":"running","statusSha256":"${D(`${suffix}:status-first`)}","statusSha256":"${D(`${suffix}:status-second`)}"}`,
        );

        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:terminal-negative`,
          "terminal_output",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            stream: "stdout",
            chunkSha256: D(`${suffix}:terminal-negative`),
            byteLength: -1,
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:terminal-text`,
          "terminal_output",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            stream: "stdout",
            chunkSha256: D(`${suffix}:terminal-text`),
            byteLength: "1",
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:terminal-oversize`,
          "terminal_output",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            stream: "stderr",
            chunkSha256: D(`${suffix}:terminal-oversize`),
            byteLength: 65_537,
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:transcript-non-text`,
          "transcript_delta",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            role: "assistant",
            text: 7,
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:status-missing-digest`,
          "status",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            phase: "running",
          },
        );
        assertDirectPostgresEventRejected(
          setupDb,
          h,
          appended.events[0]!.eventSha256,
          `${suffix}:watermark-over-manifest`,
          "status",
          {
            schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
            phase: "running",
            statusSha256: D(`${suffix}:watermark-over-manifest`),
          },
          101,
        );

        const parentV3 = h.durableRuns.renewLeaseWithDatabaseClock({
          runId: h.durableRunId,
          workerId: "gateway-a",
          leaseDurationMs: 120_000,
        });
        assert.equal(parentV3?.version, 3);
        const leaseV3Token = D(`${suffix}:lease:3`);
        const leaseV3 = h.assignments.renewLease({
          registryWorkspaceId: "default",
          assignmentId: h.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 2,
          expectedLeaseTokenSha256: leaseV2Token,
          leaseTokenSha256: leaseV3Token,
          workerSentThrough: 5,
          idempotencyKey: `${suffix}:renew:3`,
        }).lease;
        assert.equal(leaseV3.parentDispatchAuthority.durableRunVersion, 3);
        assert.ok(leaseV3.expiresAt <= leaseV3.parentDispatchAuthority.durableRunLeaseExpiresAt);

        const lockClient = await scopedPool.connect();
        const secondEvent = statusEvent(2, appended.events[0]!.eventSha256, 5);
        let worker: ReturnType<typeof runAssignmentWorker> | undefined;
        try {
          await lockClient.query("BEGIN");
          await lockClient.query("UPDATE tasks SET deleted_at = '2026-07-14T00:00:00.000Z' WHERE task_id = $1", [
            h.taskId,
          ]);
          const workerApplicationName = `hx501-race-${suffix}`;
          worker = runAssignmentWorker(scopedUrl.toString(), database, workerApplicationName, {
            registryWorkspaceId: "default",
            assignmentId: h.assignmentId,
            expectedAssignmentGeneration: 1,
            expectedLeaseRevision: 3,
            leaseTokenSha256: leaseV3Token,
            events: [secondEvent],
          });
          await worker.ready;
          let workerSettled = false;
          void worker.result.then(
            () => {
              workerSettled = true;
            },
            () => {
              workerSettled = true;
            },
          );
          await waitForParentTaskShareLock(scopedPool, workerApplicationName);
          assert.equal(workerSettled, false, "worker progress must wait for the parent-task ownership row");
          await lockClient.query("COMMIT");
          const workerResult = await worker.result;
          assert.equal(workerResult.ok, false);
          if (workerResult.ok) assert.fail("worker progress crossed a committed parent-context drift");
          assert.match(workerResult.error, /canonical durable parent context|durable assignment authority/u);
        } catch (error) {
          await lockClient.query("ROLLBACK").catch(() => undefined);
          await worker?.result.catch(() => undefined);
          throw error;
        } finally {
          lockClient.release();
        }

        const now = h.durableRuns.readDatabaseNow();
        const payloadJson = canonicalJsonString(secondEvent.payload);
        assert.throws(() =>
          setupDb
            .prepare(
              `INSERT INTO remote_worker_assignment_events (
                 registry_workspace_id, assignment_id, assignment_generation, sequence, event_id,
                 event_type, payload_json, payload_sha256, previous_event_sha256, event_sha256,
                 worker_sent_through, received_at
               ) VALUES (
                 'default', @assignmentId, 1, 2, 'direct-after-drift', 'status', @payloadJson,
                 @payloadSha256, @previousEventSha256, @eventSha256, 5, @receivedAt
               )`,
            )
            .run({
              assignmentId: h.assignmentId,
              payloadJson,
              payloadSha256: D(payloadJson),
              previousEventSha256: appended.events[0]!.eventSha256,
              eventSha256: D("direct-after-drift"),
              receivedAt: now,
            }),
        );
        assert.throws(() =>
          setupDb
            .prepare(
              `INSERT INTO remote_worker_assignment_settlements (
                 registry_workspace_id, assignment_id, assignment_generation, schema_version,
                 outcome, origin, gateway_actor_id, recovery_evidence_sha256,
                 final_event_sequence, final_event_sha256, result_sha256, output_manifest_sha256,
                 failure_sha256, idempotency_key, request_sha256, settled_at
               ) VALUES (
                 'default', @assignmentId, 1, 'goatcitadel.remote-worker-assignment-settlement.v1',
                 'completed', 'worker', NULL, NULL, 1, @finalEventSha256, @resultSha256,
                 @outputManifestSha256, NULL, @idempotencyKey, @requestSha256, @settledAt
               )`,
            )
            .run({
              assignmentId: h.assignmentId,
              finalEventSha256: appended.events[0]!.eventSha256,
              resultSha256: D("direct-result"),
              outputManifestSha256: D("direct-output"),
              idempotencyKey: `${suffix}:direct-settlement`,
              requestSha256: D("direct-settlement"),
              settledAt: now,
            }),
        );
      } finally {
        setupDb.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );

  // The M3 live-PostgreSQL contention proof for protected routes 2-6. Every
  // race below queues real concurrent transactions on the owner's canonical
  // advisory locks (namespaces 411/412/501-504), verifies the loser is
  // genuinely blocked via pg_stat_activity, commits the winning authority
  // mutation, and then proves the stale side is REJECTED by the in-transaction
  // protected commit fence (never interleaved) while the winning side commits
  // exactly once:
  //   1. protected-context drift racing an exact-fence event append;
  //   2. duplicate lease-renewal replay racing the first consume;
  //   3. credential rotation committing against in-flight fenced read + write;
  //   4. duplicate settlement replay racing the first settlement insert;
  //   5. mesh join-authority revoke committing ahead of queued fenced
  //      read + write, plus a stale post-revoke settlement.
  postgresIt(
    "serializes rotation, protected-context drift, join-authority revoke, and duplicate replay against in-flight fenced routes 2-6",
    { timeout: 180_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx502_fence_race_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const setupDb = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx502-fence-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });
      const spawnedWorkers: Array<Promise<WorkerResult>> = [];
      const spawnFencedWorker = (applicationName: string, request: FencedRepositoryWorkerRequest) => {
        const worker = runFencedRepositoryWorker(scopedUrl.toString(), database, applicationName, request);
        spawnedWorkers.push(worker.result.catch(() => ({ ok: false as const, error: "worker cleanup" })));
        return worker;
      };

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const h = seedProtectedFenceHarness(setupDb, suffix);
        const workerId = h.finalized.generation.workerId;
        const nodeId = h.finalized.generation.nodeId;
        const leaseA1 = D(`${suffix}:alpha:lease:1`);
        const assignmentA = seedFencedAssignment(h, suffix, "alpha", h.admitted.admission.admissionGeneration, leaseA1);
        const eventCount = (assignmentId: string) =>
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_events
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            { assignmentId },
          );
        const leaseCount = (assignmentId: string, leaseRevision?: number) =>
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_leases
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId
               ${leaseRevision === undefined ? "" : "AND lease_revision = @leaseRevision"}`,
            leaseRevision === undefined ? { assignmentId } : { assignmentId, leaseRevision },
          );
        const settlementCount = (assignmentId: string) =>
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements
             WHERE registry_workspace_id = 'default' AND assignment_id = @assignmentId`,
            { assignmentId },
          );

        // The complete M2+M3 protected commit fence PASSES live before any race.
        assert.equal(
          h.assignments.resolveActiveAuthorityByLeaseTokenHash(leaseA1, h.fence)?.assignment.assignmentId,
          assignmentA.assignmentId,
        );

        // Race 1 — protected-context drift racing an exact-fence write. Both
        // transactions queue on the held executionWorkspace advisory lock so
        // they are provably concurrent; after release the exact fence commits
        // its append exactly once and the drifted-context fence is rejected by
        // the in-transaction recheck AFTER the canonical locks, not at intake.
        const driftedFence: RemoteWorkerAssignmentProtectedCommitFence = {
          ...h.fence,
          credentialAuthority: {
            ...h.fence.credentialAuthority,
            protectedAdmissionContextSha256: D(`${suffix}:drifted-protected-context`),
          },
        };
        const appendCommandOne = {
          registryWorkspaceId: "default",
          assignmentId: assignmentA.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: leaseA1,
          events: [statusEvent(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 1)],
        } as const;
        let firstEventSha256 = "";
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const appendWorker = spawnFencedWorker(`hx502-drift-append-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "appendEvents",
              args: [appendCommandOne, h.fence],
            });
            const driftWorker = spawnFencedWorker(`hx502-drift-read-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "resolveActiveAuthorityByLeaseTokenHash",
              args: [leaseA1, driftedFence],
            });
            await Promise.all([appendWorker.ready, driftWorker.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-drift-append-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-drift-read-${suffix}`, ", 411)");
            await hold.release();
            const [appendResult, driftResult] = await Promise.all([appendWorker.result, driftWorker.result]);
            assert.equal(appendResult.ok, true, `exact-fence append must win: ${JSON.stringify(appendResult)}`);
            if (appendResult.ok) {
              assert.equal(appendResult.value.disposition, "appended");
              assert.equal(appendResult.value.acknowledgedThrough, 1);
              firstEventSha256 = String(appendResult.value.events[0].eventSha256);
            }
            assert.equal(driftResult.ok, false, "drifted protected-context fence must lose");
            if (!driftResult.ok) assert.match(driftResult.error, /protected commit authority/u);
          } finally {
            await hold.release();
          }
        }
        assert.equal(eventCount(assignmentA.assignmentId), 1);
        assert.equal(
          h.assignments.resolveActiveAuthorityByLeaseTokenHash(leaseA1, h.fence)?.assignment.assignmentId,
          assignmentA.assignmentId,
        );

        // Race 2 — duplicate lease-renewal replay racing the first consume:
        // two byte-identical fenced renewals queue concurrently; exactly one
        // consumes lease revision 1 and the other replays the identical
        // canonical lease without a second materialization.
        const leaseA2 = D(`${suffix}:alpha:lease:2`);
        const renewCommand = {
          registryWorkspaceId: "default",
          assignmentId: assignmentA.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          expectedLeaseTokenSha256: leaseA1,
          leaseTokenSha256: leaseA2,
          workerSentThrough: 1,
          idempotencyKey: `${suffix}:alpha:renew:2`,
        } as const;
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const renewOne = spawnFencedWorker(`hx502-renew-one-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "renewLease",
              args: [renewCommand, h.fence],
            });
            const renewTwo = spawnFencedWorker(`hx502-renew-two-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "renewLease",
              args: [renewCommand, h.fence],
            });
            await Promise.all([renewOne.ready, renewTwo.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-renew-one-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-renew-two-${suffix}`, ", 411)");
            await hold.release();
            const results = await Promise.all([renewOne.result, renewTwo.result]);
            for (const result of results) {
              assert.equal(result.ok, true, `fenced renewal race must never interleave: ${JSON.stringify(result)}`);
            }
            const renewals = results.map((result) => (result.ok ? result.value : assert.fail("unreachable")));
            assert.deepEqual(renewals.map((outcome) => String(outcome.disposition)).sort(), [
              "renewed",
              "replayed_without_lease_secret",
            ]);
            assert.equal(canonicalJsonString(renewals[0]!.lease), canonicalJsonString(renewals[1]!.lease));
            assert.equal(Number(renewals[0]!.lease.leaseRevision), 2);
          } finally {
            await hold.release();
          }
        }
        assert.equal(leaseCount(assignmentA.assignmentId, 2), 1);
        assert.equal(leaseCount(assignmentA.assignmentId), 2);

        // Race 3 — credential rotation committing against an in-flight fenced
        // write (event append) and read (active-authority sync). Both fenced
        // transactions are queued and provably still blocked when the rotation
        // commits; on release the storage recheck inside their transactions
        // observes the committed rotation and rejects both without writing.
        const rotatedCredentialTokenSha256 = D(`${suffix}:rotation-credential`);
        let rotatedCredential: RemoteWorkerRuntimeCredentialRecord | undefined;
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const staleWrite = spawnFencedWorker(`hx502-rotation-write-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "appendEvents",
              args: [
                {
                  registryWorkspaceId: "default",
                  assignmentId: assignmentA.assignmentId,
                  expectedAssignmentGeneration: 1,
                  expectedLeaseRevision: 2,
                  leaseTokenSha256: leaseA2,
                  events: [statusEvent(2, firstEventSha256, 2)],
                },
                h.fence,
              ],
            });
            const staleRead = spawnFencedWorker(`hx502-rotation-read-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "resolveActiveAuthorityByLeaseTokenHash",
              args: [leaseA2, h.fence],
            });
            await Promise.all([staleWrite.ready, staleRead.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-rotation-write-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-rotation-read-${suffix}`, ", 411)");
            const rotated = h.workerAdmissions.rotateRuntimeCredential({
              registryWorkspaceId: "default",
              workerId,
              workerGeneration: h.finalized.generation.workerGeneration,
              expectedCredentialId: h.finalized.credential.credentialId,
              expectedCredentialGeneration: h.finalized.credential.credentialGeneration,
              verifiedTransportReceiptSha256: D(`${suffix}:rotation-transport`),
              verifiedProofOfPossessionReceiptSha256: D(`${suffix}:rotation-pop`),
              credentialIssuanceProofSha256: D(`${suffix}:rotation-issuance`),
              expiresInSeconds: 600,
              credentialTokenSha256: rotatedCredentialTokenSha256,
              idempotencyKey: `${suffix}:rotation`,
            });
            assert.equal(rotated.disposition, "created");
            rotatedCredential = rotated.credential;
            assert.equal(
              await isWaitingOnAdvisoryLock(scopedPool, `hx502-rotation-write-${suffix}`, ", 411)"),
              true,
              "the fenced write must still be blocked when the rotation commits",
            );
            assert.equal(
              await isWaitingOnAdvisoryLock(scopedPool, `hx502-rotation-read-${suffix}`, ", 411)"),
              true,
              "the fenced read must still be blocked when the rotation commits",
            );
            await hold.release();
            const [writeResult, readResult] = await Promise.all([staleWrite.result, staleRead.result]);
            assert.equal(writeResult.ok, false, "the stale fenced write must lose to the committed rotation");
            if (!writeResult.ok) assert.match(writeResult.error, /protected commit authority/u);
            assert.equal(readResult.ok, false, "the stale fenced read must lose to the committed rotation");
            if (!readResult.ok) assert.match(readResult.error, /protected commit authority/u);
          } finally {
            await hold.release();
          }
        }
        assert.ok(rotatedCredential);
        assert.equal(eventCount(assignmentA.assignmentId), 1);
        assert.equal(leaseCount(assignmentA.assignmentId), 2);
        assert.equal(
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_runtime_credentials
             WHERE registry_workspace_id = 'default' AND worker_id = @workerId AND credential_generation = 2`,
            { workerId },
          ),
          1,
          "the winning rotation must commit exactly one generation-2 credential",
        );

        // Rebuild a CURRENT authority under the rotated credential exactly the
        // way the committed regressions do: revoke the superseded admission,
        // issue a replacement join authority, re-admit, and re-fence.
        h.capabilityAdmissions.revoke({
          workspaceId: "default",
          nodeId,
          admissionGeneration: h.admitted.admission.admissionGeneration,
          reason: "credential rotated before replacement admission",
          revokedByActorId: "operator-a",
          idempotencyKey: `${suffix}:admission-revoke:1`,
        });
        const rawMeshNodeCredentialTwo = "b".repeat(43);
        const secondIssued = h.meshNodeAdmissions.issueJoinAuthority({
          ...h.joinAuthorityInput,
          idempotencyKey: `${suffix}:mesh-authority:2`,
          rawMeshNodeCredential: rawMeshNodeCredentialTwo,
        });
        assert.equal(secondIssued.disposition, "created");
        const secondAdmitted = h.meshNodeAdmissions.admitWithNonce({
          nonce: protectedCredentialNonce(setupDb, rotatedCredential, `${suffix}:admit:2`),
          command: {
            ...h.admissionCommand,
            rawMeshNodeCredential: rawMeshNodeCredentialTwo,
            protocolBodySha256: D(`${suffix}:admission-body:2`),
            transportReceiptSha256: D(`${suffix}:admission-transport:2`),
            proofOfPossessionReceiptSha256: D(`${suffix}:admission-pop:2`),
            tlsExporterSha256: D(`${suffix}:admission-exporter:2`),
            idempotencyKey: `${suffix}:mesh-admission:2`,
          },
        });
        assert.equal(secondAdmitted.disposition, "admitted");
        const rotatedMeshFence = h.meshNodeAdmissions.resolveCurrentForRuntimeCredential({
          ...h.credentialResolutionInput,
          credentialId: rotatedCredential.credentialId,
          credentialGeneration: rotatedCredential.credentialGeneration,
          authorizationCredentialSha256: rotatedCredentialTokenSha256,
        });
        assert.ok(rotatedMeshFence);
        const rotatedFence: RemoteWorkerAssignmentProtectedCommitFence = {
          credentialAuthority: {
            ...h.claimAuthority,
            credentialId: rotatedCredential.credentialId,
            credentialGeneration: rotatedCredential.credentialGeneration,
            authorizationCredentialSha256: rotatedCredentialTokenSha256,
            claimsSha256: rotatedCredential.claimsSha256,
          },
          meshAdmission: rotatedMeshFence,
        };
        const leaseB1 = D(`${suffix}:beta:lease:1`);
        const assignmentB = seedFencedAssignment(
          h,
          suffix,
          "beta",
          secondAdmitted.admission.admissionGeneration,
          leaseB1,
        );
        const leaseC1 = D(`${suffix}:gamma:lease:1`);
        const assignmentC = seedFencedAssignment(
          h,
          suffix,
          "gamma",
          secondAdmitted.admission.admissionGeneration,
          leaseC1,
        );
        assert.equal(
          h.assignments.resolveActiveAuthorityByLeaseTokenHash(leaseB1, rotatedFence)?.assignment.assignmentId,
          assignmentB.assignmentId,
        );
        assert.equal(
          h.assignments.resolveControlReadAuthorityByLeaseTokenHash(
            {
              registryWorkspaceId: "default",
              assignmentId: assignmentC.assignmentId,
              expectedAssignmentGeneration: 1,
              expectedLeaseRevision: 1,
              leaseTokenSha256: leaseC1,
            },
            rotatedFence,
          )?.disposition,
          "active",
        );

        // Race 4 — duplicate settlement replay racing the first settlement:
        // two byte-identical fenced settlements queue concurrently; exactly one
        // inserts the terminal settlement row and the other replays it.
        const settleCommand = {
          registryWorkspaceId: "default",
          assignmentId: assignmentC.assignmentId,
          expectedAssignmentGeneration: 1,
          expectedLeaseRevision: 1,
          leaseTokenSha256: leaseC1,
          outcome: "failed",
          origin: "worker",
          finalEventSequence: 0,
          finalEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
          failureSha256: D(`${suffix}:gamma:failure`),
          idempotencyKey: `${suffix}:gamma:settle`,
        } as const;
        {
          const hold = await holdAdvisoryLock(scopedPool, 411, "default");
          try {
            const settleOne = spawnFencedWorker(`hx502-settle-one-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "settleAssignment",
              args: [settleCommand, rotatedFence],
            });
            const settleTwo = spawnFencedWorker(`hx502-settle-two-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "settleAssignment",
              args: [settleCommand, rotatedFence],
            });
            await Promise.all([settleOne.ready, settleTwo.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-settle-one-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-settle-two-${suffix}`, ", 411)");
            await hold.release();
            const results = await Promise.all([settleOne.result, settleTwo.result]);
            for (const result of results) {
              assert.equal(result.ok, true, `fenced settlement race must never interleave: ${JSON.stringify(result)}`);
            }
            const settlements = results.map((result) => (result.ok ? result.value : assert.fail("unreachable")));
            assert.deepEqual(settlements.map((outcome) => String(outcome.disposition)).sort(), ["replayed", "settled"]);
            assert.equal(
              canonicalJsonString(settlements[0]!.settlement),
              canonicalJsonString(settlements[1]!.settlement),
            );
          } finally {
            await hold.release();
          }
        }
        assert.equal(settlementCount(assignmentC.assignmentId), 1);

        // Race 5 — mesh join-authority revoke racing fenced assignment read +
        // write. The held node advisory lock (412) freezes the revoke AFTER it
        // owns the workspace lock (411), so the queue order is pinned: revoke
        // commits first, then the queued fenced renewal and control read must
        // observe the committed revocation and reject without writing.
        {
          const hold = await holdAdvisoryLock(scopedPool, 412, `default:${nodeId}`);
          try {
            const revokeWorker = spawnFencedWorker(`hx502-revoke-${suffix}`, {
              repositoryModule: "remote-worker-mesh-node-admission-repo",
              repositoryExport: "RemoteWorkerMeshNodeAdmissionRepository",
              operation: "revokeJoinAuthority",
              args: [
                {
                  registryWorkspaceId: "default",
                  workerId,
                  workerGeneration: h.finalized.generation.workerGeneration,
                  workspaceId: "default",
                  joinAuthorityGeneration: secondIssued.authority.joinAuthorityGeneration,
                  reasonCode: "operator.revoked",
                  reason: "live contention proof revocation",
                  revokedByActorId: "operator-a",
                  idempotencyKey: `${suffix}:mesh-authority-revoke:2`,
                },
              ],
            });
            await revokeWorker.ready;
            await waitForAdvisoryLockWait(scopedPool, `hx502-revoke-${suffix}`, ", 412)");
            const staleRenew = spawnFencedWorker(`hx502-revoke-renew-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "renewLease",
              args: [
                {
                  registryWorkspaceId: "default",
                  assignmentId: assignmentB.assignmentId,
                  expectedAssignmentGeneration: 1,
                  expectedLeaseRevision: 1,
                  expectedLeaseTokenSha256: leaseB1,
                  leaseTokenSha256: D(`${suffix}:beta:lease:2`),
                  workerSentThrough: 0,
                  idempotencyKey: `${suffix}:beta:renew:2`,
                },
                rotatedFence,
              ],
            });
            const staleControlRead = spawnFencedWorker(`hx502-revoke-read-${suffix}`, {
              repositoryModule: "remote-worker-assignment-repo",
              repositoryExport: "RemoteWorkerAssignmentRepository",
              operation: "resolveControlReadAuthorityByLeaseTokenHash",
              args: [
                {
                  registryWorkspaceId: "default",
                  assignmentId: assignmentB.assignmentId,
                  expectedAssignmentGeneration: 1,
                  expectedLeaseRevision: 1,
                  leaseTokenSha256: leaseB1,
                },
                rotatedFence,
              ],
            });
            await Promise.all([staleRenew.ready, staleControlRead.ready]);
            await waitForAdvisoryLockWait(scopedPool, `hx502-revoke-renew-${suffix}`, ", 411)");
            await waitForAdvisoryLockWait(scopedPool, `hx502-revoke-read-${suffix}`, ", 411)");
            await hold.release();
            const [revokeResult, renewResult, controlReadResult] = await Promise.all([
              revokeWorker.result,
              staleRenew.result,
              staleControlRead.result,
            ]);
            assert.equal(revokeResult.ok, true, `the queued revoke must commit: ${JSON.stringify(revokeResult)}`);
            assert.equal(renewResult.ok, false, "the fenced renewal must lose to the committed revocation");
            if (!renewResult.ok) assert.match(renewResult.error, /protected commit authority/u);
            assert.equal(controlReadResult.ok, false, "the fenced control read must lose to the committed revocation");
            if (!controlReadResult.ok) assert.match(controlReadResult.error, /protected commit authority/u);
          } finally {
            await hold.release();
          }
        }
        assert.equal(leaseCount(assignmentB.assignmentId), 1);
        assert.equal(eventCount(assignmentB.assignmentId), 0);
        assert.equal(settlementCount(assignmentB.assignmentId), 0);
        assert.equal(
          countRows(
            setupDb,
            `SELECT COUNT(*) AS count FROM remote_worker_mesh_join_authority_revocations
             WHERE registry_workspace_id = 'default' AND worker_id = @workerId
               AND join_authority_generation = @joinAuthorityGeneration`,
            { workerId, joinAuthorityGeneration: secondIssued.authority.joinAuthorityGeneration },
          ),
          1,
          "the winning revoke must commit exactly one revocation row",
        );

        // A stale post-revoke settlement is rejected by the same fence before
        // any terminal write.
        assert.throws(
          () =>
            h.assignments.settleAssignment(
              {
                registryWorkspaceId: "default",
                assignmentId: assignmentB.assignmentId,
                expectedAssignmentGeneration: 1,
                expectedLeaseRevision: 1,
                leaseTokenSha256: leaseB1,
                outcome: "failed",
                origin: "worker",
                finalEventSequence: 0,
                finalEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
                failureSha256: D(`${suffix}:beta:failure`),
                idempotencyKey: `${suffix}:beta:settle`,
              },
              rotatedFence,
            ),
          /protected commit authority/u,
        );
        assert.equal(settlementCount(assignmentB.assignmentId), 0);
      } finally {
        await Promise.allSettled(spawnedWorkers);
        setupDb.close();
        await migrations.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function seedPostgresHarness(db: PostgresSyncDatabaseClient, seed: string) {
  const tasks = new TaskRepository(db);
  const durableRuns = new DurableRunRepository(db);
  const mesh = new MeshRepository(db);
  const nodeAdmissions = new MeshCapabilityNodeAdmissionRepository(db);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${seed}`;
  const durableRunId = `run-${seed}`;
  tasks.create({ title: "PG remote assignment", workspaceId: "default" }, now, { taskId });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  durableRuns.createRun({
    runId: durableRunId,
    workflowKey: "chat.turn.execute",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwnerId: "gateway-a",
    leaseHeartbeatAt: now,
    leaseExpiresAt: FUTURE,
    version: 1,
    startedAt: now,
    now,
    metadata: {
      remoteWorkerAssignmentParentContext: parentContext,
      remoteWorkerAssignmentParentContextSha256: parentContextSha256,
    },
  });
  const bootstrap = workerAdmissions.createBootstrap(bootstrapInput(seed)).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission(finalizeInput(bootstrap, seed));
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  const joinToken = `join:${seed}`;
  mesh.upsertNode({
    nodeId: bootstrap.nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint,
    joinedAt: now,
    lastSeenAt: now,
  });
  mesh.issueJoinToken(joinToken, FUTURE);
  assert.equal(mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now), true);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  assert.ok(joinTokenSha256);
  const nodeAdmission = nodeAdmissions.admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `${seed}:node-admission`,
  });
  const manifest: RemoteWorkerAssignmentManifest = {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    registryWorkspaceId: "default",
    ...parentInput,
    capabilityProfileSha256: D(`${seed}:capability-profile`),
    contextSnapshotSha256: D(`${seed}:context`),
    toolEffectPostureSha256: D(`${seed}:posture`),
    pathJailSha256: D(`${seed}:jail`),
    parentContextSha256,
    requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
    deadlineAt: FUTURE,
    leaseTtlSeconds: 60,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes: 131_072,
    maxArtifactBytes: 1_048_576,
  };
  const assignment = assignments.createAssignment({
    manifest,
    createdByActorId: "gateway-a",
    idempotencyKey: `${seed}:assignment`,
  }).assignment;
  const startInput = {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256: D(`${seed}:lease:1`),
    idempotencyKey: `${seed}:generation:1`,
  } as const;
  return {
    durableRuns,
    workerAdmissions,
    assignments,
    worker,
    nodeAdmission,
    durableRunId,
    taskId,
    manifest,
    assignmentId: assignment.assignmentId,
    startInput,
  };
}

function assertDirectPostgresManifestRejected(
  db: PostgresSyncDatabaseClient,
  h: ReturnType<typeof seedPostgresHarness>,
  seed: string,
  manifestJson: string,
): void {
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO remote_worker_assignments (
           registry_workspace_id, assignment_id, execution_workspace_id, durable_run_id, task_id,
           session_id, turn_id, manifest_json, manifest_sha256, created_by_actor_id,
           idempotency_key, request_sha256, created_at
         ) VALUES (
           'default', @directAssignmentId, 'default', @durableRunId, @taskId,
           NULL, NULL, @manifestJson, @manifestSha256, 'gateway-a',
           @idempotencyKey, @requestSha256, @createdAt
         )`,
      )
      .run({
        directAssignmentId: `assignment-${seed}`,
        durableRunId: h.durableRunId,
        taskId: h.taskId,
        manifestJson,
        manifestSha256: D(manifestJson),
        idempotencyKey: `assignment:${seed}`,
        requestSha256: D(`assignment:${seed}`),
        createdAt: h.durableRuns.readDatabaseNow(),
      }),
  );
}

function assertDirectPostgresEventRejected(
  db: PostgresSyncDatabaseClient,
  h: ReturnType<typeof seedPostgresHarness>,
  previousEventSha256: string,
  seed: string,
  eventType: RemoteWorkerAssignmentEventInput["eventType"],
  payload: Record<string, unknown> | string,
  workerSentThrough = 5,
): void {
  const payloadJson = typeof payload === "string" ? payload : JSON.stringify(payload);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO remote_worker_assignment_events (
           registry_workspace_id, assignment_id, assignment_generation, sequence, event_id,
           event_type, payload_json, payload_sha256, previous_event_sha256, event_sha256,
           worker_sent_through, received_at
         ) VALUES (
           'default', @assignmentId, 1, 2, @eventId, @eventType, @payloadJson, @payloadSha256,
           @previousEventSha256, @eventSha256, @workerSentThrough, @receivedAt
         )`,
      )
      .run({
        assignmentId: h.assignmentId,
        eventId: `direct-invalid-${seed}`,
        eventType,
        payloadJson,
        payloadSha256: D(`payload:${seed}`),
        previousEventSha256,
        eventSha256: D(`event:${seed}`),
        workerSentThrough,
        receivedAt: h.durableRuns.readDatabaseNow(),
      }),
  );
}

function runtimeManifest(seed: string) {
  const payload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seed}:bundle`),
    dependencyLockSha256: D(`${seed}:lock`),
    vendorTreeSha256: D(`${seed}:vendor`),
    launcherSha256: D(`${seed}:launcher`),
    installedTreeManifestSha256: D(`${seed}:tree`),
    installedTreeFileCount: 12,
    platform: "windows",
    architecture: "x64",
  } as const;
  return {
    payload,
    payloadSha256: D(canonicalJsonString(payload)),
    signatureAlgorithm: "ed25519" as const,
    signerKeyId: `key-${seed}`,
    signatureBase64Url: "A".repeat(86),
  };
}

function bootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
  return {
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "windows",
    architecture: "x64",
    runtimeManifest: runtimeManifest(seed),
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `${seed}:bootstrap`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
  };
}

function finalizeInput(
  bootstrap: ReturnType<RemoteWorkerAdmissionRepository["createBootstrap"]>["record"],
  seed: string,
): FinalizeRemoteWorkerBootstrapAdmissionCommand {
  return {
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${seed}:spki`),
    verifiedClientCertificateSha256: D(`${seed}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${seed}:anchor`),
    verifiedTransportReceiptSha256: D(`${seed}:transport`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:pop`),
    verifiedDownloadReceiptSha256: D(`${seed}:download`),
    verifiedInstalledTreeAttestationSha256: D(`${seed}:attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seed}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${seed}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${seed}:credential`),
    exchangeIdempotencyKey: `${seed}:exchange`,
  };
}

function statusEvent(
  sequence: number,
  previousEventSha256: string,
  workerSentThrough: number,
): RemoteWorkerAssignmentEventInput {
  return {
    sequence,
    eventId: `status-${sequence}`,
    eventType: "status",
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      phase: "running",
      statusSha256: D(`status:${sequence}`),
    },
    previousEventSha256,
    workerSentThrough,
  };
}

type WorkerResult = { ok: true; value: Record<string, any> } | { ok: false; error: string };
type WorkerMessage = { kind: "ready" } | { kind: "result"; result: WorkerResult };

async function waitForParentTaskShareLock(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity activity
         WHERE activity.application_name = $1
           AND activity.wait_event_type = 'Lock'
           AND position('SELECT workspace_id, deleted_at FROM tasks' IN activity.query) > 0
           AND position('FOR SHARE' IN activity.query) > 0
       ) AS waiting`,
      [applicationName],
    );
    if (state.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${applicationName} to block on the repository task FOR SHARE lock`);
}

function runAssignmentWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  input: unknown,
): { ready: Promise<void>; result: Promise<WorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(ASSIGNMENT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      input,
      repositoryModuleUrl: new URL(`./remote-worker-assignment-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let readyReceived = false;
  let resultReceived = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: WorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: WorkerMessage) => {
    if (message.kind === "ready") {
      readyReceived = true;
      resolveReady();
      return;
    }
    resultReceived = true;
    if (!readyReceived) rejectReady(new Error("HX-502/HX-504 assignment worker reported before its ready barrier"));
    resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    const error = new Error(`HX-502/HX-504 assignment worker exited before reporting (${code})`);
    if (!readyReceived) rejectReady(error);
    if (!resultReceived) rejectResult(error);
  });
  return { ready, result };
}

const ASSIGNMENT_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    let result;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { RemoteWorkerAssignmentRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      parentPort.postMessage({ kind: "ready" });
      result = { ok: true, value: new RemoteWorkerAssignmentRepository(db).appendEvents(workerData.input) };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "opaque assignment failure" };
    } finally {
      if (db) db.close();
    }
    parentPort.postMessage({ kind: "result", result });
  })();
`;

// ---------------------------------------------------------------------------
// M3 live-contention fixture: the full protected-provenance authority chain
// (protected bootstrap evidence -> M2 credential -> M3 join authority ->
// nonce-consumed admission -> current mesh fence) that lets the complete
// routes 2-6 protected commit fence PASS against live PostgreSQL, plus the
// advisory-lock race harness that queues real concurrent transactions on the
// owner's canonical locks.
// ---------------------------------------------------------------------------

function countRows(db: PostgresSyncDatabaseClient, sql: string, params: Record<string, unknown>): number {
  return Number(db.prepare(sql).get<{ count: number | bigint }>(params)?.count ?? 0);
}

interface HeldAdvisoryLock {
  release(): Promise<void>;
}

/**
 * Holds one of the assignment owner's canonical pg_advisory_xact_lock keys in
 * an open raw transaction so fenced repository transactions queue behind it.
 * `release()` commits and returns the connection; it is idempotent so a phase
 * can release inside its body and again in its finally block.
 */
async function holdAdvisoryLock(pool: Pool, namespace: 411 | 412, key: string): Promise<HeldAdvisoryLock> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, ${namespace})) AS locked`, [key]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
  let settled = false;
  return {
    release: async () => {
      if (settled) return;
      settled = true;
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

async function isWaitingOnAdvisoryLock(pool: Pool, applicationName: string, lockLiteral: string): Promise<boolean> {
  const state = await pool.query<{ waiting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_stat_activity activity
       WHERE activity.application_name = $1
         AND activity.wait_event_type = 'Lock'
         AND activity.wait_event = 'advisory'
         AND position($2 IN activity.query) > 0
     ) AS waiting`,
    [applicationName, lockLiteral],
  );
  return state.rows[0]?.waiting === true;
}

async function waitForAdvisoryLockWait(pool: Pool, applicationName: string, lockLiteral: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isWaitingOnAdvisoryLock(pool, applicationName, lockLiteral)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${applicationName} to block on the "${lockLiteral}" advisory lock`);
}

function postgresNonceClock(db: PostgresSyncDatabaseClient): { timestamp: string; expiresAt: string } {
  const row = db
    .prepare(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso`)
    .get<{ now_iso: string }>();
  if (typeof row?.now_iso !== "string") throw new Error("PostgreSQL nonce clock unavailable");
  return { timestamp: row.now_iso, expiresAt: new Date(Date.parse(row.now_iso) + 60_000).toISOString() };
}

function protectedBootstrapNonce(
  db: PostgresSyncDatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clock = postgresNonceClock(db);
  return {
    authority: {
      kind: "bootstrap",
      registryWorkspaceId: bootstrap.registryWorkspaceId,
      bootstrapId: bootstrap.bootstrapId,
      workerId: bootstrap.workerId,
      targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    },
    nonceSha256: D(`${seed}:nonce`),
    timestamp: clock.timestamp,
    expiresAt: clock.expiresAt,
  };
}

function protectedCredentialNonce(
  db: PostgresSyncDatabaseClient,
  credential: RemoteWorkerRuntimeCredentialRecord,
  seed: string,
): RemoteWorkerNonceConsumeInput {
  const clock = postgresNonceClock(db);
  return {
    authority: {
      kind: "credential",
      registryWorkspaceId: credential.registryWorkspaceId,
      workerId: credential.workerId,
      workerGeneration: credential.workerGeneration,
      credentialGeneration: credential.credentialGeneration,
      credentialId: credential.credentialId,
    },
    nonceSha256: D(`${seed}:nonce`),
    timestamp: clock.timestamp,
    expiresAt: clock.expiresAt,
  };
}

function protectedSignerPin(): RemoteWorkerProtectedAdmissionSignerPin {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 0x22)]);
  return {
    schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
    signatureAlgorithm: "ed25519",
    keysetGeneration: 1,
    keysetReceiptSha256: D("keyset:1"),
    signerSpkiSha256: DBytes(spki),
    signerSpkiBase64Url: spki.toString("base64url"),
  };
}

function protectedWorkerSpki(seed: string): Buffer {
  return Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(D(`${seed}:key`), "hex")]);
}

function protectedBootstrapInput(seed: string): CreateRemoteWorkerBootstrapCommand {
  return {
    ...bootstrapInput(seed),
    protectedAdmissionSignerPin: protectedSignerPin(),
  };
}

function protectedFinalizeInput(
  db: PostgresSyncDatabaseClient,
  bootstrap: RemoteWorkerBootstrapRecord,
  bootstrapSeed: string,
  connectionSeed: string,
): FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput {
  const nonce = protectedBootstrapNonce(db, bootstrap, `${bootstrapSeed}:${connectionSeed}`);
  const admittedWorkerSpki = protectedWorkerSpki(bootstrapSeed);
  const base = {
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${bootstrapSeed}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: DBytes(admittedWorkerSpki),
    verifiedClientCertificateSha256: D(`${bootstrapSeed}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls" as const,
    verifiedTransportTrustAnchorSha256: D(`${bootstrapSeed}:anchor`),
    verifiedTransportReceiptSha256: D(`${connectionSeed}:transport`),
    verifiedProofOfPossessionReceiptSha256: D(`${connectionSeed}:pop`),
    verifiedDownloadReceiptSha256: D(`${bootstrapSeed}:download`),
    verifiedInstalledTreeAttestationSha256: D(`${bootstrapSeed}:attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${bootstrapSeed}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${connectionSeed}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${connectionSeed}:credential`),
    exchangeIdempotencyKey: `${bootstrapSeed}:exchange`,
  };
  const tlsExporterSha256 = D(`${connectionSeed}:tls-exporter`);
  const contextSha256 = remoteWorkerProtectedAdmissionContextSha256({
    registryWorkspaceId: bootstrap.registryWorkspaceId,
    bootstrapId: bootstrap.bootstrapId,
    workerId: bootstrap.workerId,
    nodeId: bootstrap.nodeId,
    targetWorkerGeneration: bootstrap.targetWorkerGeneration,
    platform: bootstrap.platform,
    architecture: bootstrap.architecture,
    runtimeManifestSha256: base.verifiedRuntimeManifestSha256,
    runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
    workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    workerPublicKeySpkiSha256: base.verifiedPublicKeySpkiSha256,
    clientCertificateSha256: base.verifiedClientCertificateSha256,
    transportTrustAnchorSha256: base.verifiedTransportTrustAnchorSha256,
    tlsExporterSha256,
    evidenceNonceSha256: nonce.nonceSha256,
    downloadVerificationReceiptSha256: base.verifiedDownloadReceiptSha256,
    installedTreeAttestationSha256: base.verifiedInstalledTreeAttestationSha256,
    installedTreeVerificationReceiptSha256: base.verifiedInstalledTreeReceiptSha256,
  });
  const operationId = Buffer.from(D(`${connectionSeed}:operation`), "hex").subarray(0, 16);
  const envelope = Buffer.alloc(288);
  envelope.write("GCAE", 0, "ascii");
  envelope.writeUInt16LE(1, 4);
  envelope.writeUInt8(1, 6);
  envelope.writeUInt32LE(288, 8);
  operationId.copy(envelope, 16);
  Buffer.from(nonce.nonceSha256, "hex").copy(envelope, 32);
  envelope.writeBigUInt64LE(BigInt(bootstrap.targetWorkerGeneration), 64);
  Buffer.from(contextSha256, "hex").copy(envelope, 96);
  Buffer.from(base.verifiedRuntimeManifestSha256, "hex").copy(envelope, 128);
  Buffer.from(base.verifiedPublicKeySpkiSha256, "hex").copy(envelope, 160);
  Buffer.from(base.verifiedDownloadReceiptSha256, "hex").copy(envelope, 192);
  Buffer.from(base.verifiedInstalledTreeAttestationSha256, "hex").copy(envelope, 224);
  Buffer.from(base.verifiedInstalledTreeReceiptSha256, "hex").copy(envelope, 256);
  const caller = {
    workerPublicKeySpkiSha256: base.verifiedPublicKeySpkiSha256,
    clientCertificateSha256: base.verifiedClientCertificateSha256,
    transportTrustAnchorSha256: base.verifiedTransportTrustAnchorSha256,
    tlsExporterSha256,
  };
  const pin = bootstrap.protectedAdmissionSignerPin;
  if (!pin) throw new Error("protected signer pin missing");
  const command: FinalizeRemoteWorkerBootstrapAdmissionCommand = {
    ...base,
    verifiedProtectedAdmissionEvidence: {
      schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_SCHEMA_VERSION,
      operationIdBase64Url: operationId.toString("base64url"),
      evidenceNonceSha256: nonce.nonceSha256,
      workerGeneration: bootstrap.targetWorkerGeneration,
      envelopeSha256: DBytes(envelope),
      envelopeBase64Url: envelope.toString("base64url"),
      keysetReceiptSha256: pin.keysetReceiptSha256,
      signerSpkiSha256: pin.signerSpkiSha256,
      signerSpkiBase64Url: pin.signerSpkiBase64Url,
      signatureBase64Url: Buffer.alloc(64, 0x33).toString("base64url"),
      contextSha256,
      runtimeManifestSha256: base.verifiedRuntimeManifestSha256,
      runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
      workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
      capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
      ...caller,
      workerPublicKeySpkiBase64Url: admittedWorkerSpki.toString("base64url"),
      authenticatedRemoteCallerBindingSha256: remoteWorkerProtectedAdmissionRemoteCallerBindingSha256(caller),
      downloadVerificationReceiptSha256: base.verifiedDownloadReceiptSha256,
      installedTreeAttestationSha256: base.verifiedInstalledTreeAttestationSha256,
      installedTreeVerificationReceiptSha256: base.verifiedInstalledTreeReceiptSha256,
    },
  };
  return { nonce, command };
}

function seedProtectedFenceHarness(setupDb: PostgresSyncDatabaseClient, suffix: string) {
  const tasks = new TaskRepository(setupDb);
  const durableRuns = new DurableRunRepository(setupDb);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(setupDb);
  const meshNodeAdmissions = new RemoteWorkerMeshNodeAdmissionRepository(setupDb);
  const capabilityAdmissions = new MeshCapabilityNodeAdmissionRepository(setupDb);
  const assignments = new RemoteWorkerAssignmentRepository(setupDb);
  const bootstrap = workerAdmissions.createBootstrap(protectedBootstrapInput(suffix)).record;
  const finalizeInput = protectedFinalizeInput(setupDb, bootstrap, suffix, "first");
  const finalized = workerAdmissions.finalizeBootstrapAdmissionWithNonce(finalizeInput);
  const evidence = finalizeInput.command.verifiedProtectedAdmissionEvidence;
  assert.ok(evidence);
  const joinAuthorityInput = {
    registryWorkspaceId: finalized.generation.registryWorkspaceId,
    bootstrapId: finalized.generation.bootstrapId,
    workerId: finalized.generation.workerId,
    workerGeneration: finalized.generation.workerGeneration,
    nodeId: finalized.generation.nodeId,
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
    protectedAdmissionContextSha256: evidence.contextSha256,
    workspaceId: "default",
    // Must expire BEFORE the backing 600s runtime credential: the M2 fence
    // selector requires the credential to outlive the issued join authority.
    expiresInSeconds: 300,
    issuedByActorId: "operator-a",
  } as const;
  const rawMeshNodeCredential = "a".repeat(43);
  const issued = meshNodeAdmissions.issueJoinAuthority({
    ...joinAuthorityInput,
    idempotencyKey: `${suffix}:mesh-authority:1`,
    rawMeshNodeCredential,
  });
  assert.equal(issued.disposition, "created");
  const admissionCommand = {
    workspaceId: "default",
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    method: "POST" as const,
    rawPath: "/api/v1/remote-workers/mesh-node-admissions",
    operation: "mesh.node.admit",
  } as const;
  const admitted = meshNodeAdmissions.admitWithNonce({
    nonce: protectedCredentialNonce(setupDb, finalized.credential, `${suffix}:admit:1`),
    command: {
      ...admissionCommand,
      rawMeshNodeCredential,
      protocolBodySha256: D(`${suffix}:admission-body:1`),
      transportReceiptSha256: D(`${suffix}:admission-transport:1`),
      proofOfPossessionReceiptSha256: D(`${suffix}:admission-pop:1`),
      tlsExporterSha256: D(`${suffix}:admission-exporter:1`),
      idempotencyKey: `${suffix}:mesh-admission:1`,
    },
  });
  assert.equal(admitted.disposition, "admitted");
  const credentialResolutionInput = {
    registryWorkspaceId: finalized.generation.registryWorkspaceId,
    bootstrapId: finalized.generation.bootstrapId,
    workerId: finalized.generation.workerId,
    workerGeneration: finalized.generation.workerGeneration,
    nodeId: finalized.generation.nodeId,
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
    protectedAdmissionContextSha256: evidence.contextSha256,
    workspaceId: "default",
  } as const;
  const meshFence = meshNodeAdmissions.resolveCurrentForRuntimeCredential({
    ...credentialResolutionInput,
    credentialId: finalized.credential.credentialId,
    credentialGeneration: finalized.credential.credentialGeneration,
    authorizationCredentialSha256: finalizeInput.command.credentialTokenSha256,
  });
  assert.ok(meshFence);
  const claimAuthority = {
    registryWorkspaceId: finalized.generation.registryWorkspaceId,
    bootstrapId: finalized.generation.bootstrapId,
    workerId: finalized.generation.workerId,
    workerGeneration: finalized.generation.workerGeneration,
    credentialId: finalized.credential.credentialId,
    credentialGeneration: finalized.credential.credentialGeneration,
    authorizationCredentialSha256: finalizeInput.command.credentialTokenSha256,
    nodeId: finalized.generation.nodeId,
    clientCertificateSha256: finalized.generation.clientCertificateSha256,
    runtimeManifestSha256: finalized.generation.runtimeManifestSha256,
    workspaceCeilingSha256: finalized.generation.workspaceCeilingSha256,
    capabilityCeilingSha256: finalized.generation.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: evidence.envelopeSha256,
    protectedAdmissionContextSha256: evidence.contextSha256,
    claimsSha256: finalized.credential.claimsSha256,
  } as const;
  const fence: RemoteWorkerAssignmentProtectedCommitFence = {
    credentialAuthority: claimAuthority,
    meshAdmission: meshFence,
  };
  return {
    tasks,
    durableRuns,
    workerAdmissions,
    meshNodeAdmissions,
    capabilityAdmissions,
    assignments,
    bootstrap,
    finalizeInput,
    finalized,
    evidence,
    joinAuthorityInput,
    admissionCommand,
    credentialResolutionInput,
    issued,
    admitted,
    meshFence,
    claimAuthority,
    fence,
  };
}

function seedFencedAssignment(
  h: ReturnType<typeof seedProtectedFenceHarness>,
  suffix: string,
  label: string,
  nodeAdmissionGeneration: number,
  leaseTokenSha256: string,
): { assignmentId: string; taskId: string; durableRunId: string } {
  const now = h.durableRuns.readDatabaseNow();
  const taskId = `task-${suffix}-${label}`;
  const durableRunId = `run-${suffix}-${label}`;
  h.tasks.create({ title: `PG fence contention ${label}`, workspaceId: "default" }, now, { taskId });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId } as const;
  const parentContext = buildRemoteWorkerAssignmentParentContext(parentInput);
  const parentContextSha256 = remoteWorkerAssignmentParentContextSha256(parentInput);
  h.durableRuns.createRun({
    runId: durableRunId,
    workflowKey: "chat.turn.execute",
    status: "running",
    attemptCount: 1,
    maxAttempts: 3,
    leaseOwnerId: "gateway-a",
    leaseHeartbeatAt: now,
    leaseExpiresAt: FUTURE,
    version: 1,
    startedAt: now,
    now,
    metadata: {
      remoteWorkerAssignmentParentContext: parentContext,
      remoteWorkerAssignmentParentContextSha256: parentContextSha256,
    },
  });
  const manifest: RemoteWorkerAssignmentManifest = {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    registryWorkspaceId: "default",
    ...parentInput,
    capabilityProfileSha256: D(`${suffix}:${label}:capability-profile`),
    contextSnapshotSha256: D(`${suffix}:${label}:context`),
    toolEffectPostureSha256: D(`${suffix}:${label}:posture`),
    pathJailSha256: D(`${suffix}:${label}:jail`),
    parentContextSha256,
    requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
    deadlineAt: FUTURE,
    leaseTtlSeconds: 60,
    maxEventCount: 100,
    maxEventBytes: 4_096,
    eventLowWatermark: 2,
    eventHighWatermark: 5,
    maxOutputBytes: 131_072,
    maxArtifactBytes: 1_048_576,
  };
  const assignment = h.assignments.createAssignment({
    manifest,
    createdByActorId: "gateway-a",
    idempotencyKey: `${suffix}:${label}:assignment`,
  }).assignment;
  const started = h.assignments.startGeneration({
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: h.finalized.generation.workerId,
    workerGeneration: h.finalized.generation.workerGeneration,
    nodeId: h.finalized.generation.nodeId,
    nodeAdmissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256,
    idempotencyKey: `${suffix}:${label}:generation:1`,
  });
  assert.equal(started.disposition, "started");
  return { assignmentId: assignment.assignmentId, taskId, durableRunId };
}

interface FencedRepositoryWorkerRequest {
  readonly repositoryModule: "remote-worker-assignment-repo" | "remote-worker-mesh-node-admission-repo";
  readonly repositoryExport: "RemoteWorkerAssignmentRepository" | "RemoteWorkerMeshNodeAdmissionRepository";
  readonly operation: string;
  readonly args: readonly unknown[];
}

interface FencedRepositoryWorker {
  ready: Promise<void>;
  result: Promise<WorkerResult>;
}

function runFencedRepositoryWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  request: FencedRepositoryWorkerRequest,
): FencedRepositoryWorker {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(FENCED_REPOSITORY_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: {
        connectionString,
        database,
        applicationName,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      repositoryExport: request.repositoryExport,
      operation: request.operation,
      args: request.args,
      repositoryModuleUrl: new URL(`./${request.repositoryModule}${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let readyReceived = false;
  let resultReceived = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: WorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: WorkerMessage) => {
    if (message.kind === "ready") {
      readyReceived = true;
      resolveReady();
      return;
    }
    resultReceived = true;
    if (!readyReceived) rejectReady(new Error("M3 fenced repository worker reported before its ready barrier"));
    resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    const error = new Error(`M3 fenced repository worker exited before reporting (${code})`);
    if (!readyReceived) rejectReady(error);
    if (!resultReceived) rejectResult(error);
  });
  return { ready, result };
}

const FENCED_REPOSITORY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    let result;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const repositoryModule = await tsImport(workerData.repositoryModuleUrl, workerData.repositoryModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(
        workerData.postgresModuleUrl,
        workerData.postgresModuleUrl,
      );
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      const repository = new repositoryModule[workerData.repositoryExport](db);
      parentPort.postMessage({ kind: "ready" });
      const value = repository[workerData.operation](...workerData.args);
      result = { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "opaque fenced repository failure" };
    } finally {
      if (db) db.close();
    }
    parentPort.postMessage({ kind: "result", result });
  })();
`;

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerCellProfile,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { CHANGE_PLAN_PACK_POSTGRES_SQL } from "./change-plan-schema.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { assertProvisioningLeaseAuthority } from "./remote-worker-cell-provisioning-test-helpers.js";
import { assertCanonicalProvisioningCheckpoints } from "./remote-worker-cell-checkpoint-test-helpers.js";
import { RemoteWorkerCellRepository } from "./remote-worker-cell-repo.js";
import { NATIVE_WORKER_CELL_POSTGRES_SQL } from "./remote-worker-native-cell-migration.js";
import { TaskRepository } from "./task-repo.js";

// HX-505 live-PostgreSQL execution-cell-owner proof. Follows the repo's
// `.postgres.test.ts` convention: it skips with a visible reason when
// GOATCITADEL_TEST_POSTGRES_URL is unset; the hermetic native cluster provisions
// it and runs with the URL set, where an unset URL is a HOLD, not a skip.
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

for (const lineage of ["bootstrap", "owned"] as const) {
  postgresIt(`upgrades ${lineage} plan/cell constraints without losing rows or unrelated checks`, async () => {
    const pool = new Pool({ connectionString: postgresConnectionString, max: 1 });
    const client = await pool.connect();
    const schema = `cell_forward_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
      await client.query(`
        CREATE TABLE change_plans (kind TEXT NOT NULL ${
          lineage === "owned"
            ? `CHECK(kind IN (
          'session_model', 'installation_default_model', 'provider_connection', 'runtime_configuration',
          'channel_connection', 'runtime_remediation', 'capability_candidate', 'improvement_candidate',
          'managed_source_registration', 'product_source_update'))`
            : ""
        });
        INSERT INTO change_plans VALUES ('session_model');
        CREATE TABLE remote_worker_cells (
          backend TEXT NOT NULL ${lineage === "owned" ? "CHECK(backend = 'container')" : ""},
          platform_identity_sha256 TEXT, container_name TEXT, image_digest TEXT, network_name TEXT,
          keep_guard INTEGER CHECK(keep_guard > 0)
          ${
            lineage === "bootstrap"
              ? ", native_platform_json TEXT"
              : `,
            CHECK((platform_identity_sha256 IS NULL) = (container_name IS NULL)),
            CHECK((platform_identity_sha256 IS NULL) = (image_digest IS NULL)),
            CHECK((platform_identity_sha256 IS NULL) = (network_name IS NULL))`
          }
        );
        INSERT INTO remote_worker_cells (backend, keep_guard) VALUES ('container', 1);
      `);
      await client.query(CHANGE_PLAN_PACK_POSTGRES_SQL);
      await client.query(NATIVE_WORKER_CELL_POSTGRES_SQL);
      assert.equal((await client.query("SELECT kind FROM change_plans")).rows[0].kind, "session_model");
      assert.equal((await client.query("SELECT backend FROM remote_worker_cells")).rows[0].backend, "container");
      await client.query("INSERT INTO change_plans VALUES ('capability_pack')");
      await assert.rejects(client.query("INSERT INTO change_plans VALUES ('unreviewed_writer')"), /check constraint/u);
      await client.query(`INSERT INTO remote_worker_cells (backend, keep_guard, platform_identity_sha256, native_platform_json)
        VALUES ('windows_native', 1, 'identity', '{"job":"bound"}')`);
      await assert.rejects(client.query("UPDATE remote_worker_cells SET keep_guard = 0"), /check constraint/u);
      await assert.rejects(
        client.query("UPDATE remote_worker_cells SET native_platform_json = '{}' WHERE backend = 'windows_native'"),
        /immutable/u,
      );
      await assert.rejects(
        client.query("INSERT INTO remote_worker_cells (backend, native_platform_json) VALUES ('container', '{}')"),
        /check constraint/u,
      );
      await assert.rejects(
        client.query("INSERT INTO remote_worker_cells (backend, native_platform_json) VALUES ('windows_native', '[]')"),
        /check constraint/u,
      );
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      client.release();
      await pool.end();
    }
  });
}

interface SeededCell {
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  profile: RemoteWorkerCellProfile;
}

function seedCell(db: PostgresSyncDatabaseClient, seed: string): SeededCell {
  const tasks = new TaskRepository(db);
  const sessions = new ChatSessionMetaRepository(db);
  const turns = new ChatTurnTraceRepository(db);
  const durableRuns = new DurableRunRepository(db);
  const mesh = new MeshRepository(db);
  const nodeAdmissions = new MeshCapabilityNodeAdmissionRepository(db);
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${seed}`;
  const sessionId = `session-${seed}`;
  const turnId = `turn-${seed}`;
  const durableRunId = `run-${seed}`;

  tasks.create({ title: `Assignment ${seed}`, workspaceId: "default" }, now, { taskId });
  sessions.ensure(sessionId, now, "default");
  turns.create({
    turnId,
    sessionId,
    userMessageId: `message-${seed}`,
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const parentInput = { executionWorkspaceId: "default", durableRunId, taskId, sessionId, turnId } as const;
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

  const runtimePayload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${seed}:bundle`),
    dependencyLockSha256: D(`${seed}:lock`),
    vendorTreeSha256: D(`${seed}:vendor`),
    launcherSha256: D(`${seed}:launcher`),
    installedTreeManifestSha256: D(`${seed}:tree`),
    installedTreeFileCount: 12,
    platform: "linux" as const,
    architecture: "x64" as const,
  };
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: {
      payload: runtimePayload,
      payloadSha256: D(canonicalJsonString(runtimePayload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: `release-key-${seed}`,
      signatureBase64Url: "A".repeat(86),
    },
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: D(`${seed}:bootstrap-secret`),
  }).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission({
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
    verifiedTransportTrustAnchorSha256: D(`${seed}:trust-anchor`),
    verifiedTransportReceiptSha256: D(`${seed}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${seed}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${seed}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seed}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${seed}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${seed}:credential-token`),
    exchangeIdempotencyKey: `exchange:${seed}`,
  });
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
  const nodeAdmission = nodeAdmissions.admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: joinTokenSha256!,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `node-admission:${seed}`,
  });
  const assignment = assignments.createAssignment({
    manifest: {
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
      maxOutputBytes: 65_536,
      maxArtifactBytes: 1_048_576,
    },
    createdByActorId: "gateway-a",
    idempotencyKey: `assignment:${seed}`,
  }).assignment;
  const generation = assignments.startGeneration({
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256: D(`${seed}:lease:1`),
    idempotencyKey: `generation:${seed}:1`,
  }).generation;

  const profile: RemoteWorkerCellProfile = {
    schemaVersion: REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    cellId: `cell-${seed}`,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    backend: "container",
    logicalRootSha256: D(`${seed}:root`),
    assignmentManifestSha256: D(`${seed}:manifest`),
    pathJailSha256: D(`${seed}:jail`),
    capabilityProfileSha256: D(`${seed}:capability`),
    contextSnapshotSha256: D(`${seed}:context`),
    toolEffectPostureSha256: D(`${seed}:posture`),
    runtimeAttestationSha256: D(`${seed}:runtime`),
    launcherAttestationSha256: D(`${seed}:launcher`),
    capacity: {
      schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
      logicalDiskBytes: 1_000_000,
      allocatedDiskBytes: 4_000_000,
      fileLimit: 10_000,
      inodeLimit: 20_000,
      processLimit: 128,
      cpuLimitMilli: 2_000,
      wallLimitMs: 900_000,
      memoryLimitBytes: 2_000_000_000,
      rawOutputLimitBytes: 8_388_608,
      diagnosticLimitBytes: 65_536,
      artifactCeilingBytes: 67_108_864,
      backupStagingBytes: 33_554_432,
      backupPublicationBytes: 33_554_432,
    },
    egressPosture: "allowlisted",
    egressPolicySha256: D(`${seed}:egress`),
    egressDnsRevision: 4,
    envAllowlistSha256: D(`${seed}:env`),
  };

  return {
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    profile,
  };
}

describe("RemoteWorkerCellRepository live PostgreSQL (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "races two connections on the provisioning claim, enforces immutable profile, monotonic CAS, and append-only evidence",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx505_${suffix}`;
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
        applicationName: `hx505-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        setupDb.exec(`SET search_path TO ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        await assertCanonicalProvisioningCheckpoints(setupDb, seedCell(setupDb, "canonical-checkpoints").profile);
        const leaseCell = seedCell(setupDb, "lease-authority");
        new RemoteWorkerCellRepository(setupDb).profileOrReplay({
          profile: leaseCell.profile,
          idempotencyKey: "cell:lease-authority",
          createdAt: new DurableRunRepository(setupDb).readDatabaseNow(),
        });
        await assertProvisioningLeaseAuthority(setupDb, leaseCell, {
          schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
          backend: "container",
          containerName: "gc-cell-lease-authority",
          containerLabelSha256: D("lease-label"),
          imageDigest: `sha256:${"b".repeat(64)}`,
          networkName: "gc-cell-lease-net",
        });
        const cell = seedCell(setupDb, "race");
        const repo = new RemoteWorkerCellRepository(setupDb);
        const now = new DurableRunRepository(setupDb).readDatabaseNow();
        const key = {
          registryWorkspaceId: cell.registryWorkspaceId,
          assignmentId: cell.assignmentId,
          assignmentGeneration: cell.assignmentGeneration,
        };

        repo.profileOrReplay({ profile: cell.profile, idempotencyKey: "cell:idem:1", createdAt: now });
        assert.deepEqual(repo.getCell(key)?.capacity, cell.profile.capacity);

        // A capacity admission computed at revision zero has one commit winner
        // across independent connections. The losing transaction adds no evidence.
        const capacitySignal = new SharedArrayBuffer(4);
        const capacityObservation = {
          ...key,
          expectedCapacityRevision: 0,
          expectedCleanupRevision: 1,
          footprint: {
            schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
            mutableRootBytes: 10,
            inputStagingBytes: 0,
            backupStagingBytes: 0,
            artifactStagingBytes: 0,
            immutableArtifactBytes: 0,
            retainedOutboxBytes: 0,
            databaseSidecarBytes: 0,
            backupPublicationBytes: 0,
            manifestBytes: 0,
            proxySidecarBytes: 0,
            diagnosticBytes: 0,
            failedCleanupBytes: 0,
            quarantineEvidenceBytes: 0,
          },
          peakDiskBytes: 10,
          peakMemoryBytes: 1,
          peakFileCount: 1,
          peakProcessCount: 1,
          rawOutputBytes: 0,
          failedCleanupRetainedBytes: 0,
          quarantineRetainedBytes: 0,
          detailSha256: D("capacity"),
          now,
        } satisfies Parameters<RemoteWorkerCellRepository["recordCapacityHighWater"]>[0];
        const capacityWorkers = [0, 1].map((index) =>
          spawnClaimWorker(
            scopedUrl.toString(),
            database,
            `hx505-capacity-${index}-${suffix}`,
            schemaName,
            {
              ...capacityObservation,
              detailSha256: D(`capacity:${index}`),
            },
            capacitySignal,
            "recordCapacityHighWater",
          ),
        );
        await Promise.all(capacityWorkers.map((worker) => worker.ready));
        Atomics.store(new Int32Array(capacitySignal), 0, 1);
        Atomics.notify(new Int32Array(capacitySignal), 0);
        const capacityResults = await Promise.all(capacityWorkers.map((worker) => worker.result));
        assert.equal(capacityResults.filter((result) => result.ok).length, 1, JSON.stringify(capacityResults));
        const refusedCapacity = capacityResults.find((result) => !result.ok);
        assert.ok(refusedCapacity && !refusedCapacity.ok && /capacity revision/iu.test(refusedCapacity.error));
        assert.equal(repo.getCell(key)?.capacityRevision, 1);
        assert.equal(repo.listEvidenceAfter(key, 0).filter((row) => row.domain === "capacity").length, 1);
        console.log(`HX-505 PG capacity revision race observed: ${JSON.stringify(capacityResults)}`);

        // --- Two-connection provisioning-claim race -> exactly one winner ---
        const startSignal = new SharedArrayBuffer(4);
        const workers = ["owner-a", "owner-b"].map((owner, index) =>
          spawnClaimWorker(
            scopedUrl.toString(),
            database,
            `hx505-claim-${index}-${suffix}`,
            schemaName,
            { ...key, provisioningOwner: owner, leaseExpiresAt: FUTURE, detailSha256: D(`claim:${owner}`), now },
            startSignal,
          ),
        );
        await Promise.all(workers.map((worker) => worker.ready));
        const startState = new Int32Array(startSignal);
        Atomics.store(startState, 0, 1);
        Atomics.notify(startState, 0);
        const results = await Promise.all(workers.map((worker) => worker.result));
        console.log(`HX-505 PG provisioning-claim race observed: ${JSON.stringify(results)}`);
        const succeeded = results.filter((result): result is { ok: true; claimed: boolean } => result.ok === true);
        assert.equal(succeeded.length, 2, `both claimants must return without error: ${JSON.stringify(results)}`);
        assert.equal(
          succeeded.filter((result) => result.claimed).length,
          1,
          `exactly one connection may win the provisioning claim: ${JSON.stringify(results)}`,
        );
        const claimed = repo.getCell(key);
        assert.equal(claimed?.executionState, "provisioning");
        assert.ok(claimed?.provisioningOwner === "owner-a" || claimed?.provisioningOwner === "owner-b");
        const owner = claimed!.provisioningOwner!;

        // --- Drive forward and prove immutable profile + monotonic CAS on the live cluster ---
        repo.persistPlatformIdentity({
          ...key,
          provisioningOwner: owner,
          provisioningLeaseExpiresAt: claimed!.provisioningLeaseExpiresAt!,
          platformIdentity: {
            schemaVersion: REMOTE_WORKER_CELL_PLATFORM_SCHEMA_VERSION,
            backend: "container",
            containerName: "gc-cell-race",
            containerLabelSha256: D("label"),
            imageDigest: `sha256:${"b".repeat(64)}`,
            networkName: "gc-cell-net",
          },
          detailSha256: D("plat"),
          now,
        });
        const ready = repo.getCell(key)!;
        repo.transitionExecution({
          ...key,
          expectedRevision: ready.executionRevision,
          toState: "starting",
          detailSha256: D("start"),
          now,
        });
        const starting = repo.getCell(key)!;
        const running = repo.transitionExecution({
          ...key,
          expectedRevision: starting.executionRevision,
          toState: "running",
          detailSha256: D("run"),
          now,
        });
        assert.equal(running.executionState, "running");

        assert.throws(
          () =>
            setupDb
              .prepare("UPDATE remote_worker_cells SET allocated_disk_bytes = 9000000 WHERE cell_id = 'cell-race'")
              .run(),
          /immutable/u,
        );
        assert.throws(
          () =>
            setupDb
              .prepare(
                "UPDATE remote_worker_cells SET execution_state = 'ready', execution_revision = 99 WHERE cell_id = 'cell-race'",
              )
              .run(),
          /monotonically|immutable/u,
        );
        assert.throws(
          () =>
            setupDb
              .prepare("UPDATE remote_worker_cell_evidence SET domain = 'capacity' WHERE evidence_sequence = 1")
              .run(),
          /append-only/u,
        );
        assert.throws(
          () => setupDb.prepare("DELETE FROM remote_worker_cell_evidence WHERE evidence_sequence = 1").run(),
          /append-only/u,
        );

        // --- Finalize and prove high-water monotonicity + verified-clean removal fence ---
        const exited = repo.finalizeDiagnostics({
          ...key,
          expectedRevision: running.executionRevision,
          toState: "exited",
          exitCode: 0,
          terminatedBySignal: null,
          diagnosticCaptureSha256: D("capture"),
          rawOutputBytes: 4_096,
          retainedDiagnosticBytes: 256,
          detailSha256: D("exit"),
          now,
        });
        assert.equal(exited.executionState, "exited");
        assert.throws(
          () =>
            setupDb.prepare("UPDATE remote_worker_cells SET raw_output_bytes = 0 WHERE cell_id = 'cell-race'").run(),
          /cannot regress/u,
        );
        assert.throws(
          () => setupDb.prepare("DELETE FROM remote_worker_cells WHERE cell_id = 'cell-race'").run(),
          /verified zero liveness/u,
        );

        const evidence = repo.listEvidenceAfter(key, 0);
        assert.deepEqual(
          evidence.map((entry) => entry.evidenceSequence),
          [1, 2, 3, 4, 5, 6],
        );

        // Pause cleanup after its snapshot read. A second connection commits a
        // capacity update, so the stale cleanup must fail without adding evidence.
        const cleanupSignal = new SharedArrayBuffer(4);
        const cleanupInput = {
          ...key,
          expectedRevision: 1,
          toState: "pending" as const,
          failedCleanupRetainedBytes: 25,
          detailSha256: D("cleanup-race"),
          now,
        };
        const cleanupWorker = spawnClaimWorker(
          scopedUrl.toString(),
          database,
          `hx505-cleanup-${suffix}`,
          schemaName,
          cleanupInput,
          cleanupSignal,
          "transitionCleanup",
          true,
        );
        try {
          await cleanupWorker.ready;
          repo.recordCapacityHighWater({
            ...capacityObservation,
            expectedCapacityRevision: 1,
            footprint: { ...capacityObservation.footprint, failedCleanupBytes: 99 },
            peakDiskBytes: 109,
            failedCleanupRetainedBytes: 99,
          });
        } finally {
          Atomics.store(new Int32Array(cleanupSignal), 0, 1);
          Atomics.notify(new Int32Array(cleanupSignal), 0);
        }
        const cleanupResult = await cleanupWorker.result;
        assert.ok(!cleanupResult.ok && /capacity revision/iu.test(cleanupResult.error), JSON.stringify(cleanupResult));
        assert.equal(repo.getCell(key)?.cleanupRevision, 1);
        assert.equal(repo.getCell(key)?.failedCleanupRetainedBytes, 99);
        assert.equal(repo.listEvidenceAfter(key, 0).filter((row) => row.domain === "cleanup").length, 0);
        const cleaned = repo.transitionCleanup(cleanupInput);
        assert.equal(cleaned.cleanupRevision, 2);
        assert.equal(cleaned.failedCleanupRetainedBytes, 99);
        assert.throws(
          () =>
            repo.recordCapacityHighWater({
              ...capacityObservation,
              expectedCapacityRevision: 2,
            }),
          /cleanup revision/iu,
        );
        assert.equal(repo.getCell(key)?.capacityRevision, 2);
        assert.equal(repo.listEvidenceAfter(key, 0).filter((row) => row.domain === "capacity").length, 2);
        console.log(`HX-505 PG cleanup/capacity interleaving observed: ${JSON.stringify(cleanupResult)}`);
      } finally {
        setupDb.close();
        await migrations.close().catch(() => undefined);
        await scopedPool.end().catch(() => undefined);
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await adminPool.end().catch(() => undefined);
      }
    },
  );
});

type ClaimWorkerResult = { ok: true; claimed: boolean } | { ok: false; error: string };

function spawnClaimWorker(
  connectionString: string,
  database: string,
  applicationName: string,
  schemaName: string,
  input: Record<string, unknown>,
  startSignal: SharedArrayBuffer,
  operation: "claimProvisioning" | "recordCapacityHighWater" | "transitionCleanup" = "claimProvisioning",
  pauseBeforeUpdate = false,
): { ready: Promise<void>; result: Promise<ClaimWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(CLAIM_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: { connectionString, database, applicationName, pool: { max: 1, connectionTimeoutMs: 10_000 } },
      input,
      schemaName,
      startSignal,
      operation,
      pauseBeforeUpdate,
      repositoryModuleUrl: new URL(`./remote-worker-cell-repo${extension}`, import.meta.url).href,
      postgresModuleUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (result: ClaimWorkerResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<ClaimWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: ClaimWorkerResult }) => {
    if (message.kind === "ready") resolveReady();
    else {
      resolveResult(message.result);
      if (!message.result.ok) rejectReady(new Error(message.result.error));
    }
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`HX-505 PostgreSQL claim worker exited with code ${code}.`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const CLAIM_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { RemoteWorkerCellRepository } = await tsImport(workerData.repositoryModuleUrl, workerData.repositoryModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(workerData.postgresModuleUrl, workerData.postgresModuleUrl);
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.exec("SET search_path TO " + workerData.schemaName);
      const startState = new Int32Array(workerData.startSignal);
      const waitForStart = () => {
        parentPort.postMessage({ kind: "ready" });
        if (Atomics.wait(startState, 0, 0, 30_000) === "timed-out")
          throw new Error("HX-505 PostgreSQL interleaving barrier timed out.");
      };
      if (workerData.pauseBeforeUpdate) {
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const statement = prepare(sql);
          if (/^\s*UPDATE remote_worker_cells/u.test(sql)) waitForStart();
          return statement;
        };
      } else {
        waitForStart();
      }
      try {
        const repository = new RemoteWorkerCellRepository(db);
        const claimed = workerData.operation === "recordCapacityHighWater"
          ? repository.recordCapacityHighWater(workerData.input)
          : workerData.operation === "transitionCleanup"
            ? repository.transitionCleanup(workerData.input)
            : repository.claimProvisioning(workerData.input);
        parentPort.postMessage({ kind: "result", result: { ok: true, claimed: claimed !== undefined } });
      } catch (error) {
        parentPort.postMessage({
          kind: "result",
          result: { ok: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
    } catch (error) {
      parentPort.postMessage({
        kind: "result",
        result: { ok: false, error: "worker bootstrap failed: " + (error instanceof Error ? error.message : String(error)) },
      });
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  })();
`;

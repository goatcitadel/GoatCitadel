import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type CreateRemoteWorkerBootstrapCommand,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerAssignmentEventInput,
  type RemoteWorkerAssignmentManifest,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { DurableRunRepository } from "./durable-run-repo.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { RemoteWorkerAdmissionRepository } from "./remote-worker-admission-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { TaskRepository } from "./task-repo.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
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
    assignments,
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

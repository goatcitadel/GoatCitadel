import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceRequestSubmission,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
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
import { RemoteWorkerInferenceRepository } from "./remote-worker-inference-repo.js";
import { TaskRepository } from "./task-repo.js";

// HX-503 live-PostgreSQL inference-owner proof. Follows the repo's
// `.postgres.test.ts` convention: it skips with a visible reason when
// GOATCITADEL_TEST_POSTGRES_URL is unset; the named lane provisions a hermetic
// cluster and runs it with the URL set, where an unset URL is a HOLD, not an
// accepted skip.
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

interface SeededAuthority {
  assignmentId: string;
  assignmentGeneration: number;
  workerId: string;
  workerGeneration: number;
  sessionId: string;
  turnId: string;
}

function seedAuthority(db: PostgresSyncDatabaseClient, seed: string): SeededAuthority {
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

  return {
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    sessionId,
    turnId,
  };
}

function submissionFor(a: SeededAuthority): RemoteWorkerInferenceRequestSubmission {
  return {
    registryWorkspaceId: "default",
    assignmentId: a.assignmentId,
    assignmentGeneration: a.assignmentGeneration,
    inferenceRequestId: "inference-1",
    attempt: 1,
    idempotencyKey: "inference:idem:1",
    leaseToken: "seed:lease:1",
    messages: [{ role: "user", text: "Hello." }],
    inputSha256: D("input"),
    contextSha256: D("context"),
    modelIntentSha256: D("intent"),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    temperatureMilli: 700,
  };
}

function governanceReceipt(): RemoteWorkerInferenceGovernanceReceipt {
  return {
    schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
    decision: "allowed",
    effectiveRouteSha256: D("route"),
    policyRevision: 4,
    policySha256: D("policy"),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    expiresAt: FUTURE,
  };
}

function keyFor(a: SeededAuthority) {
  return {
    registryWorkspaceId: "default",
    assignmentId: a.assignmentId,
    assignmentGeneration: a.assignmentGeneration,
    inferenceRequestId: "inference-1",
    attempt: 1,
  };
}

describe("RemoteWorkerInferenceRepository live PostgreSQL (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "races two connections on the dispatch claim, enforces immutable terminal and append-only frames, and replays the durable outbox",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx503_${suffix}`;
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
        applicationName: `hx503-setup-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        setupDb.exec(`SET search_path TO ${schemaName}`);
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
        const authority = seedAuthority(setupDb, "race");
        const repo = new RemoteWorkerInferenceRepository(setupDb);
        const now = new DurableRunRepository(setupDb).readDatabaseNow();

        repo.admitOrReplay({
          submission: submissionFor(authority),
          workerId: authority.workerId,
          workerGeneration: authority.workerGeneration,
          sessionId: authority.sessionId,
          turnId: authority.turnId,
          capabilityProfileSha256: D("capability-profile"),
          routedContextSha256: D("routed-context"),
          operationId: "operation-1",
          dispatchGeneration: "dispatch-generation-1",
          governance: governanceReceipt(),
          budgetReservationId: "reservation-1",
          admittedAt: now,
        });

        // --- Two-connection dispatch-claim race -> exactly one winner ---
        const startSignal = new SharedArrayBuffer(4);
        const workers = ["owner-a", "owner-b"].map((owner, index) =>
          spawnClaimWorker(
            scopedUrl.toString(),
            database,
            `hx503-claim-${index}-${suffix}`,
            schemaName,
            {
              ...keyFor(authority),
              dispatchClaimOwner: owner,
              effectiveProviderId: "anthropic",
              effectiveModelId: "claude-opus-4",
              usageIntentEventId: `usage-intent-${owner}`,
              dispatchLeaseExpiresAt: FUTURE,
              now,
            },
            startSignal,
          ),
        );
        await Promise.all(workers.map((worker) => worker.ready));
        const startState = new Int32Array(startSignal);
        Atomics.store(startState, 0, 1);
        Atomics.notify(startState, 0);
        const results = await Promise.all(workers.map((worker) => worker.result));
        console.log(`HX-503 PG claim race observed: ${JSON.stringify(results)}`);
        const succeeded = results.filter((result): result is { ok: true; claimed: boolean } => result.ok === true);
        assert.equal(succeeded.length, 2, `both claimants must return without error: ${JSON.stringify(results)}`);
        assert.equal(
          succeeded.filter((result) => result.claimed).length,
          1,
          `exactly one connection may win the dispatch claim: ${JSON.stringify(results)}`,
        );
        const claimed = repo.getRequest(keyFor(authority));
        assert.equal(claimed?.state, "dispatch_claimed");
        assert.ok(claimed?.dispatchClaimOwner === "owner-a" || claimed?.dispatchClaimOwner === "owner-b");
        const winner = claimed!.dispatchClaimOwner!;

        // --- Stream, finalize, and prove immutable terminal on the live cluster ---
        repo.appendOutputFrame({ ...keyFor(authority), dispatchClaimOwner: winner, text: "Hello ", now });
        repo.appendOutputFrame({ ...keyFor(authority), dispatchClaimOwner: winner, text: "world", now });
        const finalized = repo.finalizeTerminal({
          ...keyFor(authority),
          dispatchClaimOwner: winner,
          terminalState: "completed",
          usageTerminalEventId: "usage-terminal-1",
          now,
        });
        assert.equal(finalized.state, "completed");
        assert.equal(finalized.terminalFrameSequence, 3);
        assert.equal(finalized.accountingDisposition, "settled");

        assert.throws(
          () =>
            setupDb
              .prepare(
                "UPDATE remote_worker_inference_requests SET state = 'failed' WHERE inference_request_id = 'inference-1'",
              )
              .run(),
          /immutable/u,
        );
        assert.throws(
          () =>
            setupDb
              .prepare("UPDATE remote_worker_inference_outbox SET frame_char_count = 9 WHERE frame_sequence = 1")
              .run(),
          /append-only/u,
        );
        assert.throws(
          () => setupDb.prepare("DELETE FROM remote_worker_inference_outbox WHERE frame_sequence = 1").run(),
          /append-only/u,
        );

        // --- Acknowledgement advances; the durable outbox replays after the watermark ---
        repo.acknowledge(keyFor(authority), 1, now);
        assert.throws(
          () =>
            setupDb
              .prepare(
                "UPDATE remote_worker_inference_requests SET worker_acknowledged_through = 0 WHERE inference_request_id = 'inference-1'",
              )
              .run(),
          /regress|immutable/u,
        );
        const restarted = new RemoteWorkerInferenceRepository(setupDb);
        assert.deepEqual(
          restarted.listFramesAfter(keyFor(authority), 1).map((frame) => frame.frameSequence),
          [2, 3],
        );
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
): { ready: Promise<void>; result: Promise<ClaimWorkerResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(CLAIM_WORKER_SOURCE, {
    eval: true,
    workerData: {
      connectionOptions: { connectionString, database, applicationName, pool: { max: 1, connectionTimeoutMs: 10_000 } },
      input,
      schemaName,
      startSignal,
      repositoryModuleUrl: new URL(`./remote-worker-inference-repo${extension}`, import.meta.url).href,
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
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`HX-503 PostgreSQL claim worker exited with code ${code}.`);
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
      const { RemoteWorkerInferenceRepository } = await tsImport(workerData.repositoryModuleUrl, workerData.repositoryModuleUrl);
      const { PostgresSyncDatabaseClient } = await tsImport(workerData.postgresModuleUrl, workerData.postgresModuleUrl);
      db = new PostgresSyncDatabaseClient(workerData.connectionOptions);
      db.exec("SET search_path TO " + workerData.schemaName);
      parentPort.postMessage({ kind: "ready" });
      const startState = new Int32Array(workerData.startSignal);
      Atomics.wait(startState, 0, 0);
      try {
        const claimed = new RemoteWorkerInferenceRepository(db).claimDispatch(workerData.input);
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

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerArtifactManifestSha256,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerArtifactManifest,
} from "@goatcitadel/contracts";
import {
  ChatSessionMetaRepository,
  ChatTurnTraceRepository,
  DurableRunRepository,
  MeshCapabilityNodeAdmissionRepository,
  MeshRepository,
  RemoteWorkerAdmissionRepository,
  RemoteWorkerArtifactRepository,
  RemoteWorkerAssignmentRepository,
  RemoteWorkerEffectRepository,
  TaskRepository,
  createDatabase,
  type DatabaseClient,
} from "@goatcitadel/storage";
import { RemoteWorkerArtifactSettlementService } from "./remote-worker-artifact-settlement-service.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { RemoteWorkerEffectSettlementService } from "./remote-worker-effect-settlement-service.js";
import { RemoteWorkerVerificationService } from "./remote-worker-verification-service.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const DB = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";
const GENESIS = "0".repeat(64);
const signal = new AbortController().signal;
const alwaysLive = { assertLiveAuthority: () => undefined };

let rootDir: string;
let db: DatabaseClient;

beforeEach(() => {
  rootDir = path.join(os.tmpdir(), `hx506-int-${randomUUID()}`);
  fs.mkdirSync(rootDir, { recursive: true });
  db = createDatabase({ dbPath: ":memory:" });
});

afterEach(() => {
  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function seed(s: string) {
  const durableRuns = new DurableRunRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const now = durableRuns.readDatabaseNow();
  new TaskRepository(db).create({ title: `A ${s}`, workspaceId: "default" }, now, { taskId: `task-${s}` });
  new ChatSessionMetaRepository(db).ensure(`session-${s}`, now, "default");
  new ChatTurnTraceRepository(db).create({
    turnId: `turn-${s}`,
    sessionId: `session-${s}`,
    userMessageId: `m-${s}`,
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const parentInput = {
    executionWorkspaceId: "default",
    durableRunId: `run-${s}`,
    taskId: `task-${s}`,
    sessionId: `session-${s}`,
    turnId: `turn-${s}`,
  } as const;
  durableRuns.createRun({
    runId: `run-${s}`,
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
      remoteWorkerAssignmentParentContext: buildRemoteWorkerAssignmentParentContext(parentInput),
      remoteWorkerAssignmentParentContextSha256: remoteWorkerAssignmentParentContextSha256(parentInput),
    },
  });
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const runtimePayload = {
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: D(`${s}:b`),
    dependencyLockSha256: D(`${s}:l`),
    vendorTreeSha256: D(`${s}:v`),
    launcherSha256: D(`${s}:la`),
    installedTreeManifestSha256: D(`${s}:t`),
    installedTreeFileCount: 12,
    platform: "linux" as const,
    architecture: "x64" as const,
  };
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `W ${s}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: {
      payload: runtimePayload,
      payloadSha256: D(canonicalJsonString(runtimePayload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: `k-${s}`,
      signatureBase64Url: "A".repeat(86),
    },
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `boot:${s}`,
    bootstrapSecretSha256: D(`${s}:bs`),
  }).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission({
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${s}:bs`),
    verifiedPublicKeySpkiSha256: D(`${s}:spki`),
    verifiedClientCertificateSha256: D(`${s}:cert`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${s}:ta`),
    verifiedTransportReceiptSha256: D(`${s}:tr`),
    verifiedProofOfPossessionReceiptSha256: D(`${s}:pop`),
    verifiedDownloadReceiptSha256: D(`${s}:dl`),
    verifiedInstalledTreeAttestationSha256: D(`${s}:ita`),
    verifiedInstalledTreeReceiptSha256: D(`${s}:itr`),
    credentialIssuanceProofSha256: D(`${s}:iss`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${s}:ct`),
    exchangeIdempotencyKey: `ex:${s}`,
  });
  const mesh = new MeshRepository(db);
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  mesh.upsertNode({
    nodeId: bootstrap.nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint,
    joinedAt: now,
    lastSeenAt: now,
  });
  mesh.issueJoinToken(`join:${s}`, FUTURE);
  mesh.consumeJoinToken(`join:${s}`, bootstrap.nodeId, now);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, `join:${s}`).tokenHash;
  const nodeAdmission = new MeshCapabilityNodeAdmissionRepository(db).admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: joinTokenSha256!,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `na:${s}`,
  });
  const assignment = assignments.createAssignment({
    manifest: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "default",
      ...parentInput,
      capabilityProfileSha256: D(`${s}:cp`),
      contextSnapshotSha256: D(`${s}:cs`),
      toolEffectPostureSha256: D(`${s}:po`),
      pathJailSha256: D(`${s}:jail`),
      parentContextSha256: remoteWorkerAssignmentParentContextSha256(parentInput),
      requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
      deadlineAt: FUTURE,
      leaseTtlSeconds: 60,
      maxEventCount: 100,
      maxEventBytes: 4096,
      eventLowWatermark: 2,
      eventHighWatermark: 5,
      maxOutputBytes: 65536,
      maxArtifactBytes: 1048576,
    },
    createdByActorId: "gateway-a",
    idempotencyKey: `as:${s}`,
  }).assignment;
  const leaseTokenSha256 = D(`${s}:lease:1`);
  assignments.startGeneration({
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256,
    idempotencyKey: `gen:${s}`,
  });
  return { assignments, assignmentId: assignment.assignmentId, leaseTokenSha256 };
}

async function commitArtifact(
  assignmentId: string,
  requiredVerifier: string | null,
): Promise<{ manifestSha256: string; blobSha256: string }> {
  const artifacts = new RemoteWorkerArtifactRepository(db);
  const store = new RemoteWorkerArtifactStore(rootDir);
  const service = new RemoteWorkerArtifactSettlementService({ repository: artifacts, store, authority: alwaysLive });
  const key = { registryWorkspaceId: "default", assignmentId, assignmentGeneration: 1, leaseTokenSha256: D("lease") };
  const fileBytes = new TextEncoder().encode("artifact-content");
  const blobSha256 = DB(fileBytes);
  const logicalPath = "out/result.bin";
  const opened = service.openUpload({
    ...key,
    uploadAttempt: 1,
    declaredFileCount: 1,
    declaredTotalBytes: fileBytes.byteLength,
    stagingRootSha256: D("staging"),
    expiresAt: FUTURE,
    idempotencyKey: "open",
  });
  service.appendPart({
    ...key,
    uploadId: opened.uploadId,
    part: {
      globalSequence: 1,
      logicalPathSha256: D(canonicalJsonString({ logicalPath })),
      filePartIndex: 0,
      isFinalPart: true,
      partBytes: fileBytes.byteLength,
      partSha256: blobSha256,
    },
    idempotencyKey: "part",
  });
  const manifest: RemoteWorkerArtifactManifest = {
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    identity: opened.identity,
    pathJailSha256: D("jail"),
    workerClaimIds: [],
    workerClaimSha256: D("claims"),
    requiredVerifierProfileSha256: requiredVerifier,
    fileCount: 1,
    totalBytes: fileBytes.byteLength,
    entries: [
      {
        entryIndex: 0,
        logicalPath,
        logicalPathSha256: D(canonicalJsonString({ logicalPath })),
        blobSha256,
        byteCount: fileBytes.byteLength,
        mimeType: "application/octet-stream",
      },
    ],
  };
  await service.commitArtifact({
    ...key,
    uploadId: opened.uploadId,
    manifest,
    files: [
      {
        logicalPath,
        logicalPathSha256: D(canonicalJsonString({ logicalPath })),
        bytes: fileBytes,
        mimeType: "application/octet-stream",
      },
    ],
    idempotencyKey: "commit",
    signal,
  });
  return { manifestSha256: remoteWorkerArtifactManifestSha256(manifest), blobSha256 };
}

function settleInput(assignmentId: string, leaseTokenSha256: string, outputManifestSha256: string) {
  return {
    registryWorkspaceId: "default",
    assignmentId,
    expectedAssignmentGeneration: 1,
    expectedLeaseRevision: 1,
    origin: "worker" as const,
    leaseTokenSha256,
    outcome: "completed" as const,
    finalEventSequence: 0,
    finalEventSha256: GENESIS,
    resultSha256: D("result"),
    outputManifestSha256,
    idempotencyKey: "settle",
  };
}

describe("HX-506 remote worker settlement integration", () => {
  it("commits artifacts, verifies, settles effects, and gates the assignment settlement end to end", async () => {
    const ctx = seed("full");
    const { manifestSha256 } = await commitArtifact(ctx.assignmentId, D("verifier-profile"));

    // The gate is pending until a passed Gateway verification satisfies it.
    expect(() =>
      ctx.assignments.settleAssignment(settleInput(ctx.assignmentId, ctx.leaseTokenSha256, manifestSha256)),
    ).toThrow();

    const verification = new RemoteWorkerVerificationService({
      repository: new RemoteWorkerArtifactRepository(db),
      store: new RemoteWorkerArtifactStore(rootDir),
      verifier: { verify: async () => ({ outcome: "passed", summary: "ok", capturedOutputBytes: 10 }) },
    });
    const verified = await verification.runGatewayVerification({
      registryWorkspaceId: "default",
      assignmentId: ctx.assignmentId,
      assignmentGeneration: 1,
      executionWorkspaceId: "default",
      attemptIndex: 1,
      verifierProfileSha256: D("verifier-profile"),
      manifestSha256,
      blobs: [DB(new TextEncoder().encode("artifact-content"))],
      wallDeadlineAt: FUTURE,
      idempotencyKey: "verify-1",
      signal,
    });
    expect(verified.gateState).toBe("satisfied");

    // Dispatch a remote effect; the coordinator supplies the canonical HX-305 outcome.
    const effects = new RemoteWorkerEffectSettlementService({
      repository: new RemoteWorkerEffectRepository(db),
      coordinator: {
        dispatch: async () => ({
          kind: "completed_with_effect",
          externalSideEffectRunId: "run-1",
          boundaryReceiptSha256: D("boundary"),
          hx305OutcomeSha256: D("hx305"),
        }),
      },
    });
    const dispatched = await effects.dispatchEffect({
      fence: {
        registryWorkspaceId: "default",
        assignmentId: ctx.assignmentId,
        assignmentGeneration: 1,
        sessionControlGeneration: 1,
        leaseTokenSha256: ctx.leaseTokenSha256,
      },
      intentIndex: 0,
      effectSelector: "email.send",
      canonicalArgs: { to: "user@example.com" },
      workerIdempotencyKey: "wk-1",
      intentIdempotencyKey: "intent-1",
    });
    expect(dispatched.receipt.receiptState).toBe("completed_with_effect");

    // The canonical external-side-effect runs table is never touched by HX-506.
    const externalRuns = db.prepare("SELECT COUNT(*) AS count FROM external_side_effect_runs").get() as {
      count: number;
    };
    expect(Number(externalRuns.count)).toBe(0);

    // With a committed manifest, a satisfied gate, and every intent carrying a
    // current receipt, the assignment settlement gate passes.
    expect(
      ctx.assignments.settleAssignment(settleInput(ctx.assignmentId, ctx.leaseTokenSha256, manifestSha256)).disposition,
    ).toBe("settled");
  });

  it("blocks the assignment settlement while an effect receipt is in manual reconciliation", async () => {
    const ctx = seed("manual");
    const { manifestSha256 } = await commitArtifact(ctx.assignmentId, null); // not_required gate

    const effects = new RemoteWorkerEffectSettlementService({
      repository: new RemoteWorkerEffectRepository(db),
      coordinator: {
        dispatch: async () => ({
          kind: "manual_reconciliation",
          externalSideEffectRunId: "run-1",
          boundaryReceiptSha256: null,
          sanitizedError: "disconnected",
        }),
      },
    });
    const dispatched = await effects.dispatchEffect({
      fence: {
        registryWorkspaceId: "default",
        assignmentId: ctx.assignmentId,
        assignmentGeneration: 1,
        sessionControlGeneration: 1,
        leaseTokenSha256: ctx.leaseTokenSha256,
      },
      intentIndex: 0,
      effectSelector: "email.send",
      canonicalArgs: {},
      workerIdempotencyKey: "wk-1",
      intentIdempotencyKey: "intent-1",
    });
    expect(dispatched.receipt.receiptState).toBe("manual_reconciliation");

    // A receipt in manual reconciliation blocks the output-manifest settlement.
    expect(() =>
      ctx.assignments.settleAssignment(settleInput(ctx.assignmentId, ctx.leaseTokenSha256, manifestSha256)),
    ).toThrow();
  });
});

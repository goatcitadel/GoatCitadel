import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  type RemoteWorkerCellCapacityFootprint,
  type RemoteWorkerCellCapacityReservation,
  type RemoteWorkerCellProfile,
} from "@goatcitadel/contracts";
import {
  ChatSessionMetaRepository,
  ChatTurnTraceRepository,
  DurableRunRepository,
  MeshCapabilityNodeAdmissionRepository,
  MeshRepository,
  RemoteWorkerAdmissionRepository,
  RemoteWorkerAssignmentRepository,
  RemoteWorkerCellRepository,
  TaskRepository,
  createDatabase,
  type DatabaseClient,
  type RemoteWorkerCellKey,
} from "@goatcitadel/storage";
import { RemoteWorkerCellService, type WorkerCellAssignmentAuthorityPort } from "./remote-worker-cell-service.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

interface Seeded {
  db: DatabaseClient;
  repo: RemoteWorkerCellRepository;
  key: RemoteWorkerCellKey;
  profile: RemoteWorkerCellProfile;
  now: string;
}

function seed(name: string): Seeded {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  const durableRuns = new DurableRunRepository(db);
  const now = durableRuns.readDatabaseNow();
  const taskId = `task-${name}`;
  const sessionId = `session-${name}`;
  const turnId = `turn-${name}`;
  const durableRunId = `run-${name}`;

  new TaskRepository(db).create({ title: `Assignment ${name}`, workspaceId: "default" }, now, { taskId });
  new ChatSessionMetaRepository(db).ensure(sessionId, now, "default");
  new ChatTurnTraceRepository(db).create({
    turnId,
    sessionId,
    userMessageId: `message-${name}`,
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
    bundleSha256: D(`${name}:bundle`),
    dependencyLockSha256: D(`${name}:lock`),
    vendorTreeSha256: D(`${name}:vendor`),
    launcherSha256: D(`${name}:launcher`),
    installedTreeManifestSha256: D(`${name}:tree`),
    installedTreeFileCount: 12,
    platform: "linux" as const,
    architecture: "x64" as const,
  };
  const workerAdmissions = new RemoteWorkerAdmissionRepository(db);
  const bootstrap = workerAdmissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${name}`,
    platform: "linux",
    architecture: "x64",
    runtimeManifest: {
      payload: runtimePayload,
      payloadSha256: D(canonicalJsonString(runtimePayload)),
      signatureAlgorithm: "ed25519",
      signerKeyId: `release-key-${name}`,
      signatureBase64Url: "A".repeat(86),
    },
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${name}`,
    bootstrapSecretSha256: D(`${name}:bootstrap-secret`),
  }).record;
  const worker = workerAdmissions.finalizeBootstrapAdmission({
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(`${name}:bootstrap-secret`),
    verifiedPublicKeySpkiSha256: D(`${name}:spki`),
    verifiedClientCertificateSha256: D(`${name}:certificate`),
    verifiedRuntimeManifestSha256: D(canonicalJsonString(bootstrap.runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: D(`${name}:trust-anchor`),
    verifiedTransportReceiptSha256: D(`${name}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${name}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${name}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${name}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${name}:tree-receipt`),
    credentialIssuanceProofSha256: D(`${name}:issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(`${name}:credential-token`),
    exchangeIdempotencyKey: `exchange:${name}`,
  });
  const mesh = new MeshRepository(db);
  const tlsFingerprint = `sha256:${bootstrap.nodeId}`;
  const joinToken = `join:${name}`;
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
  mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  const nodeAdmission = new MeshCapabilityNodeAdmissionRepository(db).admit({
    workspaceId: "default",
    nodeId: bootstrap.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: joinTokenSha256!,
    mtlsRequired: true,
    tlsFingerprint,
    admittedByActorId: "operator-a",
    idempotencyKey: `node-admission:${name}`,
  });
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const assignment = assignments.createAssignment({
    manifest: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "default",
      ...parentInput,
      capabilityProfileSha256: D(`${name}:capability-profile`),
      contextSnapshotSha256: D(`${name}:context`),
      toolEffectPostureSha256: D(`${name}:posture`),
      pathJailSha256: D(`${name}:jail`),
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
    idempotencyKey: `assignment:${name}`,
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
    leaseTokenSha256: D(`${name}:lease:1`),
    idempotencyKey: `generation:${name}:1`,
  }).generation;

  const profile: RemoteWorkerCellProfile = {
    schemaVersion: REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    assignmentGeneration: generation.assignmentGeneration,
    cellId: `cell-${name}`,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    backend: "container",
    logicalRootSha256: D(`${name}:root`),
    assignmentManifestSha256: D(`${name}:manifest`),
    pathJailSha256: D(`${name}:jail`),
    capabilityProfileSha256: D(`${name}:capability`),
    contextSnapshotSha256: D(`${name}:context`),
    toolEffectPostureSha256: D(`${name}:posture`),
    runtimeAttestationSha256: D(`${name}:runtime`),
    launcherAttestationSha256: D(`${name}:launcher`),
    capacity: reservation(),
    egressPosture: "allowlisted",
    egressPolicySha256: D(`${name}:egress`),
    egressDnsRevision: 4,
    envAllowlistSha256: D(`${name}:env`),
  };

  return {
    db,
    repo: new RemoteWorkerCellRepository(db),
    key: {
      registryWorkspaceId: "default",
      assignmentId: assignment.assignmentId,
      assignmentGeneration: generation.assignmentGeneration,
    },
    profile,
    now,
  };
}

function reservation(
  overrides: Partial<RemoteWorkerCellCapacityReservation> = {},
): RemoteWorkerCellCapacityReservation {
  return {
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
    ...overrides,
  };
}

function footprint(overrides: Partial<RemoteWorkerCellCapacityFootprint> = {}): RemoteWorkerCellCapacityFootprint {
  return {
    schemaVersion: REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
    mutableRootBytes: 1_000,
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
    ...overrides,
  };
}

const activeAuthority: WorkerCellAssignmentAuthorityPort = { assertGenerationActive: () => undefined };
const deniedAuthority: WorkerCellAssignmentAuthorityPort = {
  assertGenerationActive: () => {
    throw new Error("assignment generation is not an active authority");
  },
};

describe("HX-505 cell service composition", () => {
  it("seats a cell only for a committed, active assignment generation", () => {
    const s = seed("service");
    const denied = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: deniedAuthority });
    expect(() => denied.profileCell({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now })).toThrow(
      /active authority/u,
    );
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: activeAuthority });
    const outcome = service.profileCell({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });
    expect(outcome.disposition).toBe("created");
  });

  it("accepts within the reservation, rejects without touching state, and quarantines counting bytes", () => {
    const s = seed("pressure");
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: activeAuthority });
    service.profileCell({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });

    const accept = service.evaluateCapacityAdmission({
      ...s.key,
      footprint: footprint(),
      reservation: reservation(),
      incomingBytes: 1_000,
      peakDiskBytes: 1_000,
      peakMemoryBytes: 10,
      peakFileCount: 1,
      peakProcessCount: 1,
      rawOutputBytes: 100,
      now: s.now,
    });
    expect(accept.decision).toBe("accept");
    expect(accept.cell.capacityRevision).toBe(1);

    // Reject: over the worst-case allocation, no unrecoverable bytes → canonical state untouched.
    const before = s.repo.getCell(s.key)!;
    const reject = service.evaluateCapacityAdmission({
      ...s.key,
      footprint: footprint(),
      reservation: reservation(),
      incomingBytes: 5_000_000,
      peakDiskBytes: 1_000,
      peakMemoryBytes: 10,
      peakFileCount: 1,
      peakProcessCount: 1,
      rawOutputBytes: 100,
      now: s.now,
    });
    expect(reject.decision).toBe("reject");
    expect(reject.cell.capacityRevision).toBe(before.capacityRevision);

    // Quarantine: over allocation WITH unrecoverable retained bytes → counted, never deleted.
    const quarantine = service.evaluateCapacityAdmission({
      ...s.key,
      footprint: footprint({ quarantineEvidenceBytes: 50, failedCleanupBytes: 25 }),
      reservation: reservation({ allocatedDiskBytes: 1_000, logicalDiskBytes: 1_000 }),
      incomingBytes: 5_000,
      peakDiskBytes: 1_000,
      peakMemoryBytes: 10,
      peakFileCount: 1,
      peakProcessCount: 1,
      rawOutputBytes: 100,
      now: s.now,
    });
    expect(quarantine.decision).toBe("quarantine");
    expect(quarantine.cell.quarantineRetainedBytes).toBe(50);
    expect(quarantine.cell.failedCleanupRetainedBytes).toBe(25);
    expect(s.repo.getCell(s.key)).toBeDefined();
  });

  it("admits worker egress only through the policy-enforced exact authority", () => {
    const s = seed("egress");
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: activeAuthority });
    const config = {
      allowlists: [["api.example.com:443"]],
      maxConnections: 8,
      connectDeadlineMs: 10_000,
      maxBytesPerConnection: 1_048_576,
      directSocketBypassProven: true,
    };
    expect(service.assertWorkerEgressAllowed("api.example.com:443", config).host).toBe("api.example.com");
    expect(() => service.assertWorkerEgressAllowed("169.254.169.254:80", config)).toThrow();
  });
});

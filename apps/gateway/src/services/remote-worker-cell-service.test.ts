import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CAPACITY_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROFILE_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  remoteWorkerCellProvisioningBindingSha256,
  remoteWorkerCellProvisioningPlanSha256, REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  type RemoteWorkerCellCapacityFootprint,
  type RemoteWorkerCellCapacityReservation,
  type RemoteWorkerCellProfile,
  type RemoteWorkerCellProvisioningPlan,
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
  RemoteWorkerCellProvisioningRepository,
  TaskRepository,
  createDatabase,
  type DatabaseClient,
  type RemoteWorkerCellKey,
} from "@goatcitadel/storage";
import {
  RemoteWorkerCellService,
  type RemoteWorkerCellRepositoryPort,
  type WorkerCellAssignmentAuthorityPort,
  type WorkerCellCapacityAdmissionInput,
} from "./remote-worker-cell-service.js";
import {
  RemoteWorkerCellProvisioningService, RemoteWorkerCellProvisioningInterruptedError,
  type NativeWorkerCellProvisioningPort,
} from "./remote-worker-cell-provisioning-service.js";
import { volumeExchangeFixture } from "../../../../packages/contracts/src/remote-worker-cell-volume-test-fixture.js";

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

function promiseBackedRepository(repository: RemoteWorkerCellRepository): RemoteWorkerCellRepositoryPort {
  return {
    profileOrReplay: async (input) => repository.profileOrReplay(input),
    getCell: async (key) => repository.getCell(key),
    recordCapacityHighWater: async (input) => repository.recordCapacityHighWater(input),
  };
}

const activeAuthority: WorkerCellAssignmentAuthorityPort = { assertGenerationActive: async () => undefined };
const deniedAuthority: WorkerCellAssignmentAuthorityPort = {
  assertGenerationActive: () => {
    throw new Error("assignment generation is not an active authority");
  },
};

function capacityInput(
  s: Seeded,
  overrides: Partial<WorkerCellCapacityAdmissionInput> = {},
): WorkerCellCapacityAdmissionInput {
  return {
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
    ...overrides,
  };
}

describe("HX-505 cell service composition", () => {
  it("rejects a caller reservation that widens the immutable cell profile", async () => {
    const s = seed("capacity-widen");
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: activeAuthority });
    const initial = await service.profileCell({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now });
    await expect(
      service.evaluateCapacityAdmission(
        capacityInput(s, {
          reservation: reservation({ allocatedDiskBytes: 8_000_000 }),
          incomingBytes: 5_000_000,
        }),
      ),
    ).rejects.toThrow(/immutable.*reservation/iu);
    expect(s.repo.getCell(s.key)).toEqual(initial.cell);
  });

  it("does not add the same retained footprint again when an observation repeats", async () => {
    const s = seed("capacity-repeat");
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: activeAuthority });
    await service.profileCell({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now });
    const observation = capacityInput(s, {
      footprint: footprint({ failedCleanupBytes: 25, quarantineEvidenceBytes: 50 }),
      incomingBytes: 5_000_000,
    });
    await service.evaluateCapacityAdmission(observation);
    const repeated = await service.evaluateCapacityAdmission(observation);
    expect(repeated.cell.failedCleanupRetainedBytes).toBe(25);
    expect(repeated.cell.quarantineRetainedBytes).toBe(50);
    const omitted = await service.evaluateCapacityAdmission(
      capacityInput(s, {
        footprint: footprint({ mutableRootBytes: 3_999_960 }),
        incomingBytes: 1,
      }),
    );
    expect(omitted.decision).toBe("quarantine");
    expect(omitted.cell.failedCleanupRetainedBytes).toBe(25);
    expect(omitted.cell.quarantineRetainedBytes).toBe(50);
    expect(omitted.cell.peakDiskBytes).toBeGreaterThanOrEqual(4_000_035);
  });

  it("requires current assignment authority before admitting capacity", async () => {
    const s = seed("capacity-revoked");
    s.repo.profileOrReplay({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now });
    const before = s.repo.getCell(s.key);
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: deniedAuthority });
    await expect(service.evaluateCapacityAdmission(capacityInput(s))).rejects.toThrow(/active authority/u);
    expect(s.repo.getCell(s.key)).toEqual(before);
  });

  it("refuses to commit an admission computed before another capacity observation", async () => {
    const s = seed("capacity-race");
    s.repo.profileOrReplay({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now });
    const repository = promiseBackedRepository(s.repo);
    const write = repository.recordCapacityHighWater;
    repository.recordCapacityHighWater = vi.fn(async (input) => {
      const { expectedCapacityRevision: _revision, ...concurrent } = input;
      s.repo.recordCapacityHighWater({ ...concurrent, peakDiskBytes: 4_500_000, failedCleanupRetainedBytes: 99 });
      return write(input);
    });
    const service = new RemoteWorkerCellService({ repository, assignmentAuthority: activeAuthority });
    await expect(service.evaluateCapacityAdmission(capacityInput(s))).rejects.toThrow(/capacity revision/iu);
    expect(s.repo.getCell(s.key)).toMatchObject({
      capacityRevision: 1,
      peakDiskBytes: 4_500_000,
      failedCleanupRetainedBytes: 99,
    });
  });

  it("refuses an admission computed before cleanup retained additional bytes", async () => {
    const s = seed("capacity-cleanup-race");
    s.repo.profileOrReplay({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now });
    const repository = promiseBackedRepository(s.repo);
    const write = repository.recordCapacityHighWater;
    repository.recordCapacityHighWater = vi.fn(async (input) => {
      for (const toState of ["pending", "stopping", "verifying_zero", "failed_cleanup"] as const) {
        s.repo.transitionCleanup({
          ...s.key,
          expectedRevision: s.repo.getCell(s.key)!.cleanupRevision,
          toState,
          failedCleanupRetainedBytes: toState === "failed_cleanup" ? 4_000_001 : 0,
          detailSha256: D(`cleanup:${toState}`),
          now: s.now,
        });
      }
      return write(input);
    });
    const service = new RemoteWorkerCellService({ repository, assignmentAuthority: activeAuthority });
    await expect(service.evaluateCapacityAdmission(capacityInput(s))).rejects.toThrow(/cleanup revision/iu);
    expect(s.repo.getCell(s.key)).toMatchObject({
      capacityRevision: 0,
      cleanupRevision: 5,
      failedCleanupRetainedBytes: 4_000_001,
    });
    expect(s.repo.listEvidenceAfter(s.key, 0).filter((row) => row.domain === "capacity")).toHaveLength(0);
  });

  it("retains observation values across asynchronous authority checks", async () => {
    const s = seed("capacity-input-drift");
    s.repo.profileOrReplay({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now });
    const observation = capacityInput(s);
    const authority = {
      assertGenerationActive: vi.fn(async () => {
        Object.assign(observation, { incomingBytes: 8_000_000, peakMemoryBytes: 999 });
        Object.assign(observation.footprint, { mutableRootBytes: 8_000_000 });
      }),
    };
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: authority });
    const result = await service.evaluateCapacityAdmission(observation);
    expect(result.decision).toBe("accept");
    expect(result.cell.peakDiskBytes).toBe(1_000);
    expect(result.cell.peakMemoryBytes).toBe(10);
    expect(authority.assertGenerationActive).toHaveBeenCalledTimes(2);
  });

  it("rechecks assignment authority after reading the capacity snapshot", async () => {
    const s = seed("capacity-authority-drift");
    s.repo.profileOrReplay({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now });
    const authority = {
      assertGenerationActive: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("assignment revoked")),
    };
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: authority });
    const before = s.repo.getCell(s.key);
    await expect(service.evaluateCapacityAdmission(capacityInput(s))).rejects.toThrow("assignment revoked");
    expect(s.repo.getCell(s.key)).toEqual(before);
  });

  it("seats a cell only for a committed, active assignment generation", async () => {
    const s = seed("service");
    const denied = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: deniedAuthority });
    await expect(
      denied.profileCell({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now }),
    ).rejects.toThrow(/active authority/u);
    const service = new RemoteWorkerCellService({
      repository: promiseBackedRepository(s.repo),
      assignmentAuthority: activeAuthority,
    });
    const outcome = await service.profileCell({
      profile: s.profile,
      idempotencyKey: "cell:idem:1",
      createdAt: s.now,
    });
    expect(outcome.disposition).toBe("created");
  });

  it("accepts within the reservation, rejects without touching state, and quarantines counting bytes", async () => {
    const s = seed("pressure");
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: activeAuthority });
    await service.profileCell({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now });

    const accept = await service.evaluateCapacityAdmission({
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
    const reject = await service.evaluateCapacityAdmission({
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
    const quarantine = await service.evaluateCapacityAdmission({
      ...s.key,
      footprint: footprint({ quarantineEvidenceBytes: 50, failedCleanupBytes: 25 }),
      reservation: reservation(),
      incomingBytes: 5_000_000,
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

function nativeCheckpoint(plan: RemoteWorkerCellProvisioningPlan, sequence: number, previous: string): string {
  const bytes = Buffer.alloc(1024);
  const file = (value: number) => "0100000000000000" + value.toString(16).padStart(32, "0");
  bytes.write("GCCELLP1", 0, "ascii"); bytes.writeUInt32LE(sequence, 8); bytes.writeUInt32LE(sequence, 12);
  for (const [offset, value] of [[16, previous], [48, plan.assignmentBindingSha256], [80, plan.profileSha256],
    [112, plan.diskIdentifierHex], [144, plan.parentIdentityHex], [168, file(2)]] as const) Buffer.from(value, "hex").copy(bytes, offset);
  bytes.writeBigUInt64LE(BigInt(plan.virtualDiskBytes), 128); bytes.writeBigUInt64LE(BigInt(plan.reservedDiskBytes), 136);
  bytes.write(plan.cellName, 192, "ascii"); bytes.write(plan.ownerSid, 232, "ascii"); bytes.write(plan.controllerSid, 416, "ascii");
  if (sequence >= 3) for (let index = 0; index < 4; index++) Buffer.from(file(index + 3), "hex").copy(bytes, 600 + index * 24);
  if (sequence === 5) Buffer.from(file(7), "hex").copy(bytes, 696);
  createHash("sha256").update(bytes.subarray(0, 992)).digest().copy(bytes, 992);
  return bytes.toString("hex");
}
function provisioningFixture(name: string, virtualDiskMiB = 16) {
  const s = seed(name);
  const profile: RemoteWorkerCellProfile = { ...s.profile, schemaVersion: REMOTE_WORKER_CELL_PROFILE_V2_SCHEMA_VERSION,
    backend: "windows_native", egressPosture: "deny_all", capacity: { ...s.profile.capacity,
      logicalDiskBytes: virtualDiskMiB * 1024 * 1024, allocatedDiskBytes: (virtualDiskMiB + 66) * 1024 * 1024 } };
  s.repo.profileOrReplay({ profile, idempotencyKey: `native:${name}`, createdAt: s.now });
  const cell = s.repo.claimProvisioning({ ...s.key, provisioningOwner: "native-controller", leaseExpiresAt: FUTURE,
    detailSha256: D("claim"), now: s.now })!;
  const authority = { ...s.key, provisioningOwner: "native-controller", provisioningLeaseExpiresAt: FUTURE };
  const plan: RemoteWorkerCellProvisioningPlan = {
    schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
    assignmentBindingSha256: remoteWorkerCellProvisioningBindingSha256({ ...authority, cellId: cell.cellId,
      workerId: cell.workerId, workerGeneration: cell.workerGeneration, profileSha256: cell.profileSha256 }),
    profileSha256: cell.profileSha256, parentIdentityHex: "0100000000000000" + "1".padStart(32, "0"),
    cellName: `gc-cell-${"1".repeat(32)}`, ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5",
    diskIdentifierHex: "3".repeat(32), virtualDiskBytes: virtualDiskMiB * 1024 * 1024, reservedDiskBytes: (virtualDiskMiB + 64) * 1024 * 1024,
  };
  const repository = new RemoteWorkerCellProvisioningRepository(s.db);
  const emitted: string[] = [];
  const acknowledged: string[] = [];
  const native: NativeWorkerCellProvisioningPort = {
    create: vi.fn(async (frozen, commit) => {
      expect(repository.getSnapshot(s.key)?.plan.plan).toEqual(frozen);
      for (let sequence = 1; sequence <= 5; sequence++) {
        const record = nativeCheckpoint(frozen, sequence, emitted.at(-1)?.slice(-64) ?? "0".repeat(64));
        emitted.push(record);
        const acknowledgement = await commit(record);
        expect(repository.getSnapshot(s.key)?.checkpoints.at(-1)?.recordHex).toBe(record);
        expect(acknowledgement).toBe(record.slice(-64));
        acknowledged.push(acknowledgement);
      }
    }),
    recover: vi.fn(async () => [...emitted]),
  };
  const input = { ...authority, plan, expectedCapacityRevision: cell.capacityRevision };
  return { ...s, input, repository, native, emitted, acknowledged };
}

describe("RemoteWorkerCellProvisioningService", () => {
  it("retains volume history and reports unavailable native verification instead of verifying only creation", async () => {
    const s = provisioningFixture("checkpoint-volume-recovery", 64);
    const service = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority, native: s.native });
    await service.provision(s.input);
    const volume = volumeExchangeFixture({ schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      ...s.key, leaseRevision: 1, plan: s.input.plan, planSha256: remoteWorkerCellProvisioningPlanSha256(s.input.plan), records: s.emitted });
    for (let index = 0; index < volume.volumeRecords!.length; index++)
      s.repository.appendVolumeCheckpoint({ ...s.input, expectedSequence: index, recordHex: volume.volumeRecords![index]! });
    const result = await service.reconcile(s.key);
    expect(result).toMatchObject({ status: "reconciliation_required", reason: "volume_verification_unavailable" });
    expect(result.snapshot.volumeCheckpoints.map((record) => record.recordHex)).toEqual(volume.volumeRecords);
    expect(s.native.create).toHaveBeenCalledOnce();
    expect(s.native.recover).not.toHaveBeenCalled();
  });
  it("commits each native checkpoint before acknowledging it and recovers an exact replay without creating again", async () => {
    const s = provisioningFixture("checkpoint-service");
    const service = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority, native: s.native });
    expect((await service.provision(s.input)).status).toBe("recorded");
    expect(s.acknowledged).toHaveLength(5);
    expect(s.repo.getCell(s.key)?.executionState).toBe("provisioning");
    const recovered = await service.provision(s.input);
    expect(recovered.status).toBe("recovery_verified");
    expect(s.native.create).toHaveBeenCalledTimes(1);
    expect(s.native.recover).toHaveBeenCalledTimes(1);
    s.emitted.splice(3);
    expect(await service.reconcile(s.key)).toMatchObject({ status: "reconciliation_required", reason: "checkpoint_mismatch" });
    expect(s.repository.getSnapshot(s.key)?.checkpoints).toHaveLength(5);
  });

  it("withholds acknowledgement after a canonical commit failure and preserves the unknown native result", async () => {
    const s = provisioningFixture("checkpoint-failure");
    const append = s.repository.appendCheckpoint.bind(s.repository);
    vi.spyOn(s.repository, "appendCheckpoint").mockImplementation((input) => {
      if (input.expectedSequence === 2) throw new Error("fixture storage failure");
      return append(input);
    });
    const service = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority, native: s.native });
    await expect(service.provision(s.input)).rejects.toBeInstanceOf(RemoteWorkerCellProvisioningInterruptedError);
    expect(s.acknowledged).toHaveLength(2);
    expect(s.emitted).toHaveLength(3);
    expect(s.repository.getSnapshot(s.key)?.checkpoints).toHaveLength(2);
    expect(await service.provision(s.input)).toMatchObject({ status: "reconciliation_required", reason: "checkpoint_mismatch" });
    expect(s.native.create).toHaveBeenCalledTimes(1);
  });

  it("retains prepared intent after authority is withdrawn and never recreates a plan without its native anchor", async () => {
    const s = provisioningFixture("checkpoint-authority");
    const authority = { assertGenerationActive: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("assignment withdrawn")) };
    const service = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: authority, native: s.native });
    await expect(service.provision(s.input)).rejects.toBeInstanceOf(RemoteWorkerCellProvisioningInterruptedError);
    expect(s.native.create).not.toHaveBeenCalled();
    expect(s.repository.getSnapshot(s.key)?.checkpoints).toHaveLength(0);
    authority.assertGenerationActive.mockResolvedValue(undefined);
    expect(await service.provision(s.input)).toMatchObject({ status: "reconciliation_required", reason: "no_anchor" });
    expect(s.native.create).not.toHaveBeenCalled();
    expect(s.native.recover).not.toHaveBeenCalled();
  });
});

// The named Windows provisioning lane supplies fresh, task-owned fixture paths.
// Ordinary Gateway tests do not build native images or create disk files.
if (process.env.GOATCITADEL_CELL_PROVISIONING_PROOF) {
  describe("canonical provisioning with the real pinned native process", () => {
    const configuration = JSON.parse(process.env.GOATCITADEL_CELL_PROVISIONING_PROOF) as {
      output: string; setup: string; guardAddon: string;
    };
    async function realFixture(name: string) {
      const s = provisioningFixture(name);
      const parentPath = path.join(configuration.output, `parent-${randomUUID()}`);
      const setup = spawnSync(configuration.setup, [parentPath], { encoding: "utf8", windowsHide: true,
        timeout: 10_000, env: { SystemRoot: process.env.SystemRoot } });
      expect(setup.error).toBeUndefined(); expect(setup.status, setup.stderr).toBe(0);
      const parent = JSON.parse(setup.stdout) as { parentIdentityHex: string; ownerSid: string; controllerSid: string };
      const input = { ...s.input, plan: { ...s.input.plan, ...parent, cellName: `gc-cell-${randomUUID().replaceAll("-", "")}` } };
      const guard = createRequire(import.meta.url)(configuration.guardAddon) as {
        pinCellProvisioningExecutor(): { executorPath: string; lease: object };
      };
      const module = await import(pathToFileURL(path.resolve(
        "../../apps/remote-worker/dist/worker-windows-cell-provisioning.js",
      )).href) as { createWindowsWorkerCellProvisioning(options: {
        parentPath: string; wallMs: number; signal: AbortSignal; assertCurrent: () => Promise<void>; imageGuard: typeof guard;
      }): NativeWorkerCellProvisioningPort };
      const create = (signal = new AbortController().signal) => module.createWindowsWorkerCellProvisioning({
        parentPath, wallMs: 10_000, signal, assertCurrent: async () => undefined, imageGuard: guard,
      });
      const journal = () => fs.readFileSync(path.join(parentPath, `${input.plan.cellName}.provisioning`));
      const save = () => fs.writeFileSync(path.join(configuration.output, `${name}.json`), JSON.stringify({
        parentPath, input, snapshot: s.repository.getSnapshot(s.key), journalHex: journal().toString("hex"),
        platformReady: false, installedService: false, volumeAttached: false,
      }, null, 2), { flag: "wx" });
      return { ...s, input, create, parentPath, journal, save };
    }
    it("commits real native records and verifies them in a fresh recovery process", async () => {
      const s = await realFixture("real-native-complete");
      const driver = s.create();
      const native = { ...driver, create: vi.fn(driver.create) };
      const service = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority, native });
      const completed = await service.provision(s.input);
      expect(completed.status).toBe("recorded");
      expect(completed.snapshot.checkpoints.map((row) => row.recordHex).join("")).toBe(s.journal().toString("hex"));
      expect(s.repo.getCell(s.key)?.executionState).toBe("provisioning");
      const fresh = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority,
        native: { ...s.create(), create: native.create } });
      expect((await fresh.provision(s.input)).status).toBe("recovery_verified");
      expect(native.create).toHaveBeenCalledTimes(1);
      s.save();
    });
    it("retains native progress ahead of storage when the completion acknowledgement is lost", async () => {
      const s = await realFixture("real-native-lost-ack");
      const append = s.repository.appendCheckpoint.bind(s.repository);
      vi.spyOn(s.repository, "appendCheckpoint").mockImplementation((input) => {
        if (input.expectedSequence === 2) throw new Error("Fixture canonical commit unavailable");
        return append(input);
      });
      const service = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority, native: s.create() });
      await expect(service.provision(s.input)).rejects.toBeInstanceOf(RemoteWorkerCellProvisioningInterruptedError);
      expect(s.repository.getSnapshot(s.key)?.checkpoints).toHaveLength(2);
      expect(s.journal()).toHaveLength(3 * 1024);
      expect(fs.existsSync(path.join(s.parentPath, s.input.plan.cellName, "control", "cell.vhdx"))).toBe(false);
      const before = s.journal();
      expect(await service.provision(s.input)).toMatchObject({ status: "reconciliation_required", reason: "checkpoint_mismatch" });
      expect(s.journal()).toEqual(before);
      s.save();
    });
    it("joins a cancelled child after the first commit and recovers its retained intent without workspace creation", async () => {
      const s = await realFixture("real-native-cancelled");
      const controller = new AbortController();
      const append = s.repository.appendCheckpoint.bind(s.repository);
      vi.spyOn(s.repository, "appendCheckpoint").mockImplementation((input) => {
        const record = append(input); controller.abort(); return record;
      });
      const service = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority, native: s.create(controller.signal) });
      await expect(service.provision(s.input)).rejects.toBeInstanceOf(RemoteWorkerCellProvisioningInterruptedError);
      expect(s.repository.getSnapshot(s.key)?.checkpoints).toHaveLength(1);
      expect(s.journal()).toHaveLength(1024);
      expect(fs.existsSync(path.join(s.parentPath, s.input.plan.cellName))).toBe(false);
      const fresh = new RemoteWorkerCellProvisioningService({ repository: s.repository, assignmentAuthority: activeAuthority, native: s.create() });
      expect(await fresh.provision(s.input)).toMatchObject({ status: "reconciliation_required", reason: "incomplete_journal" });
      s.save();
    });
  });
}

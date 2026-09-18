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
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  canonicalJsonString,
  remoteWorkerCellCapacityInventorySha256,
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
  type RemoteWorkerCellServiceDeps,
  type WorkerCellCapacityAdmissionResult,
  type WorkerCellAssignmentAuthorityPort,
  type WorkerCellCapacityAdmissionInput,
} from "./remote-worker-cell-service.js";
import {
  RemoteWorkerCellProvisioningService, RemoteWorkerCellProvisioningInterruptedError,
  type NativeWorkerCellProvisioningPort,
} from "./remote-worker-cell-provisioning-service.js";
import { volumeExchangeFixture } from "../../../../packages/contracts/src/remote-worker-cell-volume-test-fixture.js";
import { capacityInventoryFixture } from "../../../../packages/contracts/src/remote-worker-cell-capacity-inventory-test-fixture.js";

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
  return { profileOrReplay: async (input) => repository.profileOrReplay(input) };
}

const activeAuthority: WorkerCellAssignmentAuthorityPort = { assertGenerationActive: async () => undefined };
const deniedAuthority: WorkerCellAssignmentAuthorityPort = {
  assertGenerationActive: () => { throw new Error("assignment generation is not an active authority"); },
};

function capacityPort() {
  return {
    admit: vi.fn<RemoteWorkerCellServiceDeps["capacityAdmission"]["admit"]>(),
    readForAssignment: vi.fn<RemoteWorkerCellServiceDeps["capacityAdmission"]["readForAssignment"]>(),
    admitInventory: vi.fn<RemoteWorkerCellServiceDeps["capacityAdmission"]["admitInventory"]>(),
    readInventory: vi.fn<RemoteWorkerCellServiceDeps["capacityAdmission"]["readInventory"]>(),
  };
}

function capacityInput(s: Seeded): WorkerCellCapacityAdmissionInput {
  const cell = s.repo.getCell(s.key)!;
  const credentialAuthority = {
    registryWorkspaceId: s.key.registryWorkspaceId, bootstrapId: "capacity-bootstrap", workerId: s.profile.workerId,
    workerGeneration: s.profile.workerGeneration, credentialId: "capacity-credential", credentialGeneration: 1,
    authorizationCredentialSha256: D("credential"), nodeId: "capacity-node", clientCertificateSha256: D("certificate"),
    runtimeManifestSha256: D("runtime"), workspaceCeilingSha256: D("workspace"), capabilityCeilingSha256: D("capability"),
    protectedAdmissionEnvelopeSha256: D("envelope"), protectedAdmissionContextSha256: D("context"), claimsSha256: D("claims"),
  };
  return {
    ...s.key, leaseRevision: 1, leaseTokenSha256: D("lease"),
    protectedAuthority: { credentialAuthority, meshAdmission: {
      schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
      registryWorkspaceId: s.key.registryWorkspaceId, bootstrapId: credentialAuthority.bootstrapId,
      workerId: s.profile.workerId, workerGeneration: s.profile.workerGeneration,
      credentialId: credentialAuthority.credentialId, credentialGeneration: 1, workspaceId: "default",
      nodeId: credentialAuthority.nodeId, admissionGeneration: 1, joinAuthorityGeneration: 1,
      joinCredentialSha256: D("join"), protectedAdmissionEnvelopeSha256: D("envelope"), protectedAdmissionContextSha256: D("context"),
    } },
    expectedCapacityRevision: cell.capacityRevision, expectedCleanupRevision: cell.cleanupRevision,
    expectedExecutionRevision: cell.executionRevision,
    observation: { footprint: footprint(), reservation: reservation(), incomingBytes: 1_000,
      peakDiskBytes: 1_000, peakMemoryBytes: 10, peakFileCount: 1, peakProcessCount: 1, rawOutputBytes: 100 },
  };
}

function capacityFixture(name: string) {
  const s = seed(name);
  const cell = s.repo.profileOrReplay({ profile: s.profile, idempotencyKey: "profile", createdAt: s.now }).cell;
  const owner = capacityPort();
  const authority = { assertGenerationActive: vi.fn() };
  const service = new RemoteWorkerCellService({ repository: promiseBackedRepository(s.repo), assignmentAuthority: authority, capacityAdmission: owner });
  return { ...s, cell, owner, authority, service, input: capacityInput(s) };
}

describe("HX-505 cell service composition", () => {
  it("awaits inventory admission with exact frozen capture bytes and derived physical accounting", async () => {
    const f = capacityFixture("inventory-owner"), inventory = capacityInventoryFixture(f.cell.profileSha256, "gateway-inventory");
    const input = { ...f.input, expectedBackupRevision: f.cell.backupRevision, inventory,
      inventoryBinding: { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
        inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) } };
    let finish!: (value: WorkerCellCapacityAdmissionResult) => void;
    f.owner.admitInventory.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let settled = false;
    const pending = f.service.admitCapacityInventory(input).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const frozen = f.owner.admitInventory.mock.calls[0]![0];
    Object.assign(inventory.areas[0]!.objects[0]!, { allocatedBytes: 8_000_000 });
    Object.assign(input.inventoryBinding, { captureSha256: D("changed") });
    expect(remoteWorkerCellCapacityInventorySha256(frozen.inventory)).toBe(frozen.inventoryBinding.inventorySha256);
    expect(frozen.observation).toMatchObject({ footprint: { mutableRootBytes: 69_632 }, peakFileCount: 4 });
    expect(Object.isFrozen(frozen.inventory.areas[0]!.objects)).toBe(true);
    finish({ decision: "accept", reason: "inventory committed", cell: f.cell });
    expect((await pending).decision).toBe("accept");
    expect(f.owner.admit).not.toHaveBeenCalled();
    expect(f.authority.assertGenerationActive).not.toHaveBeenCalled();
  });

  it("does not substitute partial inventories or fall back after atomic inventory rejection", async () => {
    const f = capacityFixture("inventory-refused"), inventory = capacityInventoryFixture(f.cell.profileSha256, "gateway-refused");
    const input = { ...f.input, expectedBackupRevision: f.cell.backupRevision, inventory,
      inventoryBinding: { profileSha256: inventory.profileSha256, captureSha256: inventory.captureSha256,
        inventorySha256: remoteWorkerCellCapacityInventorySha256(inventory) } };
    await expect(f.service.admitCapacityInventory({ ...input, inventory: { ...inventory, areas: inventory.areas.slice(1) } })).rejects.toThrow(/every footprint area/u);
    expect(f.owner.admitInventory).not.toHaveBeenCalled();
    f.owner.admitInventory.mockRejectedValue(new Error("capture authority changed"));
    await expect(f.service.admitCapacityInventory(input)).rejects.toThrow("capture authority changed");
    expect(f.owner.admit).not.toHaveBeenCalled();
    expect(f.repo.getCell(f.key)).toEqual(f.cell);
  });

  it("reads only the protected retained inventory revision", async () => {
    const f = capacityFixture("inventory-read");
    f.owner.readInventory.mockResolvedValue(null);
    expect(await f.service.readCapacityInventory({ ...f.input, capacityRevision: 1 })).toBeNull();
    expect(f.owner.readInventory.mock.calls[0]![0]).not.toHaveProperty("observation");
    await expect(f.service.readCapacityInventory({ ...f.input, capacityRevision: 0 })).rejects.toThrow(/positive/u);
    expect(f.owner.readInventory).toHaveBeenCalledTimes(1);
    expect(f.owner.admitInventory).not.toHaveBeenCalled();
  });

  it("awaits the atomic capacity owner and freezes the complete authority and observation before delivery", async () => {
    const f = capacityFixture("capacity-atomic-owner");
    let finish!: (value: WorkerCellCapacityAdmissionResult) => void;
    f.owner.admit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let settled = false;
    const pending = f.service.evaluateCapacityAdmission(f.input).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const command = f.owner.admit.mock.calls[0]![0];
    Object.assign(f.input.observation, { incomingBytes: 8_000_000 });
    Object.assign(f.input.observation.footprint, { mutableRootBytes: 8_000_000 });
    Object.assign(f.input.observation.reservation, { allocatedDiskBytes: 8_000_000 });
    Object.assign(f.input.protectedAuthority.credentialAuthority, { credentialGeneration: 999 });
    Object.assign(f.input.protectedAuthority.meshAdmission, { admissionGeneration: 999 });
    expect(command.observation.incomingBytes).toBe(1_000);
    expect(command.observation.footprint.mutableRootBytes).toBe(1_000);
    expect(command.observation.reservation.allocatedDiskBytes).toBe(4_000_000);
    expect(command.protectedAuthority.credentialAuthority.credentialGeneration).toBe(1);
    expect(command.protectedAuthority.meshAdmission.admissionGeneration).toBe(1);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.protectedAuthority.credentialAuthority)).toBe(true);
    const result = { decision: "accept" as const, reason: "committed by capacity owner", cell: { ...f.cell, capacityRevision: f.cell.capacityRevision + 1 } };
    finish(result);
    expect(await pending).toEqual(result);
    expect(f.authority.assertGenerationActive).not.toHaveBeenCalled();
    expect(f.owner.readForAssignment).not.toHaveBeenCalled();
  });

  it("awaits protected capacity snapshots without writing or using preflight-only authority", async () => {
    const f = capacityFixture("capacity-snapshot");
    f.owner.readForAssignment.mockResolvedValue(f.cell);
    expect(await f.service.readCapacitySnapshot(f.input)).toEqual(f.cell);
    const command = f.owner.readForAssignment.mock.calls[0]![0];
    expect(command.leaseTokenSha256).toBe(f.input.leaseTokenSha256);
    expect(command.protectedAuthority).toEqual(f.input.protectedAuthority);
    expect(command).not.toHaveProperty("observation");
    expect(f.owner.admit).not.toHaveBeenCalled();
    expect(f.authority.assertGenerationActive).not.toHaveBeenCalled();
  });

  it("propagates an atomic authority rejection without a fallback write", async () => {
    const f = capacityFixture("capacity-refused");
    f.owner.admit.mockRejectedValue(new Error("assignment revoked at commit"));
    await expect(f.service.evaluateCapacityAdmission(f.input)).rejects.toThrow("assignment revoked at commit");
    expect(f.repo.getCell(f.key)).toEqual(f.cell);
    expect(f.owner.admit).toHaveBeenCalledTimes(1);
    expect(f.owner.readForAssignment).not.toHaveBeenCalled();
  });

  it.each(["authority", "revision", "observation"] as const)("rejects invalid %s before calling storage", async kind => {
    const f = capacityFixture("capacity-invalid-" + kind);
    if (kind === "authority") Object.assign(f.input, { protectedAuthority: undefined });
    else if (kind === "revision") Object.assign(f.input, { expectedExecutionRevision: -1 });
    else Object.assign(f.input.observation, { peakMemoryBytes: Number.NaN });
    await expect(f.service.evaluateCapacityAdmission(f.input)).rejects.toThrow();
    expect(f.owner.admit).not.toHaveBeenCalled();
    expect(f.owner.readForAssignment).not.toHaveBeenCalled();
    expect(f.repo.getCell(f.key)).toEqual(f.cell);
  });

  it("seats a cell only for a committed, active assignment generation", async () => {
    const s = seed("service");
    const denied = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: deniedAuthority, capacityAdmission: capacityPort() });
    await expect(denied.profileCell({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now })).rejects.toThrow(/active authority/u);
    const service = new RemoteWorkerCellService({ repository: promiseBackedRepository(s.repo), assignmentAuthority: activeAuthority, capacityAdmission: capacityPort() });
    expect((await service.profileCell({ profile: s.profile, idempotencyKey: "cell:idem:1", createdAt: s.now })).disposition).toBe("created");
  });

  it("admits worker egress only through the policy-enforced exact authority", () => {
    const s = seed("egress");
    const service = new RemoteWorkerCellService({ repository: s.repo, assignmentAuthority: activeAuthority, capacityAdmission: capacityPort() });
    const config = { allowlists: [["api.example.com:443"]], maxConnections: 8, connectDeadlineMs: 10_000,
      maxBytesPerConnection: 1_048_576, directSocketBypassProven: true };
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

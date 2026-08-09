import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
  REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  buildRemoteWorkerAssignmentParentContext,
  buildRemoteWorkerPopV2Preimage,
  buildRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  remoteWorkerAssignmentParentContextSha256,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerAssignmentEventInput,
} from "@goatcitadel/contracts";
import {
  ChatSessionMetaRepository,
  ChatTurnTraceRepository,
  DurableRunRepository,
  MeshCapabilityNodeAdmissionRepository,
  MeshRepository,
  RemoteWorkerAdmissionRepository,
  RemoteWorkerAssignmentRepository,
  RemoteWorkerNonceRepository,
  TaskRepository,
  createDatabase,
  type DatabaseClient,
} from "@goatcitadel/storage";
import {
  REMOTE_WORKER_ASSIGNMENT_CONTROL_READ_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_LEASE_RENEWAL_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES,
  REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_WORKER_SETTLEMENT_SCHEMA_VERSION,
  RemoteWorkerAssignmentProtocolService,
  type RemoteWorkerAssignmentProtocolRequest,
  type RemoteWorkerAssignmentMeshAuthorityPort,
  type RemoteWorkerAssignmentProtocolStorePort,
  type RemoteWorkerAssignmentRuntimeCredentialAuthority,
  type RemoteWorkerAssignmentRuntimeCredentialAuthorityPort,
} from "./remote-worker-assignment-protocol-service.js";
import type {
  CurrentRemoteWorkerRuntimeCredentialAuthority,
  RemoteWorkerCurrentRuntimeCredentialAuthorityPort,
} from "./remote-worker-current-authority-service.js";
import {
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  type RemoteWorkerProtocolBody,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const FUTURE = "2099-01-01T00:00:00.000Z";
const databases: DatabaseClient[] = [];
let requestSequence = 0;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

interface Harness {
  readonly db: DatabaseClient;
  readonly assignments: RemoteWorkerAssignmentRepository;
  readonly admissions: RemoteWorkerAdmissionRepository;
  readonly nonces: RemoteWorkerNonceRepository;
  readonly assignmentId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly nodeId: string;
  readonly nodeAdmissionGeneration: number;
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly credentialSecret: string;
  readonly leaseToken: string;
  readonly publicKeySpkiDer: Buffer;
  readonly publicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly trustAnchorSha256: string;
  readonly privateKey: KeyObject;
  readonly now: Date;
}

function createHarness(seed: string): Harness {
  const db = createDatabase({ dbPath: ":memory:" });
  databases.push(db);
  const durableRuns = new DurableRunRepository(db);
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const admissions = new RemoteWorkerAdmissionRepository(db);
  const now = durableRuns.readDatabaseNow();
  const protocolNow = new Date();
  const taskId = `task-${seed}`;
  const sessionId = `session-${seed}`;
  const turnId = `turn-${seed}`;
  const durableRunId = `run-${seed}`;
  new TaskRepository(db).create({ title: `Assignment ${seed}`, workspaceId: "default" }, now, { taskId });
  new ChatSessionMetaRepository(db).ensure(sessionId, now, "default");
  new ChatTurnTraceRepository(db).create({
    turnId,
    sessionId,
    userMessageId: `message-${seed}`,
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: now,
  });
  const parent = { executionWorkspaceId: "default", durableRunId, taskId, sessionId, turnId } as const;
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
      remoteWorkerAssignmentParentContext: buildRemoteWorkerAssignmentParentContext(parent),
      remoteWorkerAssignmentParentContextSha256: remoteWorkerAssignmentParentContextSha256(parent),
    },
  });

  const keyPair = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKeySpkiDer) || publicKeySpkiDer.byteLength !== 44) throw new Error("invalid test key");
  const publicKeySpkiSha256 = D(publicKeySpkiDer);
  const clientCertificateSha256 = D(`${seed}:certificate`);
  const trustAnchorSha256 = D(`${seed}:trust-anchor`);
  const runtimePayload = {
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
  const runtimeManifest = {
    payload: runtimePayload,
    payloadSha256: D(canonicalJsonString(runtimePayload)),
    signatureAlgorithm: "ed25519" as const,
    signerKeyId: `release-${seed}`,
    signatureBase64Url: "A".repeat(86),
  };
  const bootstrapSecret = token(`${seed}:bootstrap`);
  const bootstrap = admissions.createBootstrap({
    registryWorkspaceId: "default",
    workerLabel: `Worker ${seed}`,
    platform: "windows",
    architecture: "x64",
    runtimeManifest,
    allowedWorkspaceIds: ["default"],
    capabilityClasses: ["durable_compute", "gateway_inference"],
    expiresInSeconds: 300,
    createdByActorId: "operator-a",
    idempotencyKey: `bootstrap:${seed}`,
    bootstrapSecretSha256: D(bootstrapSecret),
  }).record;
  const credentialSecret = token(`${seed}:credential`);
  const worker = admissions.finalizeBootstrapAdmission({
    expectedRegistryWorkspaceId: bootstrap.registryWorkspaceId,
    expectedBootstrapId: bootstrap.bootstrapId,
    expectedTargetWorkerGeneration: bootstrap.targetWorkerGeneration,
    bootstrapSecretSha256: D(bootstrapSecret),
    verifiedPublicKeySpkiSha256: publicKeySpkiSha256,
    verifiedClientCertificateSha256: clientCertificateSha256,
    verifiedRuntimeManifestSha256: D(canonicalJsonString(runtimeManifest)),
    verifiedWorkspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
    verifiedTransportIdentitySource: "native_mtls",
    verifiedTransportTrustAnchorSha256: trustAnchorSha256,
    verifiedTransportReceiptSha256: D(`${seed}:transport-receipt`),
    verifiedProofOfPossessionReceiptSha256: D(`${seed}:pop-receipt`),
    verifiedDownloadReceiptSha256: D(`${seed}:download-receipt`),
    verifiedInstalledTreeAttestationSha256: D(`${seed}:installed-tree-attestation`),
    verifiedInstalledTreeReceiptSha256: D(`${seed}:installed-tree-receipt`),
    credentialIssuanceProofSha256: D(`${seed}:credential-issuance`),
    credentialExpiresInSeconds: 600,
    credentialTokenSha256: D(credentialSecret),
    exchangeIdempotencyKey: `exchange:${seed}`,
  });

  const mesh = new MeshRepository(db);
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
  expect(mesh.consumeJoinToken(joinToken, bootstrap.nodeId, now)).toBe(true);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(bootstrap.nodeId, joinToken).tokenHash;
  const nodeAdmission = new MeshCapabilityNodeAdmissionRepository(db).admit({
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
      ...parent,
      capabilityProfileSha256: D(`${seed}:capability-profile`),
      contextSnapshotSha256: D(`${seed}:context`),
      toolEffectPostureSha256: D(`${seed}:posture`),
      pathJailSha256: D(`${seed}:path-jail`),
      parentContextSha256: remoteWorkerAssignmentParentContextSha256(parent),
      requiredCapabilityClasses: ["durable_compute", "gateway_inference"],
      deadlineAt: FUTURE,
      leaseTtlSeconds: 60,
      maxEventCount: 100,
      maxEventBytes: 4096,
      eventLowWatermark: 2,
      eventHighWatermark: 5,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 1_048_576,
    },
    createdByActorId: "gateway-a",
    idempotencyKey: `assignment:${seed}`,
  }).assignment;
  const leaseToken = token(`${seed}:lease:1`);
  assignments.startGeneration({
    registryWorkspaceId: "default",
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    dispatchOwnerId: "gateway-a",
    durableRunAttempt: 1,
    leaseTokenSha256: D(leaseToken),
    idempotencyKey: `generation:${seed}:1`,
  });
  return {
    db,
    assignments,
    admissions,
    nonces: new RemoteWorkerNonceRepository(db),
    assignmentId: assignment.assignmentId,
    workerId: worker.generation.workerId,
    workerGeneration: worker.generation.workerGeneration,
    nodeId: bootstrap.nodeId,
    nodeAdmissionGeneration: nodeAdmission.admissionGeneration,
    credentialId: worker.credential.credentialId,
    credentialGeneration: worker.credential.credentialGeneration,
    credentialSecret,
    leaseToken,
    publicKeySpkiDer,
    publicKeySpkiSha256,
    clientCertificateSha256,
    trustAnchorSha256,
    privateKey: keyPair.privateKey,
    now: protocolNow,
  };
}

function authorityFor(
  h: Harness,
  credentialTokenSha256: string,
): CurrentRemoteWorkerRuntimeCredentialAuthority | undefined {
  const resolved = h.admissions.resolveRuntimeCredentialByHash(credentialTokenSha256);
  if (resolved === undefined) return undefined;
  return {
    credentialId: resolved.credential.credentialId,
    credentialGeneration: resolved.credential.credentialGeneration,
    authorizationCredentialSha256: credentialTokenSha256,
    registryWorkspaceId: resolved.generation.registryWorkspaceId,
    bootstrapId: resolved.generation.bootstrapId,
    workerId: resolved.generation.workerId,
    workerGeneration: resolved.generation.workerGeneration,
    nodeId: resolved.generation.nodeId,
    publicKeySpkiDer: Buffer.from(h.publicKeySpkiDer),
    publicKeySpkiSha256: resolved.generation.publicKeySpkiSha256,
    clientCertificateSha256: resolved.generation.clientCertificateSha256,
    transportTrustAnchorSha256: resolved.generation.transportTrustAnchorSha256,
    runtimeManifestSha256: resolved.generation.runtimeManifestSha256,
    workspaceCeilingSha256: resolved.generation.workspaceCeilingSha256,
    capabilityCeilingSha256: resolved.generation.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: D(`${resolved.generation.workerId}:protected-envelope`),
    protectedAdmissionContextSha256: D(`${resolved.generation.workerId}:protected-context`),
    claims: resolved.credential.claims,
    claimsSha256: resolved.credential.claimsSha256,
  };
}

function createService(
  h: Harness,
  options: {
    readonly authorityTransform?: (
      authority: RemoteWorkerAssignmentRuntimeCredentialAuthority,
    ) => RemoteWorkerAssignmentRuntimeCredentialAuthority;
    readonly assignments?: RemoteWorkerAssignmentProtocolStorePort;
    readonly meshAdmissions?: RemoteWorkerAssignmentMeshAuthorityPort;
  } = {},
): RemoteWorkerAssignmentProtocolService {
  const currentAuthority: RemoteWorkerCurrentRuntimeCredentialAuthorityPort = {
    resolveByCredentialTokenSha256: (credentialTokenSha256) => {
      const authority = authorityFor(h, credentialTokenSha256);
      return authority === undefined ? undefined : (options.authorityTransform?.(authority) ?? authority);
    },
  };
  const credentialAuthority: RemoteWorkerAssignmentRuntimeCredentialAuthorityPort = currentAuthority;
  return new RemoteWorkerAssignmentProtocolService({
    credentialAuthority,
    meshAdmissions: options.meshAdmissions ?? {
      resolveCurrentForRuntimeCredential: (input) => meshAuthorityFor(h, input),
    },
    nonceConsumer: h.nonces,
    assignments: options.assignments ?? h.assignments,
    clock: () => new Date(h.now),
  });
}

function meshAuthorityFor(
  h: Harness,
  input: Parameters<RemoteWorkerAssignmentMeshAuthorityPort["resolveCurrentForRuntimeCredential"]>[0],
) {
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
    registryWorkspaceId: input.registryWorkspaceId,
    bootstrapId: input.bootstrapId,
    workerId: input.workerId,
    workerGeneration: input.workerGeneration,
    credentialId: input.credentialId,
    credentialGeneration: input.credentialGeneration,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    admissionGeneration: h.nodeAdmissionGeneration,
    joinAuthorityGeneration: 1,
    joinCredentialSha256: D(`${h.workerId}:mesh-join`),
    protectedAdmissionEnvelopeSha256: input.protectedAdmissionEnvelopeSha256,
    protectedAdmissionContextSha256: input.protectedAdmissionContextSha256,
  });
}

function rpcRequest(
  h: Harness,
  route: (typeof REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES)[keyof typeof REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES],
  payload: object,
  options: {
    readonly idempotencyKey?: string;
    readonly nonce?: string;
    readonly credentialSecret?: string;
    readonly proofVersion?: "legacy_v1" | "protected_v2";
  } = {},
): RemoteWorkerAssignmentProtocolRequest {
  requestSequence += 1;
  const idempotencyKey = options.idempotencyKey ?? `rpc:${requestSequence}`;
  const nonce = options.nonce ?? Buffer.alloc(32, requestSequence % 251).toString("base64url");
  const credentialSecret = options.credentialSecret ?? h.credentialSecret;
  const body: RemoteWorkerProtocolBody = Object.freeze(
    options.proofVersion === "legacy_v1"
      ? {
          schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
          operation: route.operation,
          authorityId: h.credentialId,
          authorityGeneration: h.credentialGeneration,
          idempotencyKey,
          payload: payload as RemoteWorkerProtocolBody["payload"],
        }
      : {
          schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
          operation: route.operation,
          authorityId: h.credentialId,
          authorityGeneration: h.credentialGeneration,
          workerGeneration: h.workerGeneration,
          idempotencyKey,
          payload: payload as RemoteWorkerProtocolBody["payload"],
        },
  );
  const transportIdentity = transport(h, requestSequence);
  const signedBytes =
    body.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION
      ? Buffer.from(
          buildRemoteWorkerPopV2Preimage({
            schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
            method: "POST",
            rawPath: route.rawPath,
            operation: route.operation,
            bodySha256: remoteWorkerProtocolBodySha256(body),
            nonce,
            timestamp: h.now.toISOString(),
            idempotencyKey,
            authorityKind: "credential",
            authorityId: h.credentialId,
            authorityGeneration: h.credentialGeneration,
            workerGeneration: h.workerGeneration,
            tlsExporterSha256: transportIdentity.tlsExporterSha256,
            clientCertificateSha256: transportIdentity.certificateDerSha256,
            workerPublicKeySpkiSha256: h.publicKeySpkiSha256,
          }),
        )
      : Buffer.from(
          canonicalJsonString(
            buildRemoteWorkerPopMaterial({
              rawPath: route.rawPath,
              bodySha256: remoteWorkerProtocolBodySha256(body),
              operation: route.operation,
              nonce,
              timestamp: h.now.toISOString(),
              idempotencyKey,
              authorityId: h.credentialId,
              authorityGeneration: h.credentialGeneration,
              transportIdentity,
            }),
          ),
          "utf8",
        );
  const proof = sign(null, signedBytes, h.privateKey).toString("base64url");
  return Object.freeze({
    method: "POST",
    rawPath: route.rawPath,
    headers: Object.freeze({
      authorization: `Bearer ${credentialSecret}`,
      "idempotency-key": idempotencyKey,
      "x-goatcitadel-worker-nonce": nonce,
      "x-goatcitadel-worker-operation": route.operation,
      "x-goatcitadel-worker-proof": proof,
      "x-goatcitadel-worker-timestamp": h.now.toISOString(),
    }),
    body,
    transportIdentity,
  });
}

function transport(h: Harness, seed: number): RemoteWorkerTransportIdentity {
  const tlsExporter = Buffer.alloc(32, (seed % 250) + 1);
  return Object.freeze({
    source: "native_mtls",
    certificateDerSha256: h.clientCertificateSha256,
    publicKeySpkiSha256: h.publicKeySpkiSha256,
    trustAnchorDerSha256: h.trustAnchorSha256,
    tlsExporterSha256: D(tlsExporter),
    tlsExporter,
  });
}

function commonPayload(h: Harness, schemaVersion: string, overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion,
    registryWorkspaceId: "default",
    assignmentId: h.assignmentId,
    assignmentGeneration: 1,
    leaseRevision: 1,
    leaseToken: h.leaseToken,
    ...overrides,
  };
}

function token(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest().toString("base64url");
}

function event(
  sequence: number,
  previousEventSha256: string,
  workerSentThrough: number,
): RemoteWorkerAssignmentEventInput {
  return {
    sequence,
    eventId: `event-${sequence}`,
    eventType: "status",
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
      phase: "running",
      statusSha256: D(`status-${sequence}`),
    },
    previousEventSha256,
    workerSentThrough,
  };
}

function storeWithSettlementResponseLoss(
  assignments: RemoteWorkerAssignmentRepository,
): RemoteWorkerAssignmentProtocolStorePort {
  let loseResponse = true;
  return {
    resolveActiveAuthorityByLeaseTokenHash: (hash) => assignments.resolveActiveAuthorityByLeaseTokenHash(hash),
    resolveControlReadAuthorityByLeaseTokenHash: (input) =>
      assignments.resolveControlReadAuthorityByLeaseTokenHash(input),
    findAssignmentAggregate: (workspaceId, assignmentId) =>
      assignments.findAssignmentAggregate(workspaceId, assignmentId),
    renewLease: (input) => assignments.renewLease(input),
    appendEvents: (input) => assignments.appendEvents(input),
    settleAssignment: (input) => {
      const outcome = assignments.settleAssignment(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("simulated response loss after commit");
      }
      return outcome;
    },
  };
}

describe("RemoteWorkerAssignmentProtocolService", () => {
  it("requires protected PoP-v2 and rejects the legacy proof before durable nonce consumption", async () => {
    const h = createHarness("protected-v2");
    const consume = vi.fn((input: Parameters<RemoteWorkerNonceRepository["consume"]>[0]) => h.nonces.consume(input));
    const resolveMesh = vi.fn(
      (input: Parameters<RemoteWorkerAssignmentMeshAuthorityPort["resolveCurrentForRuntimeCredential"]>[0]) =>
        meshAuthorityFor(h, input),
    );
    const service = new RemoteWorkerAssignmentProtocolService({
      credentialAuthority: {
        resolveByCredentialTokenSha256: (credentialTokenSha256) => authorityFor(h, credentialTokenSha256),
      },
      meshAdmissions: {
        resolveCurrentForRuntimeCredential: resolveMesh,
      },
      nonceConsumer: { consume },
      assignments: h.assignments,
      clock: () => new Date(h.now),
    });
    const payload = commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION);

    await expect(
      service.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync, payload, {
          proofVersion: "legacy_v1",
          nonce: token("protected-v2:legacy-nonce"),
        }),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_WORKER_ASSIGNMENT_RPC_REJECTED" });
    expect(consume).not.toHaveBeenCalled();
    expect(resolveMesh).not.toHaveBeenCalled();

    await expect(
      service.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync, payload, {
          nonce: token("protected-v2:v2-nonce"),
        }),
      ),
    ).resolves.toMatchObject({ disposition: "synchronized" });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(resolveMesh).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: h.credentialId,
        authorizationCredentialSha256: D(h.credentialSecret),
        workspaceId: "default",
        nodeId: h.nodeId,
      }),
    );
    expect(JSON.stringify(resolveMesh.mock.calls)).not.toContain(h.credentialSecret);
  });

  it("syncs an exact active authority and rejects nonce replay plus credential/workspace/capability/generation/token drift", async () => {
    const h = createHarness("sync");
    const service = createService(h);
    const request = rpcRequest(
      h,
      REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
      commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
      { idempotencyKey: "sync:exact", nonce: token("sync:nonce") },
    );

    await expect(service.execute(request)).resolves.toMatchObject({
      disposition: "synchronized",
      operation: "assignment.sync",
      generation: { assignmentGeneration: 1, workerId: h.workerId },
      lease: { leaseRevision: 1 },
    });
    await expect(service.execute(request)).rejects.toMatchObject({ code: "REMOTE_WORKER_ASSIGNMENT_RPC_REJECTED" });

    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
          {
            credentialSecret: token("wrong-credential"),
          },
        ),
      ),
    ).rejects.toBeDefined();

    const staleMeshService = createService(h, {
      meshAdmissions: {
        resolveCurrentForRuntimeCredential: (input) => ({
          ...meshAuthorityFor(h, input),
          admissionGeneration: h.nodeAdmissionGeneration + 1,
        }),
      },
    });
    await expect(
      staleMeshService.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
        ),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_WORKER_ASSIGNMENT_RPC_REJECTED" });
    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION, { registryWorkspaceId: "other" }),
        ),
      ),
    ).rejects.toBeDefined();

    const capabilityService = createService(h, {
      authorityTransform: (authority) => {
        const claims = buildRemoteWorkerRuntimeCredentialClaims({
          registryWorkspaceId: authority.registryWorkspaceId,
          workerId: authority.workerId,
          workerGeneration: authority.workerGeneration,
          allowedWorkspaceIds: ["default"],
          capabilityClasses: ["durable_compute"],
        });
        return {
          ...authority,
          claims,
          claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
          capabilityCeilingSha256: claims.capabilityCeilingSha256,
        };
      },
    });
    await expect(
      capabilityService.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
        ),
      ),
    ).rejects.toBeDefined();

    const generationService = createService(h, {
      authorityTransform: (authority) => {
        const claims = buildRemoteWorkerRuntimeCredentialClaims({
          registryWorkspaceId: authority.registryWorkspaceId,
          workerId: authority.workerId,
          workerGeneration: authority.workerGeneration + 1,
          allowedWorkspaceIds: [...authority.claims.allowedWorkspaceIds],
          capabilityClasses: [...authority.claims.capabilityClasses],
        });
        return {
          ...authority,
          workerGeneration: authority.workerGeneration + 1,
          claims,
          claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
        };
      },
    });
    await expect(
      generationService.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION, { assignmentGeneration: 2 }),
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION, { leaseToken: token("wrong-lease") }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("renews with a worker-proposed token, exactly replays response loss, and fences stale callbacks", async () => {
    const h = createHarness("renew");
    const service = createService(h);
    const nextLeaseToken = token("renew:lease:2");
    const payload = {
      ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_LEASE_RENEWAL_SCHEMA_VERSION),
      nextLeaseToken,
      workerSentThrough: 0,
    };
    const first = await service.execute(
      rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.renewLease, payload, { idempotencyKey: "renew:exact" }),
    );
    expect(first).toMatchObject({ disposition: "renewed", lease: { leaseRevision: 2 } });
    expect(JSON.stringify(first)).not.toContain(nextLeaseToken);

    const replay = await service.execute(
      rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.renewLease, payload, { idempotencyKey: "renew:exact" }),
    );
    expect(replay).toMatchObject({ disposition: "replayed_without_lease_secret", lease: { leaseRevision: 2 } });
    await expect(
      service.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents, {
          ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION),
          events: [event(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 1)],
        }),
      ),
    ).rejects.toBeDefined();

    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION, {
            leaseRevision: 2,
            leaseToken: nextLeaseToken,
          }),
        ),
      ),
    ).resolves.toMatchObject({ disposition: "synchronized", lease: { leaseRevision: 2 } });
    const leaseRows = h.db.prepare("SELECT lease_token_sha256 FROM remote_worker_assignment_leases").all() as Array<{
      lease_token_sha256: string;
    }>;
    const credentialRows = h.db.prepare("SELECT token_sha256 FROM remote_worker_runtime_credentials").all() as Array<{
      token_sha256: string;
    }>;
    expect(leaseRows.map((row) => row.lease_token_sha256)).toContain(D(nextLeaseToken));
    expect(JSON.stringify({ leaseRows, credentialRows })).not.toContain(nextLeaseToken);
    expect(JSON.stringify({ leaseRows, credentialRows })).not.toContain(h.credentialSecret);
  });

  it("appends ordered events with replay acknowledgements, partial replay, and canonical backpressure", async () => {
    const h = createHarness("events");
    const service = createService(h);
    const firstEvent = event(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 4);
    const firstPayload = {
      ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION),
      events: [firstEvent],
    };
    await expect(
      service.execute(rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents, firstPayload)),
    ).resolves.toMatchObject({
      disposition: "appended",
      acknowledgedThrough: 1,
      workerSentThrough: 4,
      pendingCount: 3,
      flowControl: { action: "pause", replayCursor: 1 },
    });
    await expect(
      service.execute(rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents, firstPayload)),
    ).resolves.toMatchObject({ disposition: "replayed", acknowledgedThrough: 1 });

    const firstRecord = h.assignments.listEventsAfter("default", h.assignmentId, 1, 0, 10)[0]!;
    const secondEvent = event(2, firstRecord.eventSha256, 4);
    await expect(
      service.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents, {
          ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION),
          events: [firstEvent, secondEvent],
        }),
      ),
    ).resolves.toMatchObject({
      disposition: "partially_replayed",
      acknowledgedThrough: 2,
      pendingCount: 2,
      flowControl: { action: "continue" },
    });
    await expect(
      service.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents, {
          ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION),
          events: [event(4, D("gap"), 4)],
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      service.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents, {
          ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION),
          events: [event(3, D("wrong-chain"), 4)],
        }),
      ),
    ).rejects.toBeDefined();
    expect(h.assignments.listEventsAfter("default", h.assignmentId, 1, 0, 10)).toHaveLength(2);
  });

  it("shows cancellation and exactly replays worker settlement after a post-commit response loss", async () => {
    const h = createHarness("settlement");
    h.assignments.requestCancellation({
      registryWorkspaceId: "default",
      assignmentId: h.assignmentId,
      expectedAssignmentGeneration: 1,
      expectedLeaseRevision: 1,
      reasonCode: "operator.cancelled",
      reasonSha256: D("settlement:cancel"),
      actorId: "operator-a",
      idempotencyKey: "settlement:control",
    });
    const service = createService(h);
    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.readControl,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_CONTROL_READ_SCHEMA_VERSION),
        ),
      ),
    ).resolves.toMatchObject({
      disposition: "cancel_requested",
      assignmentId: h.assignmentId,
      control: { action: "cancel_requested" },
    });

    const lossyService = createService(h, { assignments: storeWithSettlementResponseLoss(h.assignments) });
    const settlementPayload = {
      ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_WORKER_SETTLEMENT_SCHEMA_VERSION),
      outcome: "cancelled",
      finalEventSequence: 0,
      finalEventSha256: REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256,
    };
    await expect(
      lossyService.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.settle, settlementPayload, {
          idempotencyKey: "settlement:worker",
        }),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_WORKER_ASSIGNMENT_RPC_REJECTED" });
    const replay = await lossyService.execute(
      rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.settle, settlementPayload, {
        idempotencyKey: "settlement:worker",
      }),
    );
    expect(replay).toMatchObject({ disposition: "replayed", settlement: { outcome: "cancelled", origin: "worker" } });
    expect(JSON.stringify(replay)).not.toContain(h.leaseToken);
    expect(JSON.stringify(replay)).not.toContain(h.credentialSecret);
    const settled = h.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_assignment_settlements").get() as {
      count: number;
    };
    expect(Number(settled.count)).toBe(1);
  });

  it("rejects unknown fields and byte-limit abuse before credential or nonce ports", async () => {
    const h = createHarness("normalization");
    const resolve = vi.fn((hash: string) => authorityFor(h, hash));
    const consume = vi.fn((input: Parameters<RemoteWorkerNonceRepository["consume"]>[0]) => h.nonces.consume(input));
    const service = new RemoteWorkerAssignmentProtocolService({
      credentialAuthority: { resolveByCredentialTokenSha256: resolve },
      meshAdmissions: {
        resolveCurrentForRuntimeCredential: (input) => meshAuthorityFor(h, input),
      },
      nonceConsumer: { consume },
      assignments: h.assignments,
      clock: () => new Date(h.now),
    });
    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION, { unexpected: "field" }),
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION, { leaseToken: "not-32-bytes" }),
        ),
      ),
    ).rejects.toBeDefined();
    const oversizedEvent = {
      ...event(1, REMOTE_WORKER_ASSIGNMENT_EVENT_GENESIS_SHA256, 1),
      eventType: "transcript_delta",
      payload: {
        schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION,
        role: "assistant",
        text: "x".repeat(270 * 1024),
      },
    };
    await expect(
      service.execute(
        rpcRequest(h, REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.appendEvents, {
          ...commonPayload(h, REMOTE_WORKER_ASSIGNMENT_EVENT_APPEND_SCHEMA_VERSION),
          events: [oversizedEvent],
        }),
      ),
    ).rejects.toBeDefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed request arrays without evaluating the accessor", async () => {
    const h = createHarness("request-accessor");
    const service = createService(h);
    const valid = rpcRequest(
      h,
      REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
      commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
    );
    const payloadAccessor = vi.fn(() => "unexpected");
    const payload: unknown[] = [];
    Object.defineProperty(payload, "0", {
      enumerable: true,
      get: payloadAccessor,
    });

    await expect(service.execute({ ...valid, body: { ...valid.body, payload } })).rejects.toMatchObject({
      code: "REMOTE_WORKER_ASSIGNMENT_RPC_REJECTED",
    });
    expect(payloadAccessor).not.toHaveBeenCalled();
  });

  it("rejects accessor-backed credential claims without evaluating the accessor", async () => {
    const h = createHarness("claim-accessor");
    const capabilityAccessor = vi.fn(() => "durable_compute");
    const service = createService(h, {
      authorityTransform: (authority) => {
        const capabilityClasses: string[] = [];
        Object.defineProperty(capabilityClasses, "0", {
          enumerable: true,
          get: capabilityAccessor,
        });
        return {
          ...authority,
          claims: {
            ...authority.claims,
            capabilityClasses,
          },
        };
      },
    });

    await expect(
      service.execute(
        rpcRequest(
          h,
          REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES.sync,
          commonPayload(h, REMOTE_WORKER_ASSIGNMENT_SYNC_SCHEMA_VERSION),
        ),
      ),
    ).rejects.toMatchObject({ code: "REMOTE_WORKER_ASSIGNMENT_RPC_REJECTED" });
    expect(capabilityAccessor).not.toHaveBeenCalled();
  });
});

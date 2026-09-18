import { backingCapacityObservationFixture } from "../../../../packages/contracts/src/remote-worker-cell-backing-capacity-test-fixture.js";
import { nativeArtifactFixture } from "../../../../packages/contracts/src/remote-worker-native-artifact-test-fixture.js";
import { remoteWorkerNativeFileReceiptSha256 } from "@goatcitadel/contracts";
import { windowsRuntimeDispatchFixture } from "../../../remote-worker/src/worker-windows-runtime-dispatch-test-fixture.js";
import { prepareWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import { objectInventoryFixture, objectInventoryHistoryFixture } from "../../../../packages/contracts/src/remote-worker-cell-object-inventory-test-fixture.js";
import { REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION } from "@goatcitadel/contracts";
import { REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA } from "@goatcitadel/contracts";
import { REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA, remoteWorkerRuntimeOutputEvidenceSha256 } from "@goatcitadel/contracts";
import { REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION, type RemoteWorkerRuntimeResultExchange } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerCellBackingCapacityExchange, REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION,
  type RemoteWorkerCellBackingCapacityExchange } from "@goatcitadel/contracts";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
  remoteWorkerCellProvisioningPlanSha256,
  buildRemoteWorkerPopV2Preimage,
  buildRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  remoteWorkerInferenceUsageEventIdsSha256,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentLeaseRecord,
  type RemoteWorkerAssignmentRecord,
  type RemoteWorkerInferenceRequestSubmission,
} from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerAssignmentMeshAuthorityPort } from "./remote-worker-assignment-protocol-service.js";
import {
  REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES,
  REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  RemoteWorkerAssignmentExecutionProtocolError,
  RemoteWorkerAssignmentExecutionProtocolService,
  type RemoteWorkerAssignmentExecutionProtocolDependencies,
  type RemoteWorkerAssignmentExecutionProtocolRequest,
} from "./remote-worker-assignment-execution-protocol-service.js";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";
import {
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  type RemoteWorkerProtocolBody,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";
import { checkpointFixture } from "../../../../packages/storage/src/remote-worker-cell-checkpoint-test-helpers.js";
import { volumeExchangeFixture } from "../../../../packages/contracts/src/remote-worker-cell-volume-test-fixture.js";
import { formatExchangeFixture } from "../../../../packages/contracts/src/remote-worker-cell-format-test-fixture.js";
import { protectionExchangeFixture } from "../../../../packages/contracts/src/remote-worker-cell-protection-test-fixture.js";
import { mountExchangeFixture } from "../../../../packages/contracts/src/remote-worker-cell-mount-test-fixture.js";
import { mountedWorkspaceExchangeFixture } from "../../../../packages/contracts/src/remote-worker-cell-mounted-workspace-test-fixture.js";
import { capacityObservationFixture } from "../../../../packages/contracts/src/remote-worker-cell-capacity-test-fixture.js";
import { normalizeRemoteWorkerCellCapacityExchange, REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT, type RemoteWorkerCellCapacityExchange } from "@goatcitadel/contracts";

type ExecutionRoute =
  (typeof REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES)[keyof typeof REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES];

const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const NOW = new Date("2026-08-11T20:00:00.000Z");
const NODE_ADMISSION_GENERATION = 2;
let sequence = 0;

interface Fixture {
  readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
  readonly credentialSecret: string;
  readonly privateKey: KeyObject;
  readonly assignment: RemoteWorkerAssignmentRecord;
  readonly generation: RemoteWorkerAssignmentGenerationRecord;
  readonly lease: RemoteWorkerAssignmentLeaseRecord;
  readonly rawLeaseToken: string;
}

beforeEach(() => {
  sequence = 0;
});

function fixture(): Fixture {
  const pair = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = pair.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKeySpkiDer)) throw new Error("test key unavailable");
  const claims = buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    workerGeneration: 4,
    allowedWorkspaceIds: ["registry-a", "workspace-a"],
    capabilityClasses: ["durable_compute"],
  });
  const credentialSecret = token("credential");
  const authority = Object.freeze({
    credentialId: "credential-a",
    credentialGeneration: 5,
    authorizationCredentialSha256: D(credentialSecret),
    registryWorkspaceId: "registry-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    workerGeneration: 4,
    nodeId: "node-a",
    publicKeySpkiDer,
    publicKeySpkiSha256: D(publicKeySpkiDer),
    clientCertificateSha256: D("certificate-a"),
    transportTrustAnchorSha256: D("trust-anchor-a"),
    runtimeManifestSha256: D("runtime-manifest-a"),
    workspaceCeilingSha256: claims.workspaceCeilingSha256,
    capabilityCeilingSha256: claims.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
    protectedAdmissionContextSha256: D("protected-context-a"),
    claims,
    claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
  }) satisfies CurrentRemoteWorkerRuntimeCredentialAuthority;
  const assignment: RemoteWorkerAssignmentRecord = Object.freeze({
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    manifest: Object.freeze({
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_MANIFEST_SCHEMA_VERSION,
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      registryWorkspaceId: "registry-a",
      executionWorkspaceId: "workspace-a",
      durableRunId: "run-a",
      taskId: "task-a",
      sessionId: "session-a",
      turnId: "turn-a",
      capabilityProfileSha256: D("profile-a"),
      contextSnapshotSha256: D("context-a"),
      toolEffectPostureSha256: D("posture-a"),
      pathJailSha256: D("path-jail-a"),
      parentContextSha256: D("parent-a"),
      requiredCapabilityClasses: Object.freeze(["durable_compute"]),
      deadlineAt: "2099-01-01T00:00:00.000Z",
      leaseTtlSeconds: 300,
      maxEventCount: 100,
      maxEventBytes: 4096,
      eventLowWatermark: 2,
      eventHighWatermark: 5,
      maxOutputBytes: 65_536,
      maxArtifactBytes: 1_048_576,
    }),
    manifestSha256: D("assignment-manifest-a"),
    createdByActorId: "gateway-a",
    idempotencyKey: "assignment-create-a",
    requestSha256: D("assignment-request-a"),
    createdAt: NOW.toISOString(),
  });
  const generation = Object.freeze({
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    executionWorkspaceId: "workspace-a",
    workerId: "worker-a",
    workerGeneration: 4,
    nodeId: "node-a",
    nodeAdmissionGeneration: NODE_ADMISSION_GENERATION,
    runtimeManifestSha256: authority.runtimeManifestSha256,
    workspaceCeilingSha256: authority.workspaceCeilingSha256,
    capabilityCeilingSha256: authority.capabilityCeilingSha256,
    dispatchAuthority: Object.freeze({
      schemaVersion: "goatcitadel.remote-worker-assignment-dispatch-authority.v1",
      durableRunId: "run-a",
      durableRunAttempt: 1,
      dispatchOwnerId: "gateway-a",
      durableRunVersion: 3,
      durableRunLeaseExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    dispatchAuthoritySha256: D("dispatch-authority-a"),
    idempotencyKey: "claim-a",
    requestSha256: D("claim-request-a"),
    startedAt: NOW.toISOString(),
  }) satisfies RemoteWorkerAssignmentGenerationRecord;
  const lease = Object.freeze({
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    leaseRevision: 1,
    workerSentThrough: 0,
    serverAcknowledgedThrough: 0,
    parentDispatchAuthority: generation.dispatchAuthority,
    parentDispatchAuthoritySha256: generation.dispatchAuthoritySha256,
    heartbeatAt: NOW.toISOString(),
    expiresAt: "2099-01-01T00:05:00.000Z",
    idempotencyKey: "claim-a",
    requestSha256: D("lease-request-a"),
  }) satisfies RemoteWorkerAssignmentLeaseRecord;
  return {
    authority,
    credentialSecret,
    privateKey: pair.privateKey,
    assignment,
    generation,
    lease,
    rawLeaseToken: token("lease"),
  };
}

/**
 * A realistic stored request record: the projection MUST drop every
 * server-internal budget/policy/route field below.
 */
function inferenceRequestRecord() {
  return {
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    inferenceRequestId: "inference-a",
    attempt: 1,
    workerId: "worker-a",
    workerGeneration: 4,
    sessionId: "session-a",
    turnId: "turn-a",
    idempotencyKey: "inference-idem-a",
    requestBodyJson: "{}",
    requestSha256: D("request-a"),
    inputSha256: D("input-a"),
    contextSha256: D("context-a"),
    modelIntentSha256: D("model-intent-a"),
    capabilityProfileSha256: D("profile-a"),
    routedContextSha256: D("routed-context-a"),
    outputTokenCeiling: 256,
    reasoningTokenCeiling: 0,
    temperatureMilli: 0,
    operationId: "operation-a",
    dispatchGeneration: "dispatch-a",
    state: "delivered",
    governanceDecision: "allowed",
    effectiveRouteSha256: D("route-a"),
    policyRevision: 7,
    policySha256: D("policy-a"),
    governanceOutputTokenCeiling: 256,
    governanceReasoningTokenCeiling: 0,
    governanceExpiresAt: "2099-01-01T00:00:00.000Z",
    effectiveRouteJson: '{"credentialConfigFingerprint":"NEVER-RETURN-THIS","inputRateUsdPerMillion":1}',
    budgetReservationId: "NEVER-RETURN-THIS-RESERVATION",
    budgetOperationJson: '{"secret":"NEVER-RETURN-THIS"}',
    dispatchClaimOwner: "NEVER-RETURN-THIS-OWNER",
    usageEventIdsJson: canonicalJsonString(["usage-retry-a", "usage-a"]),
    usageEventIdsSha256: remoteWorkerInferenceUsageEventIdsSha256(["usage-retry-a", "usage-a"]),
  };
}

function inferenceFrameRecord() {
  return {
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    inferenceRequestId: "inference-a",
    attempt: 1,
    frameSequence: 1,
    frameKind: "output_text",
    payloadJson: '{"kind":"output_text","text":"hello"}',
    payloadSha256: D("payload-a"),
    previousFrameSha256: D("previous-a"),
    frameSha256: D("frame-a"),
    effectiveRouteSha256: D("route-a"),
    usageEventId: "usage-a",
    frameCharCount: 5,
    createdAt: NOW.toISOString(),
  };
}

function dependencies(f: Fixture) {
  const seenNonces = new Set<string>();
  const nonceInputs: unknown[] = [];
  const fences: unknown[] = [];
  const credentialAuthority = {
    resolveByCredentialTokenSha256: vi.fn(async (value: string) =>
      value === f.authority.authorizationCredentialSha256 ? f.authority : undefined,
    ),
  };
  const meshAdmissions = {
    resolveCurrentForRuntimeCredential: vi.fn(
      (input: Parameters<RemoteWorkerAssignmentMeshAuthorityPort["resolveCurrentForRuntimeCredential"]>[0]) =>
        Object.freeze({
          schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
          registryWorkspaceId: input.registryWorkspaceId,
          bootstrapId: input.bootstrapId,
          workerId: input.workerId,
          workerGeneration: input.workerGeneration,
          credentialId: input.credentialId,
          credentialGeneration: input.credentialGeneration,
          workspaceId: input.workspaceId,
          nodeId: input.nodeId,
          admissionGeneration: NODE_ADMISSION_GENERATION,
          joinAuthorityGeneration: 1,
          joinCredentialSha256: D("mesh-join-a"),
          protectedAdmissionEnvelopeSha256: input.protectedAdmissionEnvelopeSha256,
          protectedAdmissionContextSha256: input.protectedAdmissionContextSha256,
        }),
    ),
  };
  const assignments = {
    findAssignmentAggregate: vi.fn(async () => ({ assignment: f.assignment, generation: f.generation })),
    resolveActiveAuthorityByLeaseTokenHash: vi.fn(async (leaseTokenSha256: string, fence: unknown) => {
      fences.push(fence);
      return leaseTokenSha256 === D(f.rawLeaseToken)
        ? { assignment: f.assignment, generation: f.generation, lease: f.lease }
        : undefined;
    }),
  };
  const inference = {
    performInference: vi.fn(async () => ({
      disposition: "delivered" as const,
      request: Object.freeze(inferenceRequestRecord()),
      frames: Object.freeze([inferenceFrameRecord()]),
    })),
  };
  const settlement = {
    artifacts: {
      openUpload: vi.fn(async () => ({ uploadId: "upload-a", uploadState: "open", uploadRevision: 1 })),
      appendPart: vi.fn(async () => ({ uploadId: "upload-a", uploadState: "open", uploadRevision: 2 })),
      commitArtifact: vi.fn(async () => ({ uploadId: "upload-a", uploadState: "committed", uploadRevision: 3 })),
    },
    effects: {
      dispatchEffect: vi.fn(async () => ({
        intentId: "intent-a",
        transitions: [],
        receipt: { receiptId: "receipt-a" },
      })),
    },
  };
  const nonceConsumer = {
    consume: vi.fn(async (input: { readonly nonceSha256: string }) => {
      nonceInputs.push(input);
      if (seenNonces.has(input.nonceSha256)) return false;
      seenNonces.add(input.nonceSha256);
      return true;
    }),
  };
  const value = {
    credentialAuthority,
    nonceConsumer,
    meshAdmissions,
    assignments,
    inference,
    settlement,
    clock: () => new Date(NOW),
  } as unknown as RemoteWorkerAssignmentExecutionProtocolDependencies;
  return {
    ...(value as object),
    credentialAuthority,
    nonceConsumer,
    meshAdmissions,
    assignments,
    inference,
    settlement,
    fences,
    nonceInputs,
  } as unknown as RemoteWorkerAssignmentExecutionProtocolDependencies & {
    readonly credentialAuthority: typeof credentialAuthority;
    readonly nonceConsumer: typeof nonceConsumer;
    readonly meshAdmissions: typeof meshAdmissions;
    readonly assignments: typeof assignments;
    readonly inference: typeof inference;
    readonly settlement: typeof settlement;
    readonly fences: unknown[];
    readonly nonceInputs: unknown[];
  };
}

function service(
  f: Fixture,
  deps: ReturnType<typeof dependencies> = dependencies(f),
): RemoteWorkerAssignmentExecutionProtocolService {
  return new RemoteWorkerAssignmentExecutionProtocolService(deps);
}

function submission(f: Fixture, overrides: Record<string, unknown> = {}): RemoteWorkerInferenceRequestSubmission {
  return {
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    inferenceRequestId: "inference-a",
    attempt: 1,
    idempotencyKey: "inference-idem-a",
    leaseToken: f.rawLeaseToken,
    messages: [{ role: "user", text: "Do work" }],
    inputSha256: D("input-a"),
    contextSha256: D("context-a"),
    modelIntentSha256: D("model-intent-a"),
    outputTokenCeiling: 256,
    reasoningTokenCeiling: 0,
    temperatureMilli: 0,
    ...overrides,
  } as RemoteWorkerInferenceRequestSubmission;
}

function inferencePayload(f: Fixture, overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION,
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    submission: submission(f),
    ...overrides,
  };
}

function settlementPayload(f: Fixture, submissionValue: object, overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
    registryWorkspaceId: "registry-a",
    assignmentId: "assignment-a",
    assignmentGeneration: 1,
    leaseRevision: 1,
    leaseToken: f.rawLeaseToken,
    submission: submissionValue,
    ...overrides,
  };
}

function artifactManifest(f: Fixture, identityOverrides: Record<string, unknown> = {}): RemoteWorkerArtifactManifest {
  const logicalPath = "dir/file.bin";
  return {
    schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    identity: {
      registryWorkspaceId: "registry-a",
      executionWorkspaceId: "workspace-a",
      assignmentId: "assignment-a",
      assignmentGeneration: 1,
      workerId: "worker-a",
      workerGeneration: 4,
      runtimeManifestSha256: f.authority.runtimeManifestSha256,
      workspaceCeilingSha256: f.authority.workspaceCeilingSha256,
      capabilityCeilingSha256: f.authority.capabilityCeilingSha256,
      assignmentManifestSha256: f.assignment.manifestSha256,
      ...identityOverrides,
    },
    pathJailSha256: D("path-jail-a"),
    workerClaimIds: [],
    workerClaimSha256: D("claims-a"),
    requiredVerifierProfileSha256: null,
    fileCount: 1,
    totalBytes: 5,
    entries: [
      {
        entryIndex: 0,
        logicalPath,
        logicalPathSha256: D(canonicalJsonString({ logicalPath })),
        blobSha256: D("blob-a"),
        byteCount: 5,
        mimeType: "application/octet-stream",
      },
    ],
  };
}

function signedRequest(
  f: Fixture,
  route: ExecutionRoute,
  payload: object,
  options: {
    readonly nonce?: string;
    readonly idempotencyKey?: string;
    readonly proofVersion?: "v1" | "v2";
    readonly signedRoute?: ExecutionRoute;
  } = {},
): RemoteWorkerAssignmentExecutionProtocolRequest {
  sequence += 1;
  const nonce = options.nonce ?? token(`nonce:${String(sequence)}`);
  const idempotencyKey = options.idempotencyKey ?? `execution:${String(sequence)}`;
  const transportIdentity = transport(f, sequence);
  const body: RemoteWorkerProtocolBody = Object.freeze(
    options.proofVersion === "v1"
      ? {
          schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
          operation: route.operation,
          authorityId: f.authority.credentialId,
          authorityGeneration: f.authority.credentialGeneration,
          idempotencyKey,
          payload: payload as RemoteWorkerProtocolBody["payload"],
        }
      : {
          schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
          operation: route.operation,
          authorityId: f.authority.credentialId,
          authorityGeneration: f.authority.credentialGeneration,
          workerGeneration: f.authority.workerGeneration,
          idempotencyKey,
          payload: payload as RemoteWorkerProtocolBody["payload"],
        },
  );
  const signedRoute = options.signedRoute ?? route;
  const bytes =
    body.schemaVersion === REMOTE_WORKER_POP_V2_SCHEMA_VERSION
      ? Buffer.from(
          buildRemoteWorkerPopV2Preimage({
            schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
            method: "POST",
            rawPath: signedRoute.rawPath,
            operation: signedRoute.operation,
            bodySha256: remoteWorkerProtocolBodySha256(body),
            nonce,
            timestamp: NOW.toISOString(),
            idempotencyKey,
            authorityKind: "credential",
            authorityId: f.authority.credentialId,
            authorityGeneration: f.authority.credentialGeneration,
            workerGeneration: f.authority.workerGeneration,
            tlsExporterSha256: transportIdentity.tlsExporterSha256,
            clientCertificateSha256: transportIdentity.certificateDerSha256,
            workerPublicKeySpkiSha256: f.authority.publicKeySpkiSha256,
          }),
        )
      : Buffer.from(
          canonicalJsonString(
            buildRemoteWorkerPopMaterial({
              rawPath: route.rawPath,
              bodySha256: remoteWorkerProtocolBodySha256(body),
              operation: route.operation,
              nonce,
              timestamp: NOW.toISOString(),
              idempotencyKey,
              authorityId: f.authority.credentialId,
              authorityGeneration: f.authority.credentialGeneration,
              transportIdentity,
            }),
          ),
          "utf8",
        );
  return Object.freeze({
    method: "POST",
    rawPath: route.rawPath,
    headers: Object.freeze({
      authorization: `Bearer ${f.credentialSecret}`,
      "idempotency-key": idempotencyKey,
      "x-goatcitadel-worker-nonce": nonce,
      "x-goatcitadel-worker-operation": route.operation,
      "x-goatcitadel-worker-proof": sign(null, bytes, f.privateKey).toString("base64url"),
      "x-goatcitadel-worker-timestamp": NOW.toISOString(),
    }),
    body,
    transportIdentity,
  });
}

function transport(f: Fixture, seed: number): RemoteWorkerTransportIdentity {
  const tlsExporter = Buffer.alloc(32, (seed % 250) + 1);
  return Object.freeze({
    source: "native_mtls",
    certificateDerSha256: f.authority.clientCertificateSha256,
    publicKeySpkiSha256: f.authority.publicKeySpkiSha256,
    trustAnchorDerSha256: f.authority.transportTrustAnchorSha256,
    tlsExporterSha256: D(tlsExporter),
    tlsExporter,
  });
}

function token(value: string): string {
  return createHash("sha256").update(value).digest().toString("base64url");
}

describe("RemoteWorkerAssignmentExecutionProtocolService", () => {
  function cellExchangeFixture() {
    const plan = { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_PLAN_SCHEMA_VERSION,
      assignmentBindingSha256: D("cell-binding"), profileSha256: D("cell-profile"),
      parentIdentityHex: "0100000000000000" + "1".repeat(32), cellName: `gc-cell-${"1".repeat(32)}`,
      ownerSid: "S-1-5-18", controllerSid: "S-1-5-80-1-2-3-4-5", diskIdentifierHex: "3".repeat(32),
      virtualDiskBytes: 16 * 1024 * 1024, reservedDiskBytes: 80 * 1024 * 1024 } as const;
    return { schemaVersion: REMOTE_WORKER_CELL_PROVISIONING_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1, leaseRevision: 1,
      plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records: [checkpointFixture(plan, 1)] };
  }

  it.each(["create_once", "reconcile"] as const)("carries the canonical cell preparation decision %s without granting worker policy fields", async (decision) => {
    const f = fixture(), deps = dependencies(f);
    const exchange = { ...cellExchangeFixture(), records: [] };
    const result = { schemaVersion: "goatcitadel.remote-worker-cell-preparation.v1", decision,
      provisioningExpiresAt: "2099-01-01T00:00:00.000Z", exchange };
    const cellProvisioning = { exchange: vi.fn(), prepare: vi.fn(async () => result) };
    Object.assign(deps.settlement, { cellProvisioning });
    const submission = { kind: "cell.provisioning.prepare", parentIdentityHex: exchange.plan.parentIdentityHex };
    const request = signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    const response = await service(f, deps).execute(request);
    expect(response).toMatchObject({ disposition: "cell_provisioning_prepared", cellPreparation: result });
    expect(cellProvisioning.prepare).toHaveBeenCalledWith(expect.objectContaining({ submission, leaseRevision: 1,
      leaseTokenSha256: D(f.rawLeaseToken), protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(cellProvisioning.exchange).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toMatch(/protectedAuthority|provisioningOwner|leaseTokenSha256/u);
  });

  it("records native review contact only after signed authority and nonce checks", async () => {
    const f = fixture(), deps = dependencies(f), observe = vi.fn();
    const exchange = cellExchangeFixture();
    Object.assign(deps.settlement, { nativeReviewAuthority: { observe }, cellProvisioning: { exchange: vi.fn(async () => exchange) } });
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, { kind: "cell.provisioning.snapshot" }));
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "invalid" } })).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
    deps.assignments.resolveActiveAuthorityByLeaseTokenHash.mockRejectedValueOnce(new Error("protected fence mismatch"));
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
    const valid = request(); await service(f, deps).execute(valid);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ leaseRevision: 1, leaseTokenSha256: D(f.rawLeaseToken), protectedAuthority: expect.any(Object) }));
    expect(observe.mock.calls[0]![0]).not.toHaveProperty("submission");
    await expect(service(f, deps).execute(valid)).rejects.toThrow();
    expect(observe).toHaveBeenCalledOnce();
  });

  it.each(["policy", "capacity", "profile", "runtimeAttestationSha256", "approved", "provisioningOwner"])(
    "rejects worker-authored preparation %s before consuming a nonce", async (field) => {
      const f = fixture(), deps = dependencies(f);
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { kind: "cell.provisioning.prepare", parentIdentityHex: cellExchangeFixture().plan.parentIdentityHex,
          [field]: "untrusted" })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
      expect(deps.nonceConsumer.consume).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "expired", "foreign", "recorded_create", "before_owner", "after_commit"])(
    "refuses cell creation acknowledgement when %s", async (failure) => {
      const f = fixture(), deps = dependencies(f), cancellation = new AbortController();
      const fixtureExchange = cellExchangeFixture();
      const result = { schemaVersion: "goatcitadel.remote-worker-cell-preparation.v1", decision: "create_once",
        provisioningExpiresAt: failure === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
        exchange: { ...fixtureExchange, assignmentId: failure === "foreign" ? "other" : "assignment-a",
          records: failure === "recorded_create" ? fixtureExchange.records : [] } };
      const prepare = vi.fn(async () => { if (failure === "after_commit") cancellation.abort(); return result; });
      Object.assign(deps.settlement, { cellProvisioning: { exchange: vi.fn(), ...(failure === "missing" ? {} : { prepare }) } });
      if (failure === "before_owner") cancellation.abort();
      const request = signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { kind: "cell.provisioning.prepare", parentIdentityHex: fixtureExchange.plan.parentIdentityHex }));
      await expect(service(f, deps).execute({ ...request, signal: cancellation.signal })).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
      expect(prepare).toHaveBeenCalledTimes(["missing", "before_owner"].includes(failure) ? 0 : 1);
    },
  );

  it("routes volume checkpoints under the protected fence and refuses incomplete acknowledgements", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const result = volumeExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const owner = { exchange: vi.fn(async () => result) };
    Object.assign(deps.settlement, { cellProvisioning: owner });
    const selection = { kind: "cell.volume.checkpoint", expectedSequence: 5, recordHex: result.volumeRecords![5] };
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    const response = await service(f, deps).execute(request());
    expect(response).toMatchObject({ disposition: "cell_provisioning_recorded", cellProvisioning: result });
    expect(owner.exchange).toHaveBeenLastCalledWith(expect.objectContaining({ submission: selection,
      leaseTokenSha256: D(f.rawLeaseToken), protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(response)).not.toMatch(/protectedAuthority|provisioningOwner|leaseTokenSha256/u);
    for (const volumeRecords of [[], result.volumeRecords!.slice(0, 5)]) {
      owner.exchange.mockResolvedValueOnce({ ...result, volumeRecords });
      await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    expect(deps.inference.performInference).not.toHaveBeenCalled();
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });

  it("routes format checkpoints under the protected fence and refuses incomplete acknowledgements", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const result = formatExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const owner = { exchange: vi.fn(async () => result) };
    Object.assign(deps.settlement, { cellProvisioning: owner });
    const selection = { kind: "cell.format.checkpoint", expectedSequence: 1, recordHex: result.formatRecords![1] };
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    const response = await service(f, deps).execute(request());
    expect(response).toMatchObject({ disposition: "cell_provisioning_recorded", cellProvisioning: result });
    expect(owner.exchange).toHaveBeenLastCalledWith(expect.objectContaining({ submission: selection,
      leaseTokenSha256: D(f.rawLeaseToken), protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(response)).not.toMatch(/protectedAuthority|provisioningOwner|leaseTokenSha256/u);
    for (const formatRecords of [[], result.formatRecords!.slice(0, 1)]) {
      owner.exchange.mockResolvedValueOnce({ ...result, formatRecords });
      await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    const nonceCount = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ provisioningOwner: "worker" }, { approvalGranted: true }, { expectedSequence: 0 }]) {
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonceCount);
    expect(deps.inference.performInference).not.toHaveBeenCalled();
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });

  it("routes protection checkpoints under current authority and refuses missing acknowledgements", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const result = protectionExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const owner = { exchange: vi.fn(async () => result) };
    Object.assign(deps.settlement, { cellProvisioning: owner });
    const selection = { kind: "cell.protection.checkpoint", expectedSequence: 1, recordHex: result.protectionRecords![1] };
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    const response = await service(f, deps).execute(request());
    expect(response.cellProvisioning).toEqual(result);
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection,
      protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(response)).not.toMatch(/protectedAuthority|provisioningOwner|leaseTokenSha256/u);
    for (const protectionRecords of [[], result.protectionRecords!.slice(0, 1)]) {
      owner.exchange.mockResolvedValueOnce({ ...result, protectionRecords });
      await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    const nonceCount = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ provisioningOwner: "worker" }, { approvalGranted: true }, { expectedSequence: 0 }]) {
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonceCount);
    expect(deps.inference.performInference).not.toHaveBeenCalled();
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });

  it("routes mount checkpoints under current authority and refuses missing acknowledgements", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const result = mountExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const owner = { exchange: vi.fn(async () => result) };
    Object.assign(deps.settlement, { cellProvisioning: owner });
    const selection = { kind: "cell.mount.checkpoint", expectedSequence: 3, recordHex: result.mountRecords![3] };
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    const response = await service(f, deps).execute(request());
    expect(response.cellProvisioning).toEqual(result);
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection,
      protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(response)).not.toMatch(/protectedAuthority|provisioningOwner|leaseTokenSha256/u);
    for (const mountRecords of [[], ...[1, 2, 3].map((length) => result.mountRecords!.slice(0, length))]) {
      owner.exchange.mockResolvedValueOnce({ ...result, mountRecords });
      await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    const nonceCount = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ provisioningOwner: "worker" }, { approvalGranted: true }, { expectedSequence: 0 }]) {
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonceCount);
    expect(deps.inference.performInference).not.toHaveBeenCalled();
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });
  it("delivers selected request pages only through current signed assignment authority", async () => {
    const f = fixture(), deps = dependencies(f), runtime = windowsRuntimeDispatchFixture();
    const selected = { request: runtime, expectation: prepareWindowsRuntimeDispatch(runtime).expectation };
    const owner = { selectAdmittedForAssignment: vi.fn(async () => selected) }; Object.assign(deps.settlement, { runtimeRequests: owner });
    const selection = { kind: "runtime.request.page", offset: 0, nonce: null, requestSha256: null, challenge: "33".repeat(32) };
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_request_page", runtimeRequestPage: { submission: selection, expectation: selected.expectation } });
    expect(owner.selectAdmittedForAssignment).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: "assignment-a", leaseRevision: 1, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.selectAdmittedForAssignment.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ approvalId: "foreign" }, { request: runtime }, { offset: 1 }, { offset: 32768 }, { challenge: "0".repeat(64) }])
      await expect(service(f, deps).execute(request({ ...selection, ...patch }))).rejects.toThrow();
    expect(owner.selectAdmittedForAssignment).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.selectAdmittedForAssignment).toHaveBeenCalledTimes(count);
    owner.selectAdmittedForAssignment.mockRejectedValueOnce(new Error("revoked"));
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    Object.assign(deps.settlement, { runtimeRequests: undefined }); await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("retains native output through signed assignment authority and rejects secrets before dispatch", async () => {
    const f = fixture(), deps = dependencies(f);
    const stream = { bytes: 5, sha256: D("hello"), text: "hello", truncated: false, provenance: "native_stream_local_diagnostic" as const };
    const evidence = { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, nonce: "11".repeat(32), requestSha256: "22".repeat(32), resultSha256: "33".repeat(32),
      streams: { stdout: stream, stderr: { ...stream, bytes: 0, sha256: D(""), text: "" } } };
    const selection = { kind: "runtime.output.retain", evidence };
    const result = { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_RECEIPT_SCHEMA, registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1,
      leaseRevision: 1, nonce: evidence.nonce, requestSha256: evidence.requestSha256, resultSha256: evidence.resultSha256,
      evidenceSha256: remoteWorkerRuntimeOutputEvidenceSha256(evidence), recordedLeaseRevision: 1, recordedAt: "2026-09-15T00:00:00.000Z" };
    const owner = { retain: vi.fn(async () => result) }; Object.assign(deps.settlement, { runtimeOutputs: owner });
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_output", runtimeOutput: result });
    expect(owner.retain).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.retain.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const malformed of [{ ...selection, approved: true }, { ...selection, evidence: { ...evidence, resultSha256: "0".repeat(64) } },
      ...[f.rawLeaseToken, "API_KEY=very-secret-output-value"].map(text => ({ ...selection, evidence: { ...evidence, streams: { ...evidence.streams, stdout: { ...stream, text } } } }))])
      await expect(service(f, deps).execute(request(malformed))).rejects.toThrow();
    expect(owner.retain).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.retain).toHaveBeenCalledTimes(count);
    owner.retain.mockResolvedValueOnce({ ...result, evidenceSha256: "ff".repeat(32) });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    owner.retain.mockRejectedValueOnce(new Error("revoked")); await expect(service(f, deps).execute(request())).rejects.toThrow();
    Object.assign(deps.settlement, { runtimeOutputs: undefined }); await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("checks native file disclosure under signed authority without accepting worker approval claims", async () => {
    const f = fixture(), deps = dependencies(f), native = nativeArtifactFixture();
    const selection = { ...native.receipt.files[0]!.selection, registryWorkspaceId: "registry-a", assignmentId: "assignment-a" };
    const disclosure = { ...native.receipt.disclosure, registryWorkspaceId: selection.registryWorkspaceId, assignmentId: selection.assignmentId };
    const submission = { kind: "runtime.file.authorize", selection, fileStaging: native.receipt.fileStaging, challenge: "11".repeat(32) };
    const owner = { authorizeFile: vi.fn(async () => ({ selection, disclosure })) }; Object.assign(deps.settlement, { nativeFileAuthorization: owner });
    const request = (value: object = submission) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, value));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "native_file_grant", nativeFileGrant: { submission, disclosure, leaseRevision: 1 } });
    expect(owner.authorizeFile).toHaveBeenCalledWith(expect.objectContaining({ selection, fileStaging: native.receipt.fileStaging,
      protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.authorizeFile.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ approved: true }, { approvalId: "foreign" }, { recordHex: "aa" }, { challenge: "0".repeat(64) }])
      await expect(service(f, deps).execute(request({ ...submission, ...patch }))).rejects.toThrow();
    expect(owner.authorizeFile).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.authorizeFile).toHaveBeenCalledTimes(count);
    await expect(service(f, deps).execute(request({ ...submission, selection: { ...selection, assignmentId: "foreign" } }))).rejects.toThrow();
    expect(owner.authorizeFile).toHaveBeenCalledTimes(count);
    owner.authorizeFile.mockResolvedValueOnce({ selection, disclosure: { ...disclosure, nonce: "ff".repeat(32) } });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    owner.authorizeFile.mockRejectedValueOnce(new Error("revoked")); await expect(service(f, deps).execute(request())).rejects.toThrow();
    Object.assign(deps.settlement, { nativeFileAuthorization: undefined }); await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("accepts native declarations and bounded pages only through the signed settlement fence", async () => {
    const f = fixture(), deps = dependencies(f), native = nativeArtifactFixture();
    const declaration = { ...native.receipt, disclosure: { ...native.receipt.disclosure, registryWorkspaceId: "registry-a", assignmentId: "assignment-a" },
      files: native.receipt.files.map(file => ({ ...file, selection: { ...file.selection, registryWorkspaceId: "registry-a", assignmentId: "assignment-a" } })) };
    const transferSha256 = remoteWorkerNativeFileReceiptSha256(declaration);
    const begin = { kind: "runtime.files.begin", declaration }, page = { kind: "runtime.files.page", nonce: declaration.disclosure.nonce,
      requestSha256: declaration.disclosure.requestSha256, transferSha256, fileIndex: 0, pageIndex: 0, bytesHex: "ab".repeat(200 + native.bytes.length) };
    const owner = { begin: vi.fn(async () => ({ declaration, transferSha256, leaseRevision: 1, recordedAt: "2026-09-16T00:00:00.000Z" })),
      append: vi.fn(async () => ({ fileIndex: 0, pageIndex: 0, pageSha256: createHash("sha256").update(Buffer.from(page.bytesHex, "hex")).digest("hex"), leaseRevision: 1, recordedAt: "2026-09-16T00:00:00.000Z" })) };
    Object.assign(deps.settlement, { nativeFileTransfers: owner });
    const request = (submission: object) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request(begin))).toMatchObject({ disposition: "native_file_transfer", nativeFileTransfer: { transferSha256, acceptedPage: null } });
    const response = await service(f, deps).execute(request(page));
    expect(response).toMatchObject({ disposition: "native_file_transfer", nativeFileTransfer: { transferSha256, acceptedPage: { fileIndex: 0, pageIndex: 0 } } });
    expect(JSON.stringify(response)).not.toContain(page.bytesHex);
    expect(owner.append).toHaveBeenCalledWith(expect.objectContaining({ protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const submission of [{ ...begin, approved: true }, { ...page, approvalId: "foreign" }, { ...page, bytesHex: "ab".repeat(32769) }])
      await expect(service(f, deps).execute(request(submission))).rejects.toThrow();
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request(page);
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.append).toHaveBeenCalledOnce();
    owner.begin.mockResolvedValueOnce({ declaration, transferSha256: "ff".repeat(32), leaseRevision: 1, recordedAt: "2026-09-16T00:00:00.000Z" });
    await expect(service(f, deps).execute(request(begin))).rejects.toThrow();
    owner.append.mockRejectedValueOnce(new Error("revoked")); await expect(service(f, deps).execute(request(page))).rejects.toThrow();
    Object.assign(deps.settlement, { nativeFileTransfers: undefined }); await expect(service(f, deps).execute(request(begin))).rejects.toThrow();
  });
  it("reconciles native files only under current signed assignment authority", async () => {
    const f = fixture(), deps = dependencies(f);
    const selection = { kind: "runtime.files.reconcile", nonce: "11".repeat(32), requestSha256: "22".repeat(32), challenge: "33".repeat(32) };
    const result = { schemaVersion: "goatcitadel.native-file-reconciliation.v1", challenge: selection.challenge, settlement: null,
      lookup: { schemaVersion: REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: "registry-a", assignmentId: "assignment-a",
        assignmentGeneration: 1, leaseRevision: 1, nonce: selection.nonce, requestSha256: selection.requestSha256, record: null, accepted: null } };
    const owner = { reconcile: vi.fn(async () => result) }; Object.assign(deps.settlement, { nativeFileReconciliation: owner });
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "native_file_reconciliation", nativeFileReconciliation: result });
    expect(owner.reconcile).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.reconcile.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ completed: true }, { approvalId: "foreign" }, { bytesHex: "aa" }, { challenge: "0".repeat(64) }])
      await expect(service(f, deps).execute(request({ ...selection, ...patch }))).rejects.toThrow();
    expect(owner.reconcile).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.reconcile).toHaveBeenCalledTimes(count);
    for (const changed of [{ ...result, challenge: "ff".repeat(32) }, { ...result, lookup: { ...result.lookup, leaseRevision: 2 } }]) {
      owner.reconcile.mockResolvedValueOnce(changed); await expect(service(f, deps).execute(request())).rejects.toThrow();
    }
    owner.reconcile.mockRejectedValueOnce(new Error("revoked")); await expect(service(f, deps).execute(request())).rejects.toThrow();
    Object.assign(deps.settlement, { nativeFileReconciliation: undefined }); await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("reads cleanup history only under current signed assignment authority", async () => {
    const f = fixture(), deps = dependencies(f);
    const selection = { kind: "runtime.cleanup.read", challenge: "33".repeat(32) };
    const result = { schemaVersion: "goatcitadel.remote-worker-runtime-cleanup.v1", challenge: selection.challenge, expectations: [],
      history: { ...objectInventoryHistoryFixture(), registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1, leaseRevision: 1 } };
    const owner = { read: vi.fn(async () => result) }; Object.assign(deps.settlement, { runtimeCleanup: owner });
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_cleanup", runtimeCleanup: result });
    expect(owner.read).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.read.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ expectations: [] }, { approvalId: "foreign" }, { challenge: "0".repeat(64) }])
      await expect(service(f, deps).execute(request({ ...selection, ...patch }))).rejects.toThrow();
    expect(owner.read).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.read).toHaveBeenCalledTimes(count);
    owner.read.mockResolvedValueOnce({ ...result, challenge: "ff".repeat(32) });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    owner.read.mockRejectedValueOnce(new Error("revoked")); await expect(service(f, deps).execute(request())).rejects.toThrow();
    Object.assign(deps.settlement, { runtimeCleanup: undefined }); await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("reads retained native outcomes only under current signed assignment authority", async () => {
    const f = fixture(), deps = dependencies(f);
    const selection = { kind: "runtime.outcome.read", nonce: "11".repeat(32), requestSha256: "22".repeat(32), challenge: "33".repeat(32) };
    const result = { schemaVersion: "goatcitadel.remote-worker-runtime-outcome.v1", challenge: selection.challenge, outcome: null,
      lookup: { schemaVersion: REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION, registryWorkspaceId: "registry-a", assignmentId: "assignment-a",
        assignmentGeneration: 1, leaseRevision: 1, nonce: selection.nonce, requestSha256: selection.requestSha256, record: null, accepted: null } };
    const owner = { read: vi.fn(async () => result) }; Object.assign(deps.settlement, { runtimeOutcomes: owner });
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_outcome", runtimeOutcome: result });
    expect(owner.read).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.read.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ completed: true }, { approvalId: "foreign" }, { challenge: "0".repeat(64) }])
      await expect(service(f, deps).execute(request({ ...selection, ...patch }))).rejects.toThrow();
    expect(owner.read).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.read).toHaveBeenCalledTimes(count);
    owner.read.mockResolvedValueOnce({ ...result, challenge: "ff".repeat(32) });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    Object.assign(deps.settlement, { runtimeOutcomes: undefined }); await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("checks native authority through signed transport without accepting worker approval claims", async () => {
    const f = fixture(), deps = dependencies(f);
    const selection = { kind: "runtime.authorize", nonce: "11".repeat(32), requestSha256: "22".repeat(32), phase: "execution", challenge: "33".repeat(32) };
    const expectation = { nonce: selection.nonce, requestSha256: selection.requestSha256, checkpointSha256: "44".repeat(32),
      runtimeBundleSha256: "55".repeat(32), maxInputBytes: 100, maxOutputBytes: 1000, maxInventoryEntries: 20 };
    const owner = { authorize: vi.fn(async () => expectation) }; Object.assign(deps.settlement, { runtimeAuthorization: owner });
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_authorization", runtimeAuthorization: { submission: selection, expectation } });
    expect(owner.authorize).toHaveBeenCalledWith(expect.objectContaining({ nonce: selection.nonce, requestSha256: selection.requestSha256,
      phase: "execution", protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.authorize.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ approved: true }, { approvalId: "foreign" }, { expectation }, { phase: "approve" }, { challenge: "0".repeat(64) }])
      await expect(service(f, deps).execute(request({ ...selection, ...patch }))).rejects.toThrow();
    expect(owner.authorize).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    const invalid = request();
    await expect(service(f, deps).execute({ ...invalid, headers: { ...invalid.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.authorize).toHaveBeenCalledTimes(count);
    owner.authorize.mockResolvedValueOnce({ ...expectation, requestSha256: "ff".repeat(32) });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    Object.assign(deps.settlement, { runtimeAuthorization: undefined });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("retains installation evidence through signed authority and rejects substituted receipts", async () => {
    const f = fixture(), deps = dependencies(f), nonce = "11".repeat(32), requestSha256 = "22".repeat(32);
    // Envelope fixture only: the storage owner separately verifies all seals and journal bindings.
    const bytes = Buffer.alloc(352); bytes.write("GCRLI001"); bytes.write("GCRLIT01", 256);
    Buffer.from(nonce, "hex").copy(bytes, 8); Buffer.from(requestSha256, "hex").copy(bytes, 40); bytes.fill(51, 320);
    const selection = { kind: "runtime.install.retain", nonce, requestSha256, outcomeHex: bytes.toString("hex") };
    const result = { schemaVersion: "goatcitadel.remote-worker-runtime-install-exchange.v1",
      registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1, leaseRevision: 1, nonce, requestSha256,
      record: { outcomeHex: selection.outcomeHex, outcomeSha256: "33".repeat(32), leaseRevision: 1, recordedAt: "2026-09-16T00:00:00.000Z" } };
    const owner = { exchange: vi.fn(async (): Promise<object> => result) }; Object.assign(deps.settlement, { runtimeInstalls: owner });
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_install", runtimeInstall: result });
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    owner.exchange.mockResolvedValueOnce({ ...result, record: null });
    expect(await service(f, deps).execute(request({ kind: "runtime.install.lookup", nonce, requestSha256 }))).toMatchObject({ runtimeInstall: { record: null } });
    const count = owner.exchange.mock.calls.length;
    for (const patch of [{ approved: true }, { kind: "runtime.install.admit" }, { outcomeHex: selection.outcomeHex.slice(0, 512) }, { nonce: "44".repeat(32) }])
      await expect(service(f, deps).execute(request({ ...selection, ...patch }))).rejects.toThrow();
    const bad = request();
    await expect(service(f, deps).execute({ ...bad, headers: { ...bad.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.exchange).toHaveBeenCalledTimes(count);
    for (const patch of [{ assignmentId: "foreign" }, { leaseRevision: 2 }, { record: null },
      { record: { ...result.record, outcomeHex: selection.outcomeHex.slice(0, 200) + "ff" + selection.outcomeHex.slice(202) } }]) {
      owner.exchange.mockResolvedValueOnce({ ...result, ...patch });
      await expect(service(f, deps).execute(request())).rejects.toThrow();
    }
    Object.assign(deps.settlement, { runtimeInstalls: undefined });
    await expect(service(f, deps).execute(request())).rejects.toThrow(/unavailable/u);
  });
  it("selects retained installation input through signed authority without accepting worker input", async () => {
    const f = fixture(), deps = dependencies(f), challenge = "ab".repeat(32);
    const history = { ...objectInventoryHistoryFixture(), registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1, leaseRevision: 1 };
    const result = { schemaVersion: "goatcitadel.remote-worker-runtime-install-selection.v1", challenge, history, request: null };
    const owner = { exchange: vi.fn(), select: vi.fn(async (): Promise<object> => result) }; Object.assign(deps.settlement, { runtimeInstalls: owner });
    const query = { kind: "runtime.install.select", challenge };
    const request = (submission: object = query) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_install_selection", runtimeInstallSelection: result });
    expect(owner.select).toHaveBeenCalledWith(expect.objectContaining({ submission: query, protectedAuthority: expect.any(Object) }));
    for (const extra of [{ request: {} }, { approved: true }, { nonce: "11".repeat(32) }])
      await expect(service(f, deps).execute(request({ ...query, ...extra }))).rejects.toThrow();
    expect(owner.select).toHaveBeenCalledOnce(); expect(owner.exchange).not.toHaveBeenCalled();
    for (const patch of [{ challenge: "cd".repeat(32) }, { history: { ...history, leaseRevision: 2 } }, { history: { ...history, assignmentId: "foreign" } }]) {
      owner.select.mockResolvedValueOnce({ ...result, ...patch }); await expect(service(f, deps).execute(request())).rejects.toThrow();
    }
    Object.assign(deps.settlement, { runtimeInstalls: { exchange: owner.exchange } });
    await expect(service(f, deps).execute(request())).rejects.toThrow(/unavailable/u);
  });
  it("routes installation session frames only through current signed assignment authority", async () => {
    const f = fixture(), deps = dependencies(f);
    const query = { kind: "runtime.install.session", sessionId: "ab".repeat(32), sequence: 1, action: "prepare", payloadHex: "7b7d" };
    const result = { sessionId: query.sessionId, sequence: 1, event: "material", payloadHex: "7b7d" };
    const owner = { exchange: vi.fn(async () => result) }; Object.assign(deps.settlement, { installationSessions: owner });
    const request = (submission: object = query) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "installation_session", installationSession: result });
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: query, protectedAuthority: expect.any(Object),
      assignmentId: "assignment-a", assignmentGeneration: 1, leaseRevision: 1 }));
    for (const patch of [{ controllerEnrollment: {} }, { sequence: 0 }, { action: "approve" }, { payloadHex: "ff".repeat(100000) }])
      await expect(service(f, deps).execute(request({ ...query, ...patch }))).rejects.toThrow();
    expect(owner.exchange).toHaveBeenCalledOnce();
    const unsigned = request();
    await expect(service(f, deps).execute({ ...unsigned, headers: { ...unsigned.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.exchange).toHaveBeenCalledOnce();
    Object.assign(deps.settlement, { installationSessions: undefined });
    await expect(service(f, deps).execute(request())).rejects.toThrow("Remote worker assignment execution could not be completed.");
  });
  it("routes result pages and lookups through signed authority without exposing request admission", async () => {
    const f = fixture(), deps = dependencies(f);
    const selection = { kind: "runtime.result.page" as const, nonce: "11".repeat(32), requestSha256: "22".repeat(32),
      resultSha256: "33".repeat(32), byteLength: 1000608, offset: 0, bytesHex: "00".repeat(32768) };
    const result: RemoteWorkerRuntimeResultExchange = { schemaVersion: REMOTE_WORKER_RUNTIME_RESULT_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1, leaseRevision: 1,
      nonce: selection.nonce, requestSha256: selection.requestSha256, record: null, accepted: { page: selection, nextOffset: 32768 } };
    const owner = { exchange: vi.fn(async () => result) }; Object.assign(deps.settlement, { runtimeResults: owner });
    const request = (submission: object = selection) => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, submission));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "runtime_result", runtimeResult: result });
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    owner.exchange.mockResolvedValueOnce({ ...result, accepted: null });
    expect(await service(f, deps).execute(request({ kind: "runtime.result.lookup", nonce: selection.nonce, requestSha256: selection.requestSha256 })))
      .toMatchObject({ runtimeResult: { record: null, accepted: null } });
    const count = owner.exchange.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ bytesHex: "00".repeat(32769) }, { offset: 1 }, { approved: true }, { kind: "runtime.result.admit" }, { expectation: { approved: true } }])
      await expect(service(f, deps).execute(request({ ...selection, ...patch }))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(owner.exchange).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    owner.exchange.mockResolvedValueOnce({ ...result, assignmentId: "foreign" });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    owner.exchange.mockResolvedValueOnce({ ...result, accepted: { page: { ...selection, bytesHex: "ff" + selection.bytesHex.slice(2) }, nextOffset: 32768 } });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    const beforeSignature = owner.exchange.mock.calls.length, badSignature = request();
    await expect(service(f, deps).execute({ ...badSignature, headers: { ...badSignature.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.exchange).toHaveBeenCalledTimes(beforeSignature);
    Object.assign(deps.settlement, { runtimeResults: undefined }); await expect(service(f, deps).execute(request())).rejects.toThrow();
  });
  it("routes bounded inventory pages through signed assignment authority and rejects oversized or forged pages before dispatch", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const history = mountedWorkspaceExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const bytes = objectInventoryFixture(history, 19996);
    const selection = { kind: "cell.object_inventory.page" as const, expectedRevision: 0, startChunk: 0,
      observationHex: bytes.summary.toString("hex"), chunkHex: bytes.chunks.slice(0, 64).map(chunk => chunk.toString("hex")), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
    const result = { schemaVersion: REMOTE_WORKER_CELL_OBJECT_INVENTORY_PAGE_SCHEMA_VERSION, history, record: null,
      accepted: { page: selection, nextChunk: 64, committedRevision: null } };
    const owner = { exchange: vi.fn(async () => result) }; Object.assign(deps.settlement, { cellObjectInventoryPages: owner });
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "cell_object_inventory_page", cellObjectInventoryPage: result });
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.exchange.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ chunkHex: bytes.chunks.slice(0, 140).map(chunk => chunk.toString("hex")) }, { chunkHex: bytes.chunks.slice(0, 65).map(chunk => chunk.toString("hex")) },
      { startChunk: -1 }, { approvalGranted: true }, { kind: "cell.object_inventory.observation" }])
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(owner.exchange).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    owner.exchange.mockResolvedValueOnce({ ...result, history: { ...history, assignmentId: "foreign" } });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    owner.exchange.mockResolvedValueOnce({ ...result, accepted: { ...result.accepted, page: { ...selection, chunkHex: [...selection.chunkHex].reverse() } } });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    const beforeSignature = owner.exchange.mock.calls.length, badSignature = request();
    await expect(service(f, deps).execute({ ...badSignature, headers: { ...badSignature.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.exchange).toHaveBeenCalledTimes(beforeSignature);
    Object.assign(deps.settlement, { cellObjectInventoryPages: undefined });
    await expect(service(f, deps).execute(request())).rejects.toThrow(/unavailable/u);
  });
  it("routes bounded native capacity pages through protected assignment authority", async () => {
    const f = fixture(), deps = dependencies(f);
    const selection = { kind: "cell.native_capacity.page", nonce: "11".repeat(32), bundleSha256: "22".repeat(32),
      deliverySha256: "33".repeat(32), byteLength: 65536, offset: 0, bytesHex: "7b".repeat(32768) };
    const payload = settlementPayload(f, selection);
    const result = { schemaVersion: REMOTE_WORKER_NATIVE_CAPACITY_PAGE_EXCHANGE_SCHEMA,
      registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1,
      leaseRevision: 1, nonce: selection.nonce, bundleSha256: selection.bundleSha256, record: null,
      accepted: { page: selection, nextOffset: 32768 } };
    const owner = { exchange: vi.fn(async () => result) }; Object.assign(deps.settlement, { nativeCapacityPages: owner });
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, payload);
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "native_capacity_page", nativeCapacityPage: result });
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.exchange.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ bytesHex: "ab".repeat(32769) }, { offset: 1 }, { approved: true }, { kind: "cell.native_capacity.complete" }])
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(owner.exchange).toHaveBeenCalledTimes(count); expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    owner.exchange.mockResolvedValueOnce({ ...result, assignmentId: "foreign" });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    owner.exchange.mockResolvedValueOnce({ ...result, accepted: { ...result.accepted, page: { ...selection, bytesHex: "7d".repeat(32768) } } });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    const beforeSignature = owner.exchange.mock.calls.length, badSignature = request();
    await expect(service(f, deps).execute({ ...badSignature, headers: { ...badSignature.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.exchange).toHaveBeenCalledTimes(beforeSignature);
    Object.assign(deps.settlement, { nativeCapacityPages: undefined });
    await expect(service(f, deps).execute(request())).rejects.toThrow(/unavailable/u);
  });
  it.each([["cell.native_pool.page", "native_pool_page"], ["cell.native_pool.cleanup.page", "native_pool_cleanup_page"]])(
    "routes %s through protected authority without accepting worker scope", async (kind, disposition) => {
    const f = fixture(), deps = dependencies(f);
    const selection = { kind, offset: 0, snapshotSha256: "b".repeat(64) };
    const page = { snapshotSha256: selection.snapshotSha256, offset: 0, byteLength: 1, bytesHex: "7b" };
    const owner = { read: vi.fn(async () => page) };
    Object.assign(deps.settlement, { nativePool: owner });
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition, nativePoolPage: page });
    expect(owner.read).toHaveBeenCalledWith(expect.objectContaining({ submission: selection,
      protectedAuthority: expect.any(Object), leaseTokenSha256: D(f.rawLeaseToken) }));
    const count = owner.read.mock.calls.length, nonces = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ workerId: "foreign" }, { registryWorkspaceId: "foreign" }, { approved: true }, { offset: 1 }])
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(owner.read).toHaveBeenCalledTimes(count);
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonces);
    owner.read.mockResolvedValueOnce({ ...page, snapshotSha256: "c".repeat(64) });
    await expect(service(f, deps).execute(request())).rejects.toThrow();
    const bad = request(), before = owner.read.mock.calls.length;
    await expect(service(f, deps).execute({ ...bad, headers: { ...bad.headers, "x-goatcitadel-worker-proof": "00" } })).rejects.toThrow();
    expect(owner.read).toHaveBeenCalledTimes(before);
    Object.assign(deps.settlement, { nativePool: undefined });
    await expect(service(f, deps).execute(request())).rejects.toThrow(/unavailable/u);
  });
  it("routes capacity observations through current protected authority and requires the exact retained receipt", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const history = mountedWorkspaceExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const selection = { kind: "cell.capacity.observation", expectedRevision: 0,
      observationHex: capacityObservationFixture(history).toString("hex"), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
    const result = normalizeRemoteWorkerCellCapacityExchange({ schemaVersion: REMOTE_WORKER_CELL_CAPACITY_EXCHANGE_SCHEMA_VERSION, history,
      record: { revision: 1, leaseRevision: 1, recordedAt: "2026-09-13T00:00:00.000Z", observationHex: selection.observationHex, nativeReceiptHex: selection.nativeReceiptHex } });
    const owner = { exchange: vi.fn(async (): Promise<RemoteWorkerCellCapacityExchange> => result) };
    Object.assign(deps.settlement, { cellCapacity: owner });
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "cell_capacity_recorded", cellCapacity: result });
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, leaseRevision: 1,
      leaseTokenSha256: D(f.rawLeaseToken), protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(Object.isFrozen(owner.exchange.mock.calls[0]![0].submission)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/protectedAuthority|leaseToken|provisioningOwner/u);
    for (const changed of [{ ...result, record: null }, { ...result, history: { ...history, assignmentId: "foreign" } },
      { ...result, record: { ...result.record!, revision: 2 } }, { ...result, history: { ...history, mountedWorkspaceRecords: [] } }]) {
      owner.exchange.mockResolvedValueOnce(changed);
      await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    const nonceCount = deps.nonceConsumer.consume.mock.calls.length, ownerCount = owner.exchange.mock.calls.length;
    for (const patch of [{ approvalGranted: true }, { expectedRevision: -1 }, { nativeReceiptHex: "00".repeat(16) }, { observationHex: "00" }])
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonceCount);
    expect(owner.exchange).toHaveBeenCalledTimes(ownerCount);
    owner.exchange.mockResolvedValueOnce({ ...result, record: null });
    expect(await service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, { kind: "cell.capacity.snapshot" })))).toMatchObject({ disposition: "cell_capacity_snapshot", cellCapacity: { record: null } });
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
    expect(deps.inference.performInference).not.toHaveBeenCalled();
  });
  it("refuses capacity requests when the canonical capacity owner is unavailable", async () => {
    const f = fixture(), deps = dependencies(f);
    await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, { kind: "cell.capacity.snapshot" })))).rejects.toThrow(/unavailable/u);
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(1);
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });
  it("routes backing capacity observations through current protected authority and requires the exact retained receipt", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const history = mountedWorkspaceExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const selection = { kind: "cell.backing_capacity.observation", expectedRevision: 0,
      observationHex: backingCapacityObservationFixture(history).toString("hex"), nativeReceiptHex: REMOTE_WORKER_CELL_CAPACITY_SUCCESS_RECEIPT };
    const result = normalizeRemoteWorkerCellBackingCapacityExchange({ schemaVersion: REMOTE_WORKER_CELL_BACKING_CAPACITY_EXCHANGE_SCHEMA_VERSION, history,
      record: { revision: 1, leaseRevision: 1, recordedAt: "2026-09-13T00:00:00.000Z", observationHex: selection.observationHex, nativeReceiptHex: selection.nativeReceiptHex } });
    const owner = { exchange: vi.fn(async (): Promise<RemoteWorkerCellBackingCapacityExchange> => result) };
    Object.assign(deps.settlement, { cellBackingCapacity: owner });
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    expect(await service(f, deps).execute(request())).toMatchObject({ disposition: "cell_backing_capacity_recorded", cellBackingCapacity: result });
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection, leaseRevision: 1,
      leaseTokenSha256: D(f.rawLeaseToken), protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(Object.isFrozen(owner.exchange.mock.calls[0]![0].submission)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/protectedAuthority|leaseToken|provisioningOwner/u);
    for (const changed of [{ ...result, record: null }, { ...result, history: { ...history, assignmentId: "foreign" } },
      { ...result, record: { ...result.record!, revision: 2 } }, { ...result, history: { ...history, mountedWorkspaceRecords: [] } }]) {
      owner.exchange.mockResolvedValueOnce(changed);
      await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    const nonceCount = deps.nonceConsumer.consume.mock.calls.length, ownerCount = owner.exchange.mock.calls.length;
    for (const patch of [{ approvalGranted: true }, { expectedRevision: -1 }, { nativeReceiptHex: "00".repeat(16) }, { observationHex: "00" }])
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonceCount);
    expect(owner.exchange).toHaveBeenCalledTimes(ownerCount);
    owner.exchange.mockResolvedValueOnce({ ...result, record: null });
    expect(await service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, { kind: "cell.backing_capacity.snapshot" })))).toMatchObject({ disposition: "cell_backing_capacity_snapshot", cellBackingCapacity: { record: null } });
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
    expect(deps.inference.performInference).not.toHaveBeenCalled();
  });
  it("refuses backing capacity requests when the canonical capacity owner is unavailable", async () => {
    const f = fixture(), deps = dependencies(f);
    await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, { kind: "cell.backing_capacity.snapshot" })))).rejects.toThrow(/unavailable/u);
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(1);
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });
  it("routes mounted workspace checkpoints under current authority and refuses missing acknowledgements", async () => {
    const f = fixture(), deps = dependencies(f), base = cellExchangeFixture();
    const plan = { ...base.plan, virtualDiskBytes: 64 * 1024 * 1024, reservedDiskBytes: 128 * 1024 * 1024 };
    const records: string[] = [];
    for (let sequence = 1; sequence <= 5; sequence++) records.push(checkpointFixture(plan, sequence, records.at(-1)?.slice(-64)));
    const result = mountedWorkspaceExchangeFixture({ ...base, plan, planSha256: remoteWorkerCellProvisioningPlanSha256(plan), records });
    const owner = { exchange: vi.fn(async () => result) };
    Object.assign(deps.settlement, { cellProvisioning: owner });
    const selection = { kind: "cell.mounted-workspace.checkpoint", expectedSequence: 1, recordHex: result.mountedWorkspaceRecords![1] };
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection));
    const response = await service(f, deps).execute(request());
    expect(response.cellProvisioning).toEqual(result);
    expect(owner.exchange).toHaveBeenCalledWith(expect.objectContaining({ submission: selection,
      protectedAuthority: expect.any(Object), signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(response)).not.toMatch(/protectedAuthority|provisioningOwner|leaseTokenSha256/u);
    for (const mountedWorkspaceRecords of [[], ...[1].map((length) => result.mountedWorkspaceRecords!.slice(0, length))]) {
      owner.exchange.mockResolvedValueOnce({ ...result, mountedWorkspaceRecords });
      await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    const nonceCount = deps.nonceConsumer.consume.mock.calls.length;
    for (const patch of [{ provisioningOwner: "worker" }, { approvalGranted: true }, { expectedSequence: 0 }]) {
      await expect(service(f, deps).execute(signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, { ...selection, ...patch })))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    }
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(nonceCount);
    expect(deps.inference.performInference).not.toHaveBeenCalled();
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });

  it("routes cell snapshots and checkpoints under the current protected assignment fence without exposing it", async () => {
    const f = fixture();
    const deps = dependencies(f);
    const result = cellExchangeFixture();
    const cellProvisioning = { exchange: vi.fn(async () => result) };
    Object.assign(deps.settlement, { cellProvisioning });
    for (const selection of [{ kind: "cell.provisioning.snapshot" },
      { kind: "cell.provisioning.checkpoint", expectedSequence: 0, recordHex: result.records[0] }]) {
      const request = signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        settlementPayload(f, selection));
      const response = await service(f, deps).execute(request);
      expect(response).toMatchObject({ disposition: "cell_provisioning_recorded", cellProvisioning: result });
      expect(cellProvisioning.exchange).toHaveBeenLastCalledWith(expect.objectContaining({
        registryWorkspaceId: "registry-a", assignmentId: "assignment-a", assignmentGeneration: 1, leaseRevision: 1,
        leaseTokenSha256: D(f.rawLeaseToken), protectedAuthority: expect.any(Object), submission: selection,
        signal: expect.any(AbortSignal),
      }));
      expect(JSON.stringify(response)).not.toMatch(/protectedAuthority|provisioningOwner|leaseTokenSha256/u);
      expect(JSON.stringify(response)).not.toContain(f.rawLeaseToken);
    }
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(2);
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
    expect(deps.inference.performInference).not.toHaveBeenCalled();
  });

  it.each([{ provisioningOwner: "worker" }, { plan: {} }, { approvalGranted: true },
    { expectedSequence: 1 }, { recordHex: "not-a-record" }])("rejects cell checkpoint authority injection or invalid bytes: %j", async (patch) => {
    const f = fixture();
    const deps = dependencies(f);
    const result = cellExchangeFixture();
    await expect(service(f, deps).execute(signedRequest(f,
      REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, {
        kind: "cell.provisioning.checkpoint", expectedSequence: 0, recordHex: result.records[0], ...patch,
      }),
    ))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(deps.nonceConsumer.consume).not.toHaveBeenCalled();
  });

  it("refuses missing cell owners and stale authority and propagates a commit refusal", async () => {
    const f = fixture();
    const deps = dependencies(f);
    const request = () => signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, { kind: "cell.provisioning.snapshot" }));
    await expect(service(f, deps).execute(request())).rejects.toThrow("unavailable");
    const cellProvisioning = { exchange: vi.fn(async () => { throw new Error("revoked during commit"); }) };
    Object.assign(deps.settlement, { cellProvisioning });
    deps.assignments.resolveActiveAuthorityByLeaseTokenHash.mockResolvedValueOnce(undefined);
    await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(cellProvisioning.exchange).not.toHaveBeenCalled();
    await expect(service(f, deps).execute(request())).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(cellProvisioning.exchange).toHaveBeenCalledOnce();
  });

  it.each(["before_owner", "after_commit"] as const)("does not acknowledge a cancelled cell exchange: %s", async (stage) => {
    const f = fixture();
    const deps = dependencies(f);
    const cancellation = new AbortController();
    const cellProvisioning = { exchange: vi.fn(async () => {
      cancellation.abort();
      return cellExchangeFixture();
    }) };
    Object.assign(deps.settlement, { cellProvisioning });
    if (stage === "before_owner") cancellation.abort();
    const request = signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, { kind: "cell.provisioning.snapshot" }));
    await expect(service(f, deps).execute({ ...request, signal: cancellation.signal }))
      .rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(cellProvisioning.exchange).toHaveBeenCalledTimes(stage === "before_owner" ? 0 : 1);
  });

  it.each([{ assignmentId: "foreign" }, { leaseRevision: 2 }, { records: [] },
    { protectedAuthority: "must-not-cross-wire" }, { planSha256: "f".repeat(64) }])(
    "refuses a cell owner result that is private, corrupt or bound to a different request: %j", async (patch) => {
      const f = fixture();
      const deps = dependencies(f);
      const result = cellExchangeFixture();
      Object.assign(deps.settlement, { cellProvisioning: { exchange: vi.fn(async () => ({ ...result, ...patch })) } });
      await expect(service(f, deps).execute(signedRequest(f,
        REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, {
          kind: "cell.provisioning.checkpoint", expectedSequence: 0, recordHex: result.records[0],
        }),
      ))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    },
  );

  it("uses the exact contract-owned route codes 11-12 and reaches the HX-503 owner with the untouched submission", async () => {
    expect(Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES).map(({ code }) => code)).toEqual([11, 12]);
    expect(Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES).map(({ operation }) => operation)).toEqual([
      "assignment.inference.exchange",
      "assignment.settlement.submit",
    ]);
    const f = fixture();
    const deps = dependencies(f);
    const response = await service(f, deps).execute(
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
    );

    expect(response).toMatchObject({ disposition: "delivered", operation: "assignment.inference.exchange" });
    expect(deps.inference.performInference).toHaveBeenCalledWith({ submission: submission(f),
      protectedAuthority: deps.fences[0], signal: expect.any(AbortSignal) });
    expect(deps.nonceConsumer.consume).toHaveBeenCalledOnce();
    // The lease-token hash the storage transaction is fenced with comes from the
    // canonical contracts boundary, and no raw lease leaves the wire boundary.
    expect(deps.assignments.resolveActiveAuthorityByLeaseTokenHash).toHaveBeenCalledWith(
      D(f.rawLeaseToken),
      expect.anything(),
    );
    expect(JSON.stringify(response)).not.toContain(f.rawLeaseToken);
    expect(JSON.stringify(deps.nonceInputs)).not.toContain(f.rawLeaseToken);
  });

  it("rechecks the complete M2 credential + protected evidence + mesh fence inside the storage transaction", async () => {
    const f = fixture();
    const deps = dependencies(f);
    await service(f, deps).execute(
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
    );

    // The mesh authority is resolved for the assignment's EXECUTION workspace.
    expect(deps.meshAdmissions.resolveCurrentForRuntimeCredential).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-a", credentialId: "credential-a" }),
    );
    expect(deps.fences).toHaveLength(1);
    expect(deps.fences[0]).toMatchObject({
      credentialAuthority: {
        registryWorkspaceId: "registry-a",
        workerId: "worker-a",
        workerGeneration: 4,
        credentialId: "credential-a",
        credentialGeneration: 5,
        authorizationCredentialSha256: f.authority.authorizationCredentialSha256,
        protectedAdmissionEnvelopeSha256: f.authority.protectedAdmissionEnvelopeSha256,
        protectedAdmissionContextSha256: f.authority.protectedAdmissionContextSha256,
      },
      meshAdmission: { workspaceId: "workspace-a", admissionGeneration: NODE_ADMISSION_GENERATION },
    });
    // Ordering: the fence recheck only happens after the durable nonce is spent.
    expect(deps.nonceConsumer.consume.mock.invocationCallOrder[0]).toBeLessThan(
      deps.assignments.resolveActiveAuthorityByLeaseTokenHash.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("routes a retained model tool reference through the same protected settlement fence", async () => {
    const f = fixture();
    const deps = dependencies(f);
    const selection = { kind: "chat.tool", inferenceRequestId: "inference-a", attempt: 1, callIndex: 0 };
    const chatTools = { dispatchTool: vi.fn(async () => ({
      status: "waiting_approval" as const, inferenceRequestId: "inference-a", attempt: 1, callIndex: 0,
      requestSha256: D("request"), callId: "call-a", modelToolName: "fs_read", toolRunId: "remote-tool:intent-a", intentId: "intent-a",
    })) };
    Object.assign(deps.settlement, { chatTools });
    await expect(service(f, deps).execute(signedRequest(f,
      REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, selection),
    ))).resolves.toMatchObject({ disposition: "chat_tool_recorded", tool: { status: "waiting_approval" } });
    expect(chatTools.dispatchTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      submission: selection, fence: expect.objectContaining({
        leaseTokenSha256: D(f.rawLeaseToken), sessionControlGeneration: null,
        protectedAuthority: expect.any(Object),
      }),
    }));
    expect(JSON.stringify(chatTools.dispatchTool.mock.calls)).not.toContain(f.rawLeaseToken);
    expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });

  it.each([{ canonicalArgs: {} }, { effectSelector: "fs.write" }, { approvalGranted: true }, { callIndex: 32 }])(
    "rejects model tool authority fields or an invalid selection before consuming its nonce: %j", async (patch) => {
      const f = fixture();
      const deps = dependencies(f);
      await expect(service(f, deps).execute(signedRequest(f,
        REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, {
          kind: "chat.tool", inferenceRequestId: "inference-a", attempt: 1, callIndex: 0, ...patch,
        }),
      ))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
      expect(deps.nonceConsumer.consume).not.toHaveBeenCalled();
      expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
    },
  );

  it("routes every HX-506 settlement submission kind to its owner under the same fence", async () => {
    const f = fixture();
    const deps = dependencies(f);
    const protocol = service(f, deps);

    await expect(
      protocol.execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
          settlementPayload(f, {
            kind: "artifact.open",
            uploadAttempt: 1,
            declaredFileCount: 1,
            declaredTotalBytes: 5,
            stagingRootSha256: D("staging-a"),
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
        ),
      ),
    ).resolves.toMatchObject({ disposition: "artifact_recorded", operation: "assignment.settlement.submit" });

    await expect(
      protocol.execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
          settlementPayload(f, {
            kind: "artifact.part",
            uploadId: "upload-a",
            part: {
              globalSequence: 1,
              logicalPathSha256: D(canonicalJsonString({ logicalPath: "dir/file.bin" })),
              filePartIndex: 0,
              isFinalPart: true,
              partBytes: 5,
              partSha256: D("part-a"),
            },
          }),
        ),
      ),
    ).resolves.toMatchObject({ disposition: "artifact_recorded" });

    await expect(
      protocol.execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
          settlementPayload(f, {
            kind: "artifact.commit",
            uploadId: "upload-a",
            manifest: artifactManifest(f),
            files: [
              {
                logicalPath: "dir/file.bin",
                logicalPathSha256: D(canonicalJsonString({ logicalPath: "dir/file.bin" })),
                bytesBase64: Buffer.from("hello", "utf8").toString("base64"),
                mimeType: "application/octet-stream",
              },
            ],
          }),
        ),
      ),
    ).resolves.toMatchObject({ disposition: "artifact_recorded" });

    await expect(
      protocol.execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
          settlementPayload(f, {
            kind: "effect.dispatch",
            intentIndex: 1,
            effectSelector: "fs.write",
            canonicalArgs: { path: "dir/file.bin" },
            workerIdempotencyKey: "effect-worker-a",
          }),
        ),
      ),
    ).resolves.toMatchObject({ disposition: "effect_settled" });

    for (const owner of [
      deps.settlement.artifacts.openUpload,
      deps.settlement.artifacts.appendPart,
      deps.settlement.artifacts.commitArtifact,
      deps.settlement.effects.dispatchEffect,
    ]) {
      expect(owner).toHaveBeenCalledOnce();
    }
    // The raw settlement lease is hashed at this boundary and never forwarded.
    expect(JSON.stringify(deps.settlement.artifacts.openUpload.mock.calls)).not.toContain(f.rawLeaseToken);
    expect(deps.settlement.artifacts.openUpload).toHaveBeenCalledWith(
      expect.objectContaining({ leaseTokenSha256: D(f.rawLeaseToken) }),
    );
    expect(deps.settlement.effects.dispatchEffect).toHaveBeenCalledWith(
      expect.objectContaining({ fence: expect.objectContaining({ leaseTokenSha256: D(f.rawLeaseToken) }) }),
    );
    expect(deps.nonceConsumer.consume).toHaveBeenCalledTimes(4);
  });

  it("rejects v1 downgrade, target drift, a proof signed for another route code, and payload/route disagreement before nonce", async () => {
    const f = fixture();
    for (const request of [
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f), {
        proofVersion: "v1",
      }),
      {
        ...signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
        rawPath: REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission.rawPath,
      },
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f), {
        signedRoute: REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      }),
      signedRequest(
        f,
        REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
        // An inference envelope on the settlement route never normalizes.
        inferencePayload(f),
      ),
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, {
        ...inferencePayload(f),
        registryWorkspaceId: "registry-b",
        submission: submission(f, { registryWorkspaceId: "registry-b" }),
      }),
    ]) {
      const deps = dependencies(f);
      await expect(service(f, deps).execute(request)).rejects.toBeInstanceOf(
        RemoteWorkerAssignmentExecutionProtocolError,
      );
      expect(deps.nonceConsumer.consume).not.toHaveBeenCalled();
      expect(deps.inference.performInference).not.toHaveBeenCalled();
      expect(deps.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
    }
  });

  it("rejects a stale credential before nonce and every stale evidence/mesh/lease fence after nonce", async () => {
    const f = fixture();
    const staleCredential = dependencies(f);
    staleCredential.credentialAuthority.resolveByCredentialTokenSha256.mockResolvedValueOnce(undefined);
    await expect(
      service(f, staleCredential).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
      ),
    ).rejects.toThrow("credential authority");
    expect(staleCredential.nonceConsumer.consume).not.toHaveBeenCalled();
    expect(staleCredential.assignments.resolveActiveAuthorityByLeaseTokenHash).not.toHaveBeenCalled();

    // A stale protected-admission envelope digest breaks the mesh fence equality.
    const staleEvidence = dependencies(f);
    staleEvidence.meshAdmissions.resolveCurrentForRuntimeCredential.mockImplementationOnce((input) =>
      Object.freeze({
        schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
        registryWorkspaceId: input.registryWorkspaceId,
        bootstrapId: input.bootstrapId,
        workerId: input.workerId,
        workerGeneration: input.workerGeneration,
        credentialId: input.credentialId,
        credentialGeneration: input.credentialGeneration,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        admissionGeneration: NODE_ADMISSION_GENERATION,
        joinAuthorityGeneration: 1,
        joinCredentialSha256: D("mesh-join-a"),
        protectedAdmissionEnvelopeSha256: D("stale-protected-envelope"),
        protectedAdmissionContextSha256: input.protectedAdmissionContextSha256,
      }),
    );
    await expect(
      service(f, staleEvidence).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
      ),
    ).rejects.toThrow("mesh-node authority is inconsistent");
    expect(staleEvidence.nonceConsumer.consume).toHaveBeenCalledOnce();
    expect(staleEvidence.inference.performInference).not.toHaveBeenCalled();

    // A withdrawn mesh-node admission for the execution workspace.
    const staleMesh = dependencies(f);
    staleMesh.meshAdmissions.resolveCurrentForRuntimeCredential.mockReturnValueOnce(undefined as never);
    await expect(
      service(f, staleMesh).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
      ),
    ).rejects.toThrow("mesh-node authority is unavailable");
    expect(staleMesh.nonceConsumer.consume).toHaveBeenCalledOnce();
    expect(staleMesh.inference.performInference).not.toHaveBeenCalled();

    // The storage transaction refuses the fence outright.
    const rejectedFence = dependencies(f);
    rejectedFence.assignments.resolveActiveAuthorityByLeaseTokenHash.mockRejectedValueOnce(
      new Error("protected fence mismatch"),
    );
    await expect(
      service(f, rejectedFence).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
      ),
    ).rejects.toThrow("protected fence was rejected in the storage transaction");
    expect(rejectedFence.nonceConsumer.consume).toHaveBeenCalledOnce();
    expect(rejectedFence.inference.performInference).not.toHaveBeenCalled();

    // A stale assignment generation or lease revision fails the resolved recheck.
    for (const overrides of [{ assignmentGeneration: 2 }, { leaseRevision: 2 }]) {
      const deps = dependencies(f);
      await expect(
        service(f, deps).execute(
          signedRequest(
            f,
            REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
            settlementPayload(
              f,
              {
                kind: "artifact.open",
                uploadAttempt: 1,
                declaredFileCount: 1,
                declaredTotalBytes: 5,
                stagingRootSha256: D("staging-a"),
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
              overrides,
            ),
          ),
        ),
      ).rejects.toThrow("lease authority is unavailable");
      expect(deps.nonceConsumer.consume).toHaveBeenCalledOnce();
      expect(deps.settlement.artifacts.openUpload).not.toHaveBeenCalled();
    }
  });

  it("rejects a replayed nonce on both routes before any owner is reached", async () => {
    const f = fixture();
    const deps = dependencies(f);
    const protocol = service(f, deps);
    const inference = signedRequest(
      f,
      REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange,
      inferencePayload(f),
      { nonce: token("nonce:inference-replay"), idempotencyKey: "inference-replay" },
    );
    await expect(protocol.execute(inference)).resolves.toMatchObject({ disposition: "delivered" });
    await expect(protocol.execute(inference)).rejects.toThrow("nonce was already consumed");
    expect(deps.inference.performInference).toHaveBeenCalledOnce();

    const settlement = signedRequest(
      f,
      REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
      settlementPayload(f, {
        kind: "effect.dispatch",
        intentIndex: 1,
        effectSelector: "fs.write",
        canonicalArgs: { path: "dir/file.bin" },
        workerIdempotencyKey: "effect-worker-a",
      }),
      { nonce: token("nonce:settlement-replay"), idempotencyKey: "settlement-replay" },
    );
    await expect(protocol.execute(settlement)).resolves.toMatchObject({ disposition: "effect_settled" });
    await expect(protocol.execute(settlement)).rejects.toThrow("nonce was already consumed");
    expect(deps.settlement.effects.dispatchEffect).toHaveBeenCalledOnce();
  });

  it("returns only the secret-free inference projection, never the stored budget/policy/route material", async () => {
    const f = fixture();
    const deps = dependencies(f);
    const response = await service(f, deps).execute(
      signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
    );
    const encoded = JSON.stringify(response);
    expect(encoded).not.toContain("NEVER-RETURN-THIS");
    for (const forbidden of [
      "effectiveRouteJson",
      "budgetReservationId",
      "budgetOperationJson",
      "dispatchClaimOwner",
      "policySha256",
      "policyRevision",
      "requestBodyJson",
      "idempotencyKey",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    if (!("request" in response) || !("frames" in response)) throw new Error("inference response unavailable");
    expect(Object.keys(response.request).sort()).toEqual(
      [
        "assignmentGeneration",
        "assignmentId",
        "attempt",
        "effectiveRouteSha256",
        "governanceDecision",
        "governanceExpiresAt",
        "governanceOutputTokenCeiling",
        "governanceReasoningTokenCeiling",
        "inferenceRequestId",
        "outputTokenCeiling",
        "reasoningTokenCeiling",
        "registryWorkspaceId",
        "requestSha256",
        "state",
        "usageEventIds",
        "usageEventIdsSha256",
      ].sort(),
    );
    // Provider output frames and the canonical HX-306 usage id still reach the worker.
    expect(response.frames).toHaveLength(1);
    expect(response.frames[0]).toMatchObject({ frameSequence: 1, usageEventId: "usage-a" });
    expect(response.frames[0]).not.toHaveProperty("effectiveRouteSha256");
    expect(response.request.usageEventIds).toEqual(["usage-retry-a", "usage-a"]);
    expect(response.request.usageEventIdsSha256).toBe(
      remoteWorkerInferenceUsageEventIdsSha256(["usage-retry-a", "usage-a"]),
    );
  });

  it("refuses corrupt canonical usage evidence instead of projecting partial attempt accounting", async () => {
    const f = fixture();
    for (const usageEventIdsJson of ["{malformed", canonicalJsonString(["usage-a"])]) {
      const deps = dependencies(f);
      deps.inference.performInference.mockResolvedValue({
        disposition: "delivered",
        request: { ...inferenceRequestRecord(), usageEventIdsJson },
        frames: [inferenceFrameRecord()],
      } as never);
      await expect(
        service(f, deps).execute(
          signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
        ),
      ).rejects.toThrow(/usage receipt is invalid/);
    }
  });

  it("refuses an artifact manifest whose identity does not bind the fenced assignment authority", async () => {
    const f = fixture();
    for (const identityOverrides of [
      { executionWorkspaceId: "workspace-b" },
      { registryWorkspaceId: "registry-b" },
      { assignmentId: "assignment-b" },
      { assignmentGeneration: 2 },
      { workerId: "worker-b" },
      { workerGeneration: 9 },
      { assignmentManifestSha256: D("other-assignment-manifest") },
      { capabilityCeilingSha256: D("other-capability-ceiling") },
    ]) {
      const deps = dependencies(f);
      await expect(
        service(f, deps).execute(
          signedRequest(
            f,
            REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
            settlementPayload(f, {
              kind: "artifact.commit",
              uploadId: "upload-a",
              manifest: artifactManifest(f, identityOverrides),
              files: [
                {
                  logicalPath: "dir/file.bin",
                  logicalPathSha256: D(canonicalJsonString({ logicalPath: "dir/file.bin" })),
                  bytesBase64: Buffer.from("hello", "utf8").toString("base64"),
                  mimeType: "application/octet-stream",
                },
              ],
            }),
          ),
        ),
      ).rejects.toThrow("artifact manifest does not bind");
      // No CAS blob is staged: the binding is asserted before the owner is called.
      expect(deps.settlement.artifacts.commitArtifact).not.toHaveBeenCalled();
    }
  });

  it("never lets a worker pin the HX-411 session-control fence for an external effect", async () => {
    const f = fixture();
    const deps = dependencies(f);
    const effect = {
      kind: "effect.dispatch",
      intentIndex: 1,
      effectSelector: "fs.write",
      canonicalArgs: { path: "dir/file.bin" },
      workerIdempotencyKey: "effect-worker-a",
    } as const;
    await expect(
      service(f, deps).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, settlementPayload(f, effect)),
      ),
    ).resolves.toMatchObject({ disposition: "effect_settled" });
    expect(deps.settlement.effects.dispatchEffect).toHaveBeenCalledWith(
      expect.objectContaining({ fence: expect.objectContaining({ sessionControlGeneration: null }) }),
    );

    // A worker-supplied sessionControlGeneration is an unknown field: refused
    // before the nonce, never carried into the fence.
    const smuggled = dependencies(f);
    await expect(
      service(f, smuggled).execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
          settlementPayload(f, { ...effect, sessionControlGeneration: 99 }),
        ),
      ),
    ).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(smuggled.nonceConsumer.consume).not.toHaveBeenCalled();
    expect(smuggled.settlement.effects.dispatchEffect).not.toHaveBeenCalled();
  });

  it.each(["payload", "submission"])("refuses worker-supplied artifact continuation in the %s", async (location) => {
    const f = fixture();
    const deps = dependencies(f);
    const submission = { kind: "artifact.open", uploadAttempt: 1, declaredFileCount: 1, declaredTotalBytes: 5,
      stagingRootSha256: D("staging"), expiresAt: "2099-01-01T00:00:00.000Z" };
    const supplied = { uploadId: "other-upload", leaseRevision: 1, parentDispatchAuthority: {} };
    const payload = location === "payload"
      ? { ...settlementPayload(f, submission), continuingArtifact: supplied }
      : settlementPayload(f, { ...submission, continuingArtifact: supplied });
    await expect(service(f, deps).execute(signedRequest(
      f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission, payload,
    ))).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
    expect(deps.nonceConsumer.consume).not.toHaveBeenCalled();
    expect(deps.settlement.artifacts.openUpload).not.toHaveBeenCalled();
  });

  it("refuses a payload above the execution byte ceiling and settlement counts above their contract bounds", async () => {
    const f = fixture();
    const oversized = dependencies(f);
    await expect(
      service(f, oversized).execute(
        signedRequest(
          f,
          REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
          settlementPayload(f, {
            kind: "effect.dispatch",
            intentIndex: 1,
            effectSelector: "fs.write",
            canonicalArgs: { blob: "x".repeat(300_000) },
            workerIdempotencyKey: "effect-worker-a",
          }),
        ),
      ),
    ).rejects.toThrow("payload exceeds its byte limit");
    expect(oversized.nonceConsumer.consume).not.toHaveBeenCalled();

    for (const overrides of [{ uploadAttempt: 5 }, { declaredFileCount: 65 }, { declaredTotalBytes: 67_108_865 }]) {
      const deps = dependencies(f);
      await expect(
        service(f, deps).execute(
          signedRequest(
            f,
            REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission,
            settlementPayload(f, {
              kind: "artifact.open",
              uploadAttempt: 1,
              declaredFileCount: 1,
              declaredTotalBytes: 5,
              stagingRootSha256: D("staging-a"),
              expiresAt: "2099-01-01T00:00:00.000Z",
              ...overrides,
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(RemoteWorkerAssignmentExecutionProtocolError);
      expect(deps.nonceConsumer.consume).not.toHaveBeenCalled();
    }
  });

  it("collapses an oversized owner response after the nonce instead of returning it", async () => {
    const f = fixture();
    const deps = dependencies(f);
    deps.inference.performInference.mockResolvedValueOnce({
      disposition: "delivered" as const,
      request: Object.freeze(inferenceRequestRecord()),
      frames: Object.freeze([{ ...inferenceFrameRecord(), payloadJson: "x".repeat(600_000) }]),
    });
    await expect(
      service(f, deps).execute(
        signedRequest(f, REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange, inferencePayload(f)),
      ),
    ).rejects.toThrow("byte limit");
    expect(deps.nonceConsumer.consume).toHaveBeenCalledOnce();
  });
});

import { dispatchArtifactSubmission, isArtifactSubmission, type ArtifactSubmission, type ArtifactSubmissionDependencies } from "./remote-worker-artifact-submissions.js";
import {
  inferenceRequestProjection,
  inferenceFrameProjection,
  type RemoteWorkerInferenceExchangeRequestProjection,
  type RemoteWorkerInferenceExchangeFrameProjection,
} from "./remote-worker-inference-exchange-projections.js";
export type { RemoteWorkerInferenceExchangeRequestProjection, RemoteWorkerInferenceExchangeFrameProjection } from "./remote-worker-inference-exchange-projections.js";
import { createHash } from "node:crypto";
import { normalizeRemoteWorkerNativePoolPageSubmission, type RemoteWorkerNativePoolPageSubmission, type RemoteWorkerNativePoolPage } from "@goatcitadel/contracts";
import { normalizeRemoteWorkerNativePoolCleanupPageSubmission, type RemoteWorkerNativePoolCleanupPageSubmission } from "@goatcitadel/contracts";
import { snapshotHeaders, snapshotTransportIdentity, snapshotExecutionResponse as responseSnapshot } from "./remote-worker-assignment-execution-transport.js";
import {
  REMOTE_WORKER_INFERENCE_EXECUTION_TIMEOUT_MS,
  REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  REMOTE_WORKER_POP_V2_ROUTE_BINDINGS,
  REMOTE_WORKER_ROUTE_ACCESS_CLASS,
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  authorizeRemoteWorkerInferenceRequestSubmission,
  canonicalJsonString,
  evaluateRemoteWorkerRuntimeCredentialRoutePolicy,
  normalizeRemoteWorkerArtifactManifest,
  normalizeRemoteWorkerArtifactPart,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerArtifactPartDescriptor,
  normalizeRemoteWorkerChatToolSubmission,
  normalizeRemoteWorkerCellProvisioningSubmission,
  normalizeRemoteWorkerCellCapacitySubmission,
  type RemoteWorkerCellCapacitySubmission, type RemoteWorkerCellCapacityExchange,
  normalizeRemoteWorkerCellBackingCapacitySubmission,
  type RemoteWorkerCellBackingCapacitySubmission, type RemoteWorkerCellBackingCapacityExchange,
  normalizeRemoteWorkerCellPreparationSubmission, type RemoteWorkerCellPreparationSubmission, type RemoteWorkerCellPreparation,
  normalizeRemoteWorkerMeshNodeAuthorityFence,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentRecord,
  type RemoteWorkerInferenceRequestSubmission,
  type RemoteWorkerChatToolSubmission,
  type RemoteWorkerChatToolResult,
  type RemoteWorkerCellProvisioningSubmission,
  type RemoteWorkerCellProvisioningExchange,
  type RemoteWorkerPopV2RouteBinding,
  type ResolvedRemoteWorkerAssignmentAuthority,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerArtifactUploadRecord,
  RemoteWorkerAssignmentProtectedCommitFence,
} from "@goatcitadel/storage";
import { snapshotRemoteWorkerAssignmentDispatchAuthority } from "./remote-worker-assignment-dispatch-service.js";
import type { RemoteWorkerAssignmentMeshAuthorityPort } from "./remote-worker-assignment-protocol-service.js";
import type {
  CurrentRemoteWorkerRuntimeCredentialAuthority,
  RemoteWorkerCurrentRuntimeCredentialAuthorityPort,
} from "./remote-worker-current-authority-service.js";
import type {
  DispatchRemoteWorkerEffectInput,
  DispatchRemoteWorkerEffectResult,
} from "./remote-worker-effect-settlement-service.js";
import type {
  RemoteWorkerInferencePerformInput,
  RemoteWorkerInferencePerformOutcome,
} from "./remote-worker-inference-service.js";
import type { DispatchRemoteWorkerChatToolInput } from "./remote-worker-chat-tool-runtime.js";
import { dispatchNativeSubmission, type NativeSubmissionDependencies } from "./remote-worker-native-submissions.js";
import { type NativeRuntimeSubmission, type NativeRuntimeSubmissionResult } from "./remote-worker-native-runtime-submissions.js";
import { type NativeFileSubmission, type NativeFileSubmissionResult } from "./remote-worker-native-file-submissions.js";
import { normalizeRemoteWorkerCellObjectInventoryPageSubmission, type RemoteWorkerCellObjectInventoryPageSubmission,
  type RemoteWorkerCellObjectInventoryPageExchange } from "@goatcitadel/contracts";
import {
  RemoteWorkerAssignmentExecutionProtocolError,
  assertPlainRecord,
  base64Bytes,
  canonical32ByteSecret,
  canonicalTimestamp,
  digest,
  exactOwnDataFields,
  identifier,
  positiveInteger,
  rejected,
  safeDigestEqual,
  normalizeNativeRuntimeSettlementSubmission,
  snapshotClock,
} from "./remote-worker-assignment-execution-validators.js";
import { REMOTE_WORKER_NATIVE_TLS_LIMITS } from "./remote-worker-native-tls-listener.js";
import { normalizeRemoteWorkerNativeCapacityPageSubmission, type RemoteWorkerNativeCapacityPageSubmission,
  type RemoteWorkerNativeCapacityPageExchange } from "@goatcitadel/contracts";
import {
  consumeRemoteWorkerDurableNonce,
  normalizeRemoteWorkerProtocolBody,
  prepareRemoteWorkerProofOfPossession,
  snapshotRemoteWorkerDurableNonceConsumption,
  type RemoteWorkerDurableNonceConsumePort,
  type RemoteWorkerProtocolBody,
  type RemoteWorkerResolvedAuthority,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerRequestHeaders, RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

type Awaitable<T> = T | Promise<T>;

// Re-exported so the wire owner remains the single import surface for callers.
export { RemoteWorkerAssignmentExecutionProtocolError } from "./remote-worker-assignment-execution-validators.js";

export const REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-execution-response.v1" as const;
export { REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION } from "@goatcitadel/contracts";
export { REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION } from "@goatcitadel/contracts";

/**
 * Owner-call ceiling, pinned strictly below the native listener's per-request
 * deadline so no inner owner keeps working (installing CAS blobs, holding a
 * budget reservation) after the socket the request arrived on is destroyed.
 */
export const REMOTE_WORKER_EXECUTION_OWNER_TIMEOUT_MS = REMOTE_WORKER_NATIVE_TLS_LIMITS.requestTimeoutMs - 1_000;

/** Per-payload ceiling mirroring the routes 2-6 RPC bound, below the 512 KiB body cap. */
export const REMOTE_WORKER_ASSIGNMENT_EXECUTION_MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Contract-owned execution purposes. Route 11 carries the HX-503 inference
 * request/response proxy; route 12 carries the HX-506 artifact/effect
 * settlement submission. Both stay production-dark until the flag-gated
 * runtime composition supplies every owner.
 */
export const REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES = Object.freeze({
  inferenceExchange: contractExecutionRoute(11),
  settlementSubmission: contractExecutionRoute(12),
} as const);

type RemoteWorkerAssignmentExecutionRoute =
  (typeof REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES)[keyof typeof REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES];

export interface RemoteWorkerAssignmentExecutionProtocolRequest {
  readonly method: string;
  readonly rawPath: string;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: unknown;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
  readonly signal?: AbortSignal;
}

export interface RemoteWorkerAssignmentExecutionProtocolPort {
  execute(
    input: RemoteWorkerAssignmentExecutionProtocolRequest,
  ): Promise<RemoteWorkerAssignmentExecutionProtocolResponse>;
}

/**
 * The production-dark HX-503 owner. It re-authorizes the submission at its own
 * boundary (the sole raw-lease hash point) and resolves the active assignment
 * authority through its own injected lease resolver.
 *
 * The wire owner passes the server-resolved protected commit fence and connection
 * cancellation signal. Inner execution owners must recheck that fence at their
 * mutation and provider-dispatch boundaries; the initial read is not a grant.
 */
export interface RemoteWorkerInferenceExchangeOwnerPort {
  performInference(input: RemoteWorkerInferencePerformInput): Awaitable<RemoteWorkerInferencePerformOutcome>;
}

/** The production-dark HX-506 owners: CAS-backed artifacts plus coordinated external effects. */
export interface RemoteWorkerSettlementSubmissionOwnerPort extends NativeSubmissionDependencies, ArtifactSubmissionDependencies {
  readonly effects: {
    dispatchEffect(input: DispatchRemoteWorkerEffectInput): Awaitable<DispatchRemoteWorkerEffectResult>;
  };
  readonly chatTools?: {
    dispatchTool(input: DispatchRemoteWorkerChatToolInput): Awaitable<RemoteWorkerChatToolResult>;
  };
}

export interface RemoteWorkerAssignmentExecutionStorePort {
  findAssignmentAggregate(
    registryWorkspaceId: string,
    assignmentId: string,
  ): Awaitable<
    | {
        readonly assignment: RemoteWorkerAssignmentRecord;
        readonly generation?: RemoteWorkerAssignmentGenerationRecord;
        readonly lease?: unknown;
      }
    | undefined
  >;
  resolveActiveAuthorityByLeaseTokenHash(
    leaseTokenSha256: string,
    expectedProtectedAuthority: RemoteWorkerAssignmentProtectedCommitFence,
  ): Awaitable<ResolvedRemoteWorkerAssignmentAuthority | undefined>;
}

export interface RemoteWorkerAssignmentExecutionProtocolDependencies {
  readonly credentialAuthority: RemoteWorkerCurrentRuntimeCredentialAuthorityPort;
  readonly nonceConsumer: RemoteWorkerDurableNonceConsumePort;
  readonly meshAdmissions: RemoteWorkerAssignmentMeshAuthorityPort;
  readonly assignments: RemoteWorkerAssignmentExecutionStorePort;
  readonly inference: RemoteWorkerInferenceExchangeOwnerPort;
  readonly settlement: RemoteWorkerSettlementSubmissionOwnerPort;
  readonly clock: () => Date;
}

type ResponseBase = Readonly<{
  schemaVersion: typeof REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION;
  operation: RemoteWorkerAssignmentExecutionRoute["operation"];
  registryWorkspaceId: string;
}>;

export type RemoteWorkerAssignmentExecutionProtocolResponse =
  | (ResponseBase &
      Readonly<{
        disposition: RemoteWorkerInferencePerformOutcome["disposition"];
        request: RemoteWorkerInferenceExchangeRequestProjection;
        frames: readonly RemoteWorkerInferenceExchangeFrameProjection[];
      }>)
  | (ResponseBase &
      Readonly<{
        disposition: "artifact_recorded";
        upload: RemoteWorkerArtifactUploadRecord;
      }>)
  | (ResponseBase &
      Readonly<{
        disposition: "effect_settled" | "effect_waiting";
        effect: DispatchRemoteWorkerEffectResult;
      }>)
  | (ResponseBase & Readonly<{ disposition: "chat_tool_recorded"; tool: RemoteWorkerChatToolResult }>)
  | (ResponseBase & Readonly<{ disposition: "cell_provisioning_recorded"; cellProvisioning: RemoteWorkerCellProvisioningExchange }>)
  | (ResponseBase & Readonly<{ disposition: "cell_capacity_snapshot" | "cell_capacity_recorded"; cellCapacity: RemoteWorkerCellCapacityExchange }>)
  | (ResponseBase & Readonly<{ disposition: "cell_backing_capacity_snapshot" | "cell_backing_capacity_recorded"; cellBackingCapacity: RemoteWorkerCellBackingCapacityExchange }>)
  | (ResponseBase & Readonly<{ disposition: "cell_object_inventory_page"; cellObjectInventoryPage: RemoteWorkerCellObjectInventoryPageExchange }>)
  | (ResponseBase & Readonly<{ disposition: "native_capacity_page"; nativeCapacityPage: RemoteWorkerNativeCapacityPageExchange }>)
  | (ResponseBase & Readonly<{ disposition: "native_pool_page"; nativePoolPage: RemoteWorkerNativePoolPage }>)
  | (ResponseBase & Readonly<{ disposition: "native_pool_cleanup_page"; nativePoolPage: RemoteWorkerNativePoolPage }>)
  | (ResponseBase & NativeRuntimeSubmissionResult)
  | (ResponseBase & NativeFileSubmissionResult)
  | (ResponseBase & Readonly<{ disposition: "cell_provisioning_prepared"; cellPreparation: RemoteWorkerCellPreparation }>);

interface InferencePayload {
  readonly kind: "inference";
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly submission: RemoteWorkerInferenceRequestSubmission;
  readonly leaseTokenSha256: string;
  readonly assignmentGeneration: number;
}

interface SettlementEnvelope {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly leaseRevision: number;
  readonly leaseTokenSha256: string;
}

type SettlementSubmission =
  | RemoteWorkerNativePoolPageSubmission
  | RemoteWorkerNativePoolCleanupPageSubmission
  | RemoteWorkerChatToolSubmission
  | RemoteWorkerCellProvisioningSubmission
  | RemoteWorkerCellCapacitySubmission
  | RemoteWorkerCellBackingCapacitySubmission
  | RemoteWorkerCellPreparationSubmission
  | RemoteWorkerCellObjectInventoryPageSubmission
  | RemoteWorkerNativeCapacityPageSubmission
  | NativeRuntimeSubmission
  | NativeFileSubmission
  | ArtifactSubmission
  | Readonly<{
      kind: "effect.dispatch";
      intentIndex: number;
      effectSelector: string;
      canonicalArgs: unknown;
      workerIdempotencyKey: string;
    }>;

interface SettlementPayload extends SettlementEnvelope {
  readonly kind: "settlement";
  readonly submission: SettlementSubmission;
}

type NormalizedPayload = InferencePayload | SettlementPayload;

interface SnapshotRequest {
  readonly signal?: AbortSignal;
  readonly method: "POST";
  readonly rawPath: RemoteWorkerAssignmentExecutionRoute["rawPath"];
  readonly route: RemoteWorkerAssignmentExecutionRoute;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: RemoteWorkerProtocolBody;
  readonly payload: NormalizedPayload;
  readonly credentialTokenSha256: string;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

/** Protected-v2 routes 11-12 share canonical credential, PoP, durable nonce,
 * mesh admission and transactional assignment checks. Inference, settlement
 * and cell checkpoint owners must also recheck authority at their own commit
 * boundaries. The inference owner hashes its raw lease; settlement hashes it
 * here and never persists or returns the secret. */
export class RemoteWorkerAssignmentExecutionProtocolService implements RemoteWorkerAssignmentExecutionProtocolPort {
  public constructor(private readonly dependencies: RemoteWorkerAssignmentExecutionProtocolDependencies) {
    if (typeof dependencies.clock !== "function") throw rejected("Remote worker execution clock is unavailable.");
  }

  public async execute(
    input: RemoteWorkerAssignmentExecutionProtocolRequest,
  ): Promise<RemoteWorkerAssignmentExecutionProtocolResponse> {
    let request: SnapshotRequest | undefined;
    try {
      request = snapshotRequest(input);
      const now = snapshotClock(this.dependencies.clock());
      const resolved = await this.dependencies.credentialAuthority.resolveByCredentialTokenSha256(
        request.credentialTokenSha256,
      );
      if (resolved === undefined) throw rejected("Remote worker execution credential authority is unavailable.");
      const authority = snapshotRemoteWorkerAssignmentDispatchAuthority(resolved);
      if (!safeDigestEqual(authority.current.authorizationCredentialSha256, request.credentialTokenSha256)) {
        throw rejected("Remote worker execution credential authority is inconsistent.");
      }
      assertTransportAuthorityBinding(authority.current, request.transportIdentity);
      const protocolAuthority: RemoteWorkerResolvedAuthority = Object.freeze({
        kind: "credential",
        authorityId: authority.current.credentialId,
        authorityGeneration: authority.current.credentialGeneration,
        workerGeneration: authority.current.workerGeneration,
        authorizationCredentialSha256: authority.current.authorizationCredentialSha256,
        publicKeySpkiDer: Buffer.from(authority.current.publicKeySpkiDer),
        publicKeySpkiSha256: authority.current.publicKeySpkiSha256,
      });
      const prepared = prepareRemoteWorkerProofOfPossession({
        method: request.method,
        rawPath: request.rawPath,
        headers: request.headers,
        body: request.body,
        expectedOperation: request.route.operation,
        authority: protocolAuthority,
        proofRequirement: "protected_v2_required",
        transportIdentity: request.transportIdentity,
        now,
      });
      if (
        canonicalJsonString(prepared.body) !== canonicalJsonString(request.body) ||
        request.payload.registryWorkspaceId !== authority.current.registryWorkspaceId
      ) {
        throw rejected("Remote worker execution request authority is inconsistent.");
      }
      const nonce = snapshotRemoteWorkerDurableNonceConsumption({
        authority: Object.freeze({
          kind: "credential",
          registryWorkspaceId: authority.current.registryWorkspaceId,
          workerId: authority.current.workerId,
          workerGeneration: authority.current.workerGeneration,
          credentialGeneration: authority.current.credentialGeneration,
          credentialId: authority.current.credentialId,
        }),
        nonce: prepared.nonce.nonce,
        timestamp: prepared.nonce.timestamp,
        authorityId: prepared.nonce.authorityId,
        authorityGeneration: prepared.nonce.authorityGeneration,
      });
      let consumed: boolean;
      try {
        consumed = await consumeRemoteWorkerDurableNonce(this.dependencies.nonceConsumer, nonce);
      } catch {
        throw rejected("Remote worker execution replay protection is unavailable.");
      }
      if (!consumed) throw rejected("Remote worker execution request nonce was already consumed.");
      const fencedRecords = await this.recheckProtectedFenceInTransaction(request.payload, authority.current);
      return await this.executeAuthorized(request.route, request.body.idempotencyKey, request.payload, {
        authority: authority.current,
        ...fencedRecords,
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof RemoteWorkerAssignmentExecutionProtocolError) throw error;
      throw rejected("Remote worker assignment execution could not be completed.");
    } finally {
      request?.transportIdentity.tlsExporter.fill(0);
    }
  }

  /**
   * Resolve the protected commit fence (current M2 credential + protected
   * admission evidence + current mesh-node admission for the assignment's
   * execution workspace) and require assignment storage to recheck it under
   * the canonical generation locks while resolving the exact live lease.
   */
  private async recheckProtectedFenceInTransaction(
    payload: NormalizedPayload,
    credential: CurrentRemoteWorkerRuntimeCredentialAuthority,
  ): Promise<{
    records: ResolvedRemoteWorkerAssignmentAuthority;
    protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence;
  }> {
    const aggregate = await this.dependencies.assignments.findAssignmentAggregate(
      payload.registryWorkspaceId,
      payload.assignmentId,
    );
    if (aggregate === undefined || aggregate.generation === undefined) {
      throw rejected("Remote worker execution assignment authority is unavailable.");
    }
    const fence = await this.resolveProtectedCommitFence(credential, aggregate.assignment, aggregate.generation);
    let resolved: ResolvedRemoteWorkerAssignmentAuthority | undefined;
    try {
      resolved = await this.dependencies.assignments.resolveActiveAuthorityByLeaseTokenHash(
        payload.leaseTokenSha256,
        fence,
      );
    } catch {
      throw rejected("Remote worker execution protected fence was rejected in the storage transaction.");
    }
    if (
      resolved === undefined ||
      resolved.assignment.registryWorkspaceId !== payload.registryWorkspaceId ||
      resolved.assignment.assignmentId !== payload.assignmentId ||
      resolved.generation.assignmentGeneration !== payload.assignmentGeneration ||
      resolved.generation.workerId !== credential.workerId ||
      resolved.generation.workerGeneration !== credential.workerGeneration ||
      (payload.kind === "settlement" && resolved.lease.leaseRevision !== payload.leaseRevision)
    ) {
      throw rejected("Remote worker execution lease authority is unavailable.");
    }
    return { records: resolved, protectedAuthority: fence };
  }

  private async resolveProtectedCommitFence(
    credential: CurrentRemoteWorkerRuntimeCredentialAuthority,
    assignment: RemoteWorkerAssignmentRecord,
    generation: RemoteWorkerAssignmentGenerationRecord,
  ): Promise<RemoteWorkerAssignmentProtectedCommitFence> {
    // Same claims-side gate the routes 2-6 owner applies: the immutable
    // workspace/capability ceilings in the credential claims must admit this
    // route class, this execution workspace, and the assignment's required
    // capability classes before any storage authority is consulted.
    const routeDecision = evaluateRemoteWorkerRuntimeCredentialRoutePolicy(credential.claims, {
      routeAccessClass: REMOTE_WORKER_ROUTE_ACCESS_CLASS,
      workspaceId: assignment.manifest.executionWorkspaceId,
      requiredCapabilityClasses: assignment.manifest.requiredCapabilityClasses,
    });
    if (
      !routeDecision.allowed ||
      credential.claims.registryWorkspaceId !== assignment.registryWorkspaceId ||
      !credential.claims.allowedWorkspaceIds.includes(assignment.registryWorkspaceId) ||
      credential.registryWorkspaceId !== assignment.registryWorkspaceId ||
      generation.registryWorkspaceId !== assignment.registryWorkspaceId ||
      generation.assignmentId !== assignment.assignmentId ||
      generation.executionWorkspaceId !== assignment.manifest.executionWorkspaceId ||
      generation.workerId !== credential.workerId ||
      generation.workerGeneration !== credential.workerGeneration ||
      generation.nodeId !== credential.nodeId ||
      generation.runtimeManifestSha256 !== credential.runtimeManifestSha256 ||
      generation.workspaceCeilingSha256 !== credential.workspaceCeilingSha256 ||
      generation.capabilityCeilingSha256 !== credential.capabilityCeilingSha256
    ) {
      throw rejected("Remote worker execution credential does not bind the assignment authority.");
    }
    const resolved = await this.dependencies.meshAdmissions.resolveCurrentForRuntimeCredential({
      registryWorkspaceId: credential.registryWorkspaceId,
      bootstrapId: credential.bootstrapId,
      workerId: credential.workerId,
      workerGeneration: credential.workerGeneration,
      nodeId: credential.nodeId,
      clientCertificateSha256: credential.clientCertificateSha256,
      protectedAdmissionEnvelopeSha256: credential.protectedAdmissionEnvelopeSha256,
      protectedAdmissionContextSha256: credential.protectedAdmissionContextSha256,
      workspaceId: assignment.manifest.executionWorkspaceId,
      credentialId: credential.credentialId,
      credentialGeneration: credential.credentialGeneration,
      authorizationCredentialSha256: credential.authorizationCredentialSha256,
    });
    if (resolved === undefined) {
      throw rejected("Remote worker execution mesh-node authority is unavailable.");
    }
    const meshAdmission = normalizeRemoteWorkerMeshNodeAuthorityFence(resolved);
    if (
      meshAdmission.registryWorkspaceId !== credential.registryWorkspaceId ||
      meshAdmission.bootstrapId !== credential.bootstrapId ||
      meshAdmission.workerId !== credential.workerId ||
      meshAdmission.workerGeneration !== credential.workerGeneration ||
      meshAdmission.credentialId !== credential.credentialId ||
      meshAdmission.credentialGeneration !== credential.credentialGeneration ||
      meshAdmission.workspaceId !== assignment.manifest.executionWorkspaceId ||
      meshAdmission.nodeId !== credential.nodeId ||
      meshAdmission.admissionGeneration !== generation.nodeAdmissionGeneration ||
      meshAdmission.protectedAdmissionEnvelopeSha256 !== credential.protectedAdmissionEnvelopeSha256 ||
      meshAdmission.protectedAdmissionContextSha256 !== credential.protectedAdmissionContextSha256
    ) {
      throw rejected("Remote worker execution mesh-node authority is inconsistent.");
    }
    return Object.freeze({
      credentialAuthority: Object.freeze({
        registryWorkspaceId: credential.registryWorkspaceId,
        bootstrapId: credential.bootstrapId,
        workerId: credential.workerId,
        workerGeneration: credential.workerGeneration,
        credentialId: credential.credentialId,
        credentialGeneration: credential.credentialGeneration,
        authorizationCredentialSha256: credential.authorizationCredentialSha256,
        nodeId: credential.nodeId,
        clientCertificateSha256: credential.clientCertificateSha256,
        runtimeManifestSha256: credential.runtimeManifestSha256,
        workspaceCeilingSha256: credential.workspaceCeilingSha256,
        capabilityCeilingSha256: credential.capabilityCeilingSha256,
        protectedAdmissionEnvelopeSha256: credential.protectedAdmissionEnvelopeSha256,
        protectedAdmissionContextSha256: credential.protectedAdmissionContextSha256,
        claimsSha256: credential.claimsSha256,
      }),
      meshAdmission,
    });
  }

  private async executeAuthorized(
    route: RemoteWorkerAssignmentExecutionRoute,
    idempotencyKey: string,
    payload: NormalizedPayload,
    fenced: {
      readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
      readonly records: ResolvedRemoteWorkerAssignmentAuthority;
      readonly protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence;
      readonly signal?: AbortSignal;
    },
  ): Promise<RemoteWorkerAssignmentExecutionProtocolResponse> {
    if (
      payload.kind === "inference" &&
      route.code === REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange.code
    ) {
      const outcome = await this.dependencies.inference.performInference({
        submission: payload.submission,
        protectedAuthority: fenced.protectedAuthority,
        signal: executionSignal(fenced.signal, REMOTE_WORKER_INFERENCE_EXECUTION_TIMEOUT_MS),
      });
      return responseSnapshot({
        ...responseBase(route, fenced.authority.registryWorkspaceId),
        disposition: outcome.disposition,
        request: inferenceRequestProjection(outcome.request),
        frames: Object.freeze(outcome.frames.map((frame) => inferenceFrameProjection(frame))),
      });
    }
    if (
      payload.kind === "settlement" &&
      route.code === REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.settlementSubmission.code
    ) {
      return await this.settle(route, idempotencyKey, payload, fenced);
    }
    throw rejected("Remote worker assignment execution route and payload disagree.");
  }

  private async settle(
    route: RemoteWorkerAssignmentExecutionRoute,
    idempotencyKey: string,
    payload: SettlementPayload,
    fenced: {
      readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
      readonly records: ResolvedRemoteWorkerAssignmentAuthority;
      readonly protectedAuthority: RemoteWorkerAssignmentProtectedCommitFence;
      readonly signal?: AbortSignal;
    },
  ): Promise<RemoteWorkerAssignmentExecutionProtocolResponse> {
    const base = responseBase(route, fenced.authority.registryWorkspaceId);
    const identity = Object.freeze({
      registryWorkspaceId: payload.registryWorkspaceId,
      assignmentId: payload.assignmentId,
      assignmentGeneration: payload.assignmentGeneration,
      leaseTokenSha256: payload.leaseTokenSha256,
      protectedAuthority: fenced.protectedAuthority,
    });
    const submission = payload.submission;
    const native = await dispatchNativeSubmission(this.dependencies.settlement,
      { ...identity, leaseRevision: payload.leaseRevision, submission, signal: executionSignal(fenced.signal) });
    if (native) return responseSnapshot({ ...base, ...native });
    if (submission.kind === "chat.tool") {
      const owner = this.dependencies.settlement.chatTools;
      if (!owner) throw rejected("Worker Chat tool execution is unavailable.");
      const tool = await owner.dispatchTool({
        fence: { ...identity, sessionControlGeneration: null },
        submission, signal: executionSignal(fenced.signal),
      });
      return responseSnapshot({ ...base, disposition: "chat_tool_recorded", tool });
    }
    if (isArtifactSubmission(submission)) return responseSnapshot({ ...base, ...await dispatchArtifactSubmission(this.dependencies.settlement,
      { identity, submission, idempotencyKey, fenced, signal: executionSignal(fenced.signal) }) });
    if (submission.kind !== "effect.dispatch") throw rejected("Unsupported assignment settlement submission.");
    const effect = await this.dependencies.settlement.effects.dispatchEffect({
      fence: {
        registryWorkspaceId: payload.registryWorkspaceId,
        assignmentId: payload.assignmentId,
        assignmentGeneration: payload.assignmentGeneration,
        // Gateway-derived, never worker-supplied. No live HX-411 session-control
        // owner is composed while this route is production-dark, so the fence
        // pins "no session-control generation" rather than a worker's claim.
        sessionControlGeneration: null,
        leaseTokenSha256: payload.leaseTokenSha256,
        protectedAuthority: fenced.protectedAuthority,
      },
      intentIndex: submission.intentIndex,
      effectSelector: submission.effectSelector,
      canonicalArgs: submission.canonicalArgs,
      workerIdempotencyKey: submission.workerIdempotencyKey,
      intentIdempotencyKey: idempotencyKey,
      signal: executionSignal(fenced.signal),
    });
    return responseSnapshot({ ...base, disposition: effect.receipt ? "effect_settled" : "effect_waiting", effect });
  }
}

function snapshotRequest(value: unknown): SnapshotRequest {
  const fields = exactOwnDataFields(
    value,
    ["method", "rawPath", "headers", "body", "transportIdentity"],
    ["signal"],
    "execution protocol input",
  );
  if (fields.method !== "POST" || typeof fields.rawPath !== "string") {
    throw rejected("Remote worker assignment execution target is invalid.");
  }
  if (fields.signal !== undefined && !(fields.signal instanceof AbortSignal)) {
    throw rejected("Remote worker execution lifetime is invalid.");
  }
  const route = routeForPath(fields.rawPath);
  const headers = snapshotHeaders(fields.headers);
  const body = normalizeRemoteWorkerProtocolBody(fields.body);
  if (body.operation !== route.operation) {
    throw rejected("Remote worker assignment execution operation is invalid.");
  }
  return Object.freeze({
    method: "POST",
    rawPath: route.rawPath,
    route,
    headers,
    body,
    payload: normalizePayload(route, body.payload),
    credentialTokenSha256: credentialAuthorizationSha256(headers),
    transportIdentity: snapshotTransportIdentity(fields.transportIdentity),
    ...(fields.signal ? { signal: fields.signal as AbortSignal } : {}),
  });
}

function executionSignal(signal?: AbortSignal, timeoutMs = REMOTE_WORKER_EXECUTION_OWNER_TIMEOUT_MS): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function routeForPath(rawPath: string): RemoteWorkerAssignmentExecutionRoute {
  const route = Object.values(REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES).find(
    (candidate) => candidate.rawPath === rawPath,
  );
  if (route === undefined) throw rejected("Remote worker assignment execution route is unavailable.");
  return route;
}

function normalizePayload(route: RemoteWorkerAssignmentExecutionRoute, value: unknown): NormalizedPayload {
  if (Buffer.byteLength(canonicalJsonString(value), "utf8") > REMOTE_WORKER_ASSIGNMENT_EXECUTION_MAX_PAYLOAD_BYTES) {
    throw rejected("Remote worker assignment execution payload exceeds its byte limit.");
  }
  if (route.code === REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange.code) {
    return normalizeInferencePayload(value);
  }
  return normalizeSettlementPayload(value);
}

function normalizeInferencePayload(value: unknown): InferencePayload {
  const fields = exactOwnDataFields(
    value,
    ["schemaVersion", "registryWorkspaceId", "assignmentId", "submission"],
    [],
    "inference exchange payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment inference exchange schema is invalid.");
  }
  const registryWorkspaceId = identifier(fields.registryWorkspaceId, "registryWorkspaceId");
  const assignmentId = identifier(fields.assignmentId, "assignmentId");
  // The canonical contracts boundary is the ONLY raw-lease hash point. It
  // validates the exact submission shape and returns the lease digest without
  // copying the raw token; the untouched submission is handed to the owner,
  // which re-authorizes through the same sole boundary.
  let leaseTokenSha256: string;
  let authorized: ReturnType<typeof authorizeRemoteWorkerInferenceRequestSubmission>;
  try {
    authorized = authorizeRemoteWorkerInferenceRequestSubmission(
      fields.submission as RemoteWorkerInferenceRequestSubmission,
    );
    leaseTokenSha256 = authorized.leaseTokenSha256;
  } catch {
    throw rejected("Remote worker assignment inference submission is invalid.");
  }
  if (
    authorized.submission.registryWorkspaceId !== registryWorkspaceId ||
    authorized.submission.assignmentId !== assignmentId
  ) {
    throw rejected("Remote worker assignment inference submission does not bind the envelope.");
  }
  return Object.freeze({
    kind: "inference",
    registryWorkspaceId,
    assignmentId,
    submission: fields.submission as RemoteWorkerInferenceRequestSubmission,
    leaseTokenSha256,
    assignmentGeneration: authorized.submission.assignmentGeneration,
  });
}

function normalizeSettlementPayload(value: unknown): SettlementPayload {
  const fields = exactOwnDataFields(
    value,
    [
      "schemaVersion",
      "registryWorkspaceId",
      "assignmentId",
      "assignmentGeneration",
      "leaseRevision",
      "leaseToken",
      "submission",
    ],
    [],
    "settlement submission payload",
  );
  if (fields.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION) {
    throw rejected("Remote worker assignment settlement submission schema is invalid.");
  }
  const rawLeaseToken = canonical32ByteSecret(fields.leaseToken, "leaseToken");
  return Object.freeze({
    kind: "settlement",
    registryWorkspaceId: identifier(fields.registryWorkspaceId, "registryWorkspaceId"),
    assignmentId: identifier(fields.assignmentId, "assignmentId"),
    assignmentGeneration: positiveInteger(fields.assignmentGeneration, "assignmentGeneration"),
    leaseRevision: positiveInteger(fields.leaseRevision, "leaseRevision"),
    leaseTokenSha256: createHash("sha256").update(rawLeaseToken, "utf8").digest("hex"),
    submission: normalizeSettlementSubmission(fields.submission, rawLeaseToken),
  });
}

function normalizeSettlementSubmission(value: unknown, rawLeaseToken: string): SettlementSubmission {
  assertPlainRecord(value, "settlement submission");
  const kind = (value as Record<string, unknown>)["kind"];
  if (kind === "cell.native_pool.page" || kind === "cell.native_pool.cleanup.page") {
    try { return kind === "cell.native_pool.cleanup.page" ? normalizeRemoteWorkerNativePoolCleanupPageSubmission(value) : normalizeRemoteWorkerNativePoolPageSubmission(value); }
    catch { throw rejected("Worker native pool page request is invalid."); }
  }
  const native = normalizeNativeRuntimeSettlementSubmission(value, kind, rawLeaseToken);
  if (native) return native;
  if (kind === "cell.native_capacity.page" || kind === "cell.native_capacity.lookup") {
    try { return normalizeRemoteWorkerNativeCapacityPageSubmission(value); }
    catch { throw rejected("Worker native capacity page submission is invalid."); }
  }
  if (kind === "cell.object_inventory.page" || kind === "cell.object_inventory.page_snapshot") {
    try { return normalizeRemoteWorkerCellObjectInventoryPageSubmission(value); }
    catch { throw rejected("Worker inventory page submission is invalid."); }
  }
  if (kind === "cell.backing_capacity.snapshot" || kind === "cell.backing_capacity.observation") {
    try { return normalizeRemoteWorkerCellBackingCapacitySubmission(value); }
    catch { throw rejected("Worker cell backing capacity submission is invalid."); }
  }
  if (kind === "cell.capacity.snapshot" || kind === "cell.capacity.observation") {
    try { return normalizeRemoteWorkerCellCapacitySubmission(value); }
    catch { throw rejected("Worker cell capacity submission is invalid."); }
  }
  if (kind === "cell.provisioning.prepare") {
    try { return normalizeRemoteWorkerCellPreparationSubmission(value); }
    catch { throw rejected("Worker cell preparation submission is invalid."); }
  }
  if (kind === "cell.provisioning.snapshot" || kind === "cell.provisioning.checkpoint" ||
      kind === "cell.volume.checkpoint" || kind === "cell.format.checkpoint" || kind === "cell.protection.checkpoint" || kind === "cell.mount.checkpoint" || kind === "cell.mounted-workspace.checkpoint") {
    try { return normalizeRemoteWorkerCellProvisioningSubmission(value); }
    catch { throw rejected("Worker cell provisioning submission is invalid."); }
  }
  if (kind === "artifact.open") {
    const fields = exactOwnDataFields(
      value,
      ["kind", "uploadAttempt", "declaredFileCount", "declaredTotalBytes", "stagingRootSha256", "expiresAt"],
      [],
      "artifact open submission",
    );
    return Object.freeze({
      kind: "artifact.open",
      uploadAttempt: positiveInteger(
        fields.uploadAttempt,
        "uploadAttempt",
        REMOTE_WORKER_SETTLEMENT_BOUNDS.maxUploadAttempts,
      ),
      declaredFileCount: positiveInteger(
        fields.declaredFileCount,
        "declaredFileCount",
        REMOTE_WORKER_SETTLEMENT_BOUNDS.maxFiles,
      ),
      declaredTotalBytes: positiveInteger(
        fields.declaredTotalBytes,
        "declaredTotalBytes",
        REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes,
      ),
      stagingRootSha256: digest(fields.stagingRootSha256, "stagingRootSha256"),
      expiresAt: canonicalTimestamp(fields.expiresAt, "expiresAt"),
    });
  }
  if (kind === "artifact.part") {
    const fields = exactOwnDataFields(value, ["kind", "uploadId", "part"], [], "artifact part submission");
    let part: RemoteWorkerArtifactPartDescriptor;
    try {
      part = normalizeRemoteWorkerArtifactPart(fields.part as RemoteWorkerArtifactPartDescriptor);
    } catch {
      throw rejected("Remote worker assignment artifact part is invalid.");
    }
    return Object.freeze({ kind: "artifact.part", uploadId: identifier(fields.uploadId, "uploadId"), part });
  }
  if (kind === "artifact.commit") {
    const fields = exactOwnDataFields(
      value,
      ["kind", "uploadId", "manifest", "files"],
      [],
      "artifact commit submission",
    );
    let manifest: RemoteWorkerArtifactManifest;
    try {
      manifest = normalizeRemoteWorkerArtifactManifest(fields.manifest as RemoteWorkerArtifactManifest);
    } catch {
      throw rejected("Remote worker assignment artifact manifest is invalid.");
    }
    if (!Array.isArray(fields.files) || fields.files.length < 1 || fields.files.length > manifest.entries.length) {
      throw rejected("Remote worker assignment artifact files are invalid.");
    }
    return Object.freeze({
      kind: "artifact.commit",
      uploadId: identifier(fields.uploadId, "uploadId"),
      manifest,
      files: Object.freeze(
        fields.files.map((entry) => {
          const file = exactOwnDataFields(
            entry,
            ["logicalPath", "logicalPathSha256", "bytesBase64", "mimeType"],
            [],
            "artifact commit file",
          );
          return Object.freeze({
            logicalPath: identifier(file.logicalPath, "logicalPath", 1_024),
            logicalPathSha256: digest(file.logicalPathSha256, "logicalPathSha256"),
            bytesBase64: base64Bytes(file.bytesBase64, REMOTE_WORKER_SETTLEMENT_BOUNDS.maxPartBodyBytes),
            mimeType: identifier(file.mimeType, "mimeType"),
          });
        }),
      ),
    });
  }
  if (kind === "effect.dispatch") {
    // HX-506 is explicit that the worker supplies ONLY a bounded selector,
    // canonical args, and an idempotency key; Gateway derives workspace,
    // session, policy, approval, and runtime context. The HX-411
    // sessionControlGeneration is therefore NOT accepted on the wire — a worker
    // must not be able to pin the session-control fence its own effect is
    // evaluated against.
    const fields = exactOwnDataFields(
      value,
      ["kind", "intentIndex", "effectSelector", "canonicalArgs", "workerIdempotencyKey"],
      [],
      "effect dispatch submission",
    );
    return Object.freeze({
      kind: "effect.dispatch",
      intentIndex: positiveInteger(fields.intentIndex, "intentIndex"),
      effectSelector: identifier(fields.effectSelector, "effectSelector"),
      canonicalArgs: fields.canonicalArgs,
      workerIdempotencyKey: identifier(fields.workerIdempotencyKey, "workerIdempotencyKey", 512),
    });
  }
  if (kind === "chat.tool") {
    const fields = exactOwnDataFields(value, ["kind", "inferenceRequestId", "attempt", "callIndex"], [], "Chat tool submission");
    try { return normalizeRemoteWorkerChatToolSubmission(fields); }
    catch { throw rejected("Worker Chat tool selection is invalid."); }
  }
  throw rejected("Remote worker assignment settlement submission kind is invalid.");
}

function responseBase(route: RemoteWorkerAssignmentExecutionRoute, registryWorkspaceId: string): ResponseBase {
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION,
    operation: route.operation,
    registryWorkspaceId,
  });
}

function assertTransportAuthorityBinding(
  authority: CurrentRemoteWorkerRuntimeCredentialAuthority,
  transport: RemoteWorkerTransportIdentity,
): void {
  if (
    transport.source !== "native_mtls" ||
    !safeDigestEqual(transport.publicKeySpkiSha256, authority.publicKeySpkiSha256) ||
    !safeDigestEqual(transport.certificateDerSha256, authority.clientCertificateSha256) ||
    !safeDigestEqual(transport.trustAnchorDerSha256, authority.transportTrustAnchorSha256)
  ) {
    throw rejected("Remote worker assignment execution mutual TLS authority is invalid.");
  }
}

function credentialAuthorizationSha256(headers: RemoteWorkerRequestHeaders): string {
  const authorization = headers.authorization;
  if (typeof authorization !== "string") throw rejected("Remote worker assignment execution authorization is invalid.");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  if (match === null) throw rejected("Remote worker assignment execution authorization is invalid.");
  return createHash("sha256").update(canonical32ByteSecret(match[1], "authorization credential"), "utf8").digest("hex");
}

function contractExecutionRoute<Code extends 11 | 12>(
  code: Code,
): Extract<RemoteWorkerPopV2RouteBinding, { readonly code: Code }> {
  const route = REMOTE_WORKER_POP_V2_ROUTE_BINDINGS.find((candidate) => candidate.code === code);
  if (route === undefined || route.method !== "POST" || route.authorityKind !== "credential") {
    throw new Error(`Remote worker assignment execution route ${String(code)} is unavailable.`);
  }
  return route as Extract<RemoteWorkerPopV2RouteBinding, { readonly code: Code }>;
}

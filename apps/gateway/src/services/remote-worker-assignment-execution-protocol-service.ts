import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import {
  REMOTE_WORKER_POP_V2_ROUTE_BINDINGS,
  REMOTE_WORKER_ROUTE_ACCESS_CLASS,
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  authorizeRemoteWorkerInferenceRequestSubmission,
  canonicalJsonString,
  evaluateRemoteWorkerRuntimeCredentialRoutePolicy,
  normalizeRemoteWorkerArtifactManifest,
  normalizeRemoteWorkerArtifactPart,
  normalizeRemoteWorkerMeshNodeAuthorityFence,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerArtifactPartDescriptor,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentRecord,
  type RemoteWorkerInferenceRequestSubmission,
  type RemoteWorkerPopV2RouteBinding,
  type ResolvedRemoteWorkerAssignmentAuthority,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerArtifactUploadRecord,
  RemoteWorkerAssignmentProtectedCommitFence,
} from "@goatcitadel/storage";
import type {
  AppendPartInput,
  CommitArtifactInput,
  OpenUploadInput,
} from "./remote-worker-artifact-settlement-service.js";
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
  snapshotClock,
} from "./remote-worker-assignment-execution-validators.js";
import { REMOTE_WORKER_NATIVE_TLS_LIMITS } from "./remote-worker-native-tls-listener.js";
import {
  REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES,
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
export const REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-inference-exchange.v1" as const;
export const REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION =
  "goatcitadel.remote-worker-assignment-settlement-submission.v1" as const;

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
 * NOTE the exact division of labour: this wire owner resolves and rechecks the
 * complete protected commit fence in the assignment storage transaction BEFORE
 * calling in, but the inner owner's authority port takes only a lease-token
 * hash, so it cannot re-evaluate that fence itself. Authority revoked strictly
 * between this owner's fenced read and the inner owner's own lease read is
 * therefore caught only by the inner owner's lease check. Closing that window
 * requires a fence parameter on the inner ports and is deliberately out of
 * scope while both owners stay production-dark.
 */
export interface RemoteWorkerInferenceExchangeOwnerPort {
  performInference(input: RemoteWorkerInferencePerformInput): Awaitable<RemoteWorkerInferencePerformOutcome>;
}

/** The production-dark HX-506 owners: CAS-backed artifacts plus coordinated external effects. */
export interface RemoteWorkerSettlementSubmissionOwnerPort {
  readonly artifacts: {
    openUpload(input: OpenUploadInput): Awaitable<RemoteWorkerArtifactUploadRecord>;
    appendPart(input: AppendPartInput): Awaitable<RemoteWorkerArtifactUploadRecord>;
    commitArtifact(input: CommitArtifactInput): Awaitable<RemoteWorkerArtifactUploadRecord>;
  };
  readonly effects: {
    dispatchEffect(input: DispatchRemoteWorkerEffectInput): Awaitable<DispatchRemoteWorkerEffectResult>;
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

type InferenceRequestRecord = RemoteWorkerInferencePerformOutcome["request"];
type InferenceFrameRecord = RemoteWorkerInferencePerformOutcome["frames"][number];

/**
 * Secret-free wire projection of the HX-503 request record. The stored record
 * additionally carries server-internal budget reservation, policy revision,
 * approval-resolution, dispatch-claim, and effective-route material (including
 * provider credential fingerprints and per-token pricing); none of that may
 * cross to a remote worker, so the projection is an explicit allowlist rather
 * than an omission list.
 */
export interface RemoteWorkerInferenceExchangeRequestProjection {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly state: InferenceRequestRecord["state"];
  readonly governanceDecision: InferenceRequestRecord["governanceDecision"];
  readonly requestSha256: string;
  readonly outputTokenCeiling: number;
  readonly reasoningTokenCeiling: number;
  readonly governanceOutputTokenCeiling: number;
  readonly governanceReasoningTokenCeiling: number;
  readonly governanceExpiresAt: string;
}

/** Secret-free wire projection of one ordered provider-output frame. */
export interface RemoteWorkerInferenceExchangeFrameProjection {
  readonly frameSequence: number;
  readonly frameKind: InferenceFrameRecord["frameKind"];
  readonly payloadJson: string;
  readonly payloadSha256: string;
  readonly previousFrameSha256: string;
  readonly frameSha256: string;
  readonly frameCharCount: number;
  readonly createdAt: string;
  readonly usageEventId?: string;
}

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
        disposition: "effect_settled";
        effect: DispatchRemoteWorkerEffectResult;
      }>);

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
  | Readonly<{
      kind: "artifact.open";
      uploadAttempt: number;
      declaredFileCount: number;
      declaredTotalBytes: number;
      stagingRootSha256: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: "artifact.part"; uploadId: string; part: RemoteWorkerArtifactPartDescriptor }>
  | Readonly<{
      kind: "artifact.commit";
      uploadId: string;
      manifest: RemoteWorkerArtifactManifest;
      files: readonly Readonly<{
        logicalPath: string;
        logicalPathSha256: string;
        bytesBase64: string;
        mimeType: string;
      }>[];
    }>
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
  readonly method: "POST";
  readonly rawPath: RemoteWorkerAssignmentExecutionRoute["rawPath"];
  readonly route: RemoteWorkerAssignmentExecutionRoute;
  readonly headers: RemoteWorkerRequestHeaders;
  readonly body: RemoteWorkerProtocolBody;
  readonly payload: NormalizedPayload;
  readonly credentialTokenSha256: string;
  readonly transportIdentity: RemoteWorkerTransportIdentity;
}

/**
 * Production-dark protected-v2 wire owner for route codes 11-12. It carries the
 * routes 2-6 fence discipline verbatim: resolve the canonical M2
 * credential/protected authority before PoP, consume the durable nonce before
 * any owner outcome is observed, resolve the current mesh-node admission for
 * the assignment's execution workspace, then recheck that complete protected
 * commit fence inside the assignment storage transaction
 * (`resolveActiveAuthorityByLeaseTokenHash` with the fence) before the HX-503
 * inference owner or HX-506 settlement owner is reached. The raw inference
 * lease is hashed only by the owner's canonical authorize boundary; the raw
 * settlement lease is hashed here and never persisted or returned.
 */
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
        records: fencedRecords,
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
  ): Promise<ResolvedRemoteWorkerAssignmentAuthority> {
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
    return resolved;
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
    },
  ): Promise<RemoteWorkerAssignmentExecutionProtocolResponse> {
    if (
      payload.kind === "inference" &&
      route.code === REMOTE_WORKER_ASSIGNMENT_EXECUTION_ROUTES.inferenceExchange.code
    ) {
      const outcome = await this.dependencies.inference.performInference({ submission: payload.submission });
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
    },
  ): Promise<RemoteWorkerAssignmentExecutionProtocolResponse> {
    const base = responseBase(route, fenced.authority.registryWorkspaceId);
    const identity = Object.freeze({
      registryWorkspaceId: payload.registryWorkspaceId,
      assignmentId: payload.assignmentId,
      assignmentGeneration: payload.assignmentGeneration,
      leaseTokenSha256: payload.leaseTokenSha256,
    });
    const submission = payload.submission;
    if (submission.kind === "artifact.open") {
      const upload = await this.dependencies.settlement.artifacts.openUpload({
        ...identity,
        uploadAttempt: submission.uploadAttempt,
        declaredFileCount: submission.declaredFileCount,
        declaredTotalBytes: submission.declaredTotalBytes,
        stagingRootSha256: submission.stagingRootSha256,
        expiresAt: submission.expiresAt,
        idempotencyKey,
      });
      return responseSnapshot({ ...base, disposition: "artifact_recorded", upload });
    }
    if (submission.kind === "artifact.part") {
      const upload = await this.dependencies.settlement.artifacts.appendPart({
        ...identity,
        uploadId: submission.uploadId,
        part: submission.part,
        idempotencyKey,
      });
      return responseSnapshot({ ...base, disposition: "artifact_recorded", upload });
    }
    if (submission.kind === "artifact.commit") {
      // The manifest carries a full settlement identity, and the CAS writer
      // shards blobs by its executionWorkspaceId BEFORE storage compares the
      // manifest identity. Bind every field to the fenced records here so a
      // worker holding one assignment's lease cannot stage bytes under another
      // workspace, worker, or generation.
      assertManifestIdentityBinding(submission.manifest, fenced);
      const upload = await this.dependencies.settlement.artifacts.commitArtifact({
        ...identity,
        uploadId: submission.uploadId,
        manifest: submission.manifest,
        files: submission.files.map((file) =>
          Object.freeze({
            logicalPath: file.logicalPath,
            logicalPathSha256: file.logicalPathSha256,
            bytes: Buffer.from(file.bytesBase64, "base64"),
            mimeType: file.mimeType,
          }),
        ),
        idempotencyKey,
        // Bounded strictly below the native listener's per-request deadline so
        // a CAS commit cannot keep installing blobs after the socket is gone
        // and the durable nonce is already spent.
        signal: AbortSignal.timeout(REMOTE_WORKER_EXECUTION_OWNER_TIMEOUT_MS),
      });
      return responseSnapshot({ ...base, disposition: "artifact_recorded", upload });
    }
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
      },
      intentIndex: submission.intentIndex,
      effectSelector: submission.effectSelector,
      canonicalArgs: submission.canonicalArgs,
      workerIdempotencyKey: submission.workerIdempotencyKey,
      intentIdempotencyKey: idempotencyKey,
    });
    return responseSnapshot({ ...base, disposition: "effect_settled", effect });
  }
}

function snapshotRequest(value: unknown): SnapshotRequest {
  const fields = exactOwnDataFields(
    value,
    ["method", "rawPath", "headers", "body", "transportIdentity"],
    [],
    "execution protocol input",
  );
  if (fields.method !== "POST" || typeof fields.rawPath !== "string") {
    throw rejected("Remote worker assignment execution target is invalid.");
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
  });
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
    submission: normalizeSettlementSubmission(fields.submission),
  });
}

function normalizeSettlementSubmission(value: unknown): SettlementSubmission {
  assertPlainRecord(value, "settlement submission");
  const kind = (value as Record<string, unknown>)["kind"];
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
  throw rejected("Remote worker assignment settlement submission kind is invalid.");
}

function inferenceRequestProjection(record: InferenceRequestRecord): RemoteWorkerInferenceExchangeRequestProjection {
  return Object.freeze({
    registryWorkspaceId: record.registryWorkspaceId,
    assignmentId: record.assignmentId,
    assignmentGeneration: record.assignmentGeneration,
    inferenceRequestId: record.inferenceRequestId,
    attempt: record.attempt,
    state: record.state,
    governanceDecision: record.governanceDecision,
    requestSha256: record.requestSha256,
    outputTokenCeiling: record.outputTokenCeiling,
    reasoningTokenCeiling: record.reasoningTokenCeiling,
    governanceOutputTokenCeiling: record.governanceOutputTokenCeiling,
    governanceReasoningTokenCeiling: record.governanceReasoningTokenCeiling,
    governanceExpiresAt: record.governanceExpiresAt,
  });
}

function inferenceFrameProjection(record: InferenceFrameRecord): RemoteWorkerInferenceExchangeFrameProjection {
  return Object.freeze({
    frameSequence: record.frameSequence,
    frameKind: record.frameKind,
    payloadJson: record.payloadJson,
    payloadSha256: record.payloadSha256,
    previousFrameSha256: record.previousFrameSha256,
    frameSha256: record.frameSha256,
    frameCharCount: record.frameCharCount,
    createdAt: record.createdAt,
    ...(record.usageEventId === undefined ? {} : { usageEventId: record.usageEventId }),
  });
}

/**
 * Bind the worker-declared artifact manifest identity to the fenced records.
 * `normalizeRemoteWorkerArtifactManifest` only proves shape; storage compares
 * the identity only after the CAS writer has already sharded blobs by the
 * manifest's own `executionWorkspaceId`, so the comparison must happen here,
 * before any blob is installed.
 */
function assertManifestIdentityBinding(
  manifest: RemoteWorkerArtifactManifest,
  fenced: {
    readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
    readonly records: ResolvedRemoteWorkerAssignmentAuthority;
  },
): void {
  const identity = manifest.identity;
  const { assignment, generation } = fenced.records;
  if (
    identity.registryWorkspaceId !== assignment.registryWorkspaceId ||
    identity.executionWorkspaceId !== assignment.manifest.executionWorkspaceId ||
    identity.assignmentId !== assignment.assignmentId ||
    identity.assignmentGeneration !== generation.assignmentGeneration ||
    identity.workerId !== fenced.authority.workerId ||
    identity.workerGeneration !== fenced.authority.workerGeneration ||
    identity.runtimeManifestSha256 !== fenced.authority.runtimeManifestSha256 ||
    identity.workspaceCeilingSha256 !== fenced.authority.workspaceCeilingSha256 ||
    identity.capabilityCeilingSha256 !== fenced.authority.capabilityCeilingSha256 ||
    identity.assignmentManifestSha256 !== assignment.manifestSha256
  ) {
    throw rejected("Remote worker assignment artifact manifest does not bind the fenced assignment authority.");
  }
}

function responseBase(route: RemoteWorkerAssignmentExecutionRoute, registryWorkspaceId: string): ResponseBase {
  return Object.freeze({
    schemaVersion: REMOTE_WORKER_ASSIGNMENT_EXECUTION_RESPONSE_SCHEMA_VERSION,
    operation: route.operation,
    registryWorkspaceId,
  });
}

function responseSnapshot<T extends RemoteWorkerAssignmentExecutionProtocolResponse>(value: T): T {
  const encoded = canonicalJsonString(value);
  if (Buffer.byteLength(encoded, "utf8") > REMOTE_WORKER_PROTOCOL_MAX_BODY_BYTES) {
    throw rejected("Remote worker assignment execution response exceeds its byte limit.");
  }
  return freezeJson(JSON.parse(encoded) as T) as T;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item)));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = freezeJson(item);
    return Object.freeze(result);
  }
  return value;
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

function snapshotHeaders(value: unknown): RemoteWorkerRequestHeaders {
  assertPlainRecord(value, "request headers");
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw rejected("Remote worker assignment execution headers are invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 32) throw rejected("Remote worker assignment execution headers are invalid.");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawName, descriptor] of Object.entries(descriptors)) {
    const name = rawName.toLowerCase();
    if (
      rawName !== name ||
      name.length < 1 ||
      name.length > 128 ||
      !/^[a-z0-9-]+$/u.test(name) ||
      Object.hasOwn(result, name) ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 8_192 ||
      /[\r\n]/u.test(descriptor.value)
    ) {
      throw rejected("Remote worker assignment execution headers are invalid.");
    }
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotTransportIdentity(value: unknown): RemoteWorkerTransportIdentity {
  const fields = exactOwnDataFields(
    value,
    [
      "source",
      "certificateDerSha256",
      "publicKeySpkiSha256",
      "trustAnchorDerSha256",
      "tlsExporterSha256",
      "tlsExporter",
    ],
    [],
    "transport identity",
  );
  if (
    !Buffer.isBuffer(fields.tlsExporter) ||
    nodeUtilTypes.isProxy(fields.tlsExporter) ||
    fields.tlsExporter.byteLength !== 32
  ) {
    throw rejected("Remote worker assignment execution TLS exporter is invalid.");
  }
  const snapshot: RemoteWorkerTransportIdentity = Object.freeze({
    source: fields.source as "native_mtls",
    certificateDerSha256: digest(fields.certificateDerSha256, "certificateDerSha256"),
    publicKeySpkiSha256: digest(fields.publicKeySpkiSha256, "publicKeySpkiSha256"),
    trustAnchorDerSha256: digest(fields.trustAnchorDerSha256, "trustAnchorDerSha256"),
    tlsExporterSha256: digest(fields.tlsExporterSha256, "tlsExporterSha256"),
    tlsExporter: Buffer.from(fields.tlsExporter),
  });
  if (
    snapshot.source !== "native_mtls" ||
    !safeDigestEqual(createHash("sha256").update(snapshot.tlsExporter).digest("hex"), snapshot.tlsExporterSha256)
  ) {
    snapshot.tlsExporter.fill(0);
    throw rejected("Remote worker assignment execution transport identity is invalid.");
  }
  return snapshot;
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

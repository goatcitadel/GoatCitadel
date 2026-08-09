import { createHash, timingSafeEqual } from "node:crypto";
import {
  REMOTE_WORKER_POP_V2_ROUTE_BINDINGS,
  assertRemoteWorkerRuntimeCredentialClaims,
  canonicalJsonString,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerMeshNodeAuthorityFence,
  type RemoteWorkerPopV2RouteBinding,
  type RemoteWorkerRuntimeCredentialClaims,
} from "@goatcitadel/contracts";
import type {
  ClaimRemoteWorkerAssignmentOfferInput,
  ClaimRemoteWorkerAssignmentOfferOutcome,
  ListRemoteWorkerAssignmentOffersInput,
  ListRemoteWorkerAssignmentOffersResult,
  RemoteWorkerAssignmentClaimAuthority,
  RemoteWorkerAssignmentOffer,
  RemoteWorkerAssignmentOfferCursor,
  RemoteWorkerAssignmentWorkloadProjection,
  ResolveCurrentRemoteWorkerMeshNodeAdmissionInput,
  ResolveRemoteWorkerAssignmentOfferInput,
  ResolveRemoteWorkerAssignmentWorkloadInput,
} from "@goatcitadel/storage";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";

type Awaitable<T> = T | Promise<T>;

/**
 * Contract-owned assignment dispatch purposes. A production-dark protected-v2
 * handler exists, but these descriptors remain unregistered in the native mux
 * and every HTTP/runtime composition.
 */
export const REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES = Object.freeze({
  pollOffers: contractDispatchRoute(8),
  claim: contractDispatchRoute(9),
  readWorkload: contractDispatchRoute(10),
} as const);

export interface RemoteWorkerAssignmentDispatchStorePort {
  listTaskBoundChatOffers(
    input: ListRemoteWorkerAssignmentOffersInput,
  ): Awaitable<ListRemoteWorkerAssignmentOffersResult>;
  findTaskBoundChatClaimContext(
    authority: RemoteWorkerAssignmentClaimAuthority,
    assignmentId: string,
  ): Awaitable<RemoteWorkerAssignmentOffer | undefined>;
  resolveTaskBoundChatOffer(
    input: ResolveRemoteWorkerAssignmentOfferInput,
  ): Awaitable<RemoteWorkerAssignmentOffer | undefined>;
  claimTaskBoundChatOffer(
    input: ClaimRemoteWorkerAssignmentOfferInput,
  ): Awaitable<ClaimRemoteWorkerAssignmentOfferOutcome>;
  resolveTaskBoundChatWorkload(
    input: ResolveRemoteWorkerAssignmentWorkloadInput,
  ): Awaitable<RemoteWorkerAssignmentWorkloadProjection | undefined>;
}

export interface RemoteWorkerAssignmentMeshAdmissionPort {
  resolveCurrentForRuntimeCredential(
    input: ResolveCurrentRemoteWorkerMeshNodeAdmissionInput,
  ): Awaitable<RemoteWorkerMeshNodeAuthorityFence | undefined>;
}

export interface ListRemoteWorkerAssignmentDispatchOffersInput {
  readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
  readonly limit?: number;
  readonly cursor?: RemoteWorkerAssignmentOfferCursor;
}

export interface ClaimRemoteWorkerAssignmentDispatchOfferInput {
  readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
  readonly assignmentId: string;
  /** Worker-created canonical 32-byte base64url secret. Gateway hashes it immediately. */
  readonly rawLeaseToken: string;
  readonly idempotencyKey: string;
}

export interface ReadRemoteWorkerAssignmentDispatchWorkloadInput {
  readonly authority: CurrentRemoteWorkerRuntimeCredentialAuthority;
  readonly assignmentId: string;
  readonly expectedAssignmentGeneration: number;
  readonly expectedLeaseRevision: number;
  /** Exact worker-retained lease secret; never persisted or returned. */
  readonly rawLeaseToken: string;
}

export class RemoteWorkerAssignmentDispatchError extends Error {
  public readonly code = "REMOTE_WORKER_ASSIGNMENT_DISPATCH_REJECTED";

  public constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerAssignmentDispatchError";
  }
}

/**
 * Production-dark offer/claim/workload owner. A later protected native route
 * may call this only after M2 PoP and current-runtime-credential resolution.
 * It owns no nonce policy, signer, handler, or native composition.
 */
export class RemoteWorkerAssignmentDispatchService {
  public constructor(
    private readonly assignments: RemoteWorkerAssignmentDispatchStorePort,
    private readonly meshAdmissions: RemoteWorkerAssignmentMeshAdmissionPort,
  ) {}

  public async listOffers(
    input: ListRemoteWorkerAssignmentDispatchOffersInput,
  ): Promise<ListRemoteWorkerAssignmentOffersResult> {
    const authority = snapshotRemoteWorkerAssignmentDispatchAuthority(input.authority);
    try {
      const listed = await this.assignments.listTaskBoundChatOffers({
        authority: authority.claim,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      const items: RemoteWorkerAssignmentOffer[] = [];
      for (const offer of listed.items) {
        const meshAdmission = await this.resolveMeshAdmission(
          authority,
          offer.assignment.manifest.executionWorkspaceId,
        );
        if (!meshAdmission) continue;
        const resolved = await this.assignments.resolveTaskBoundChatOffer({
          authority: authority.claim,
          meshAdmission,
          assignmentId: offer.assignment.assignmentId,
          purpose: Object.freeze({ kind: "poll" }),
        });
        if (resolved) items.push(resolved);
      }
      return Object.freeze({
        items: Object.freeze(items),
        ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
      });
    } catch (error) {
      if (error instanceof RemoteWorkerAssignmentDispatchError) throw error;
      throw rejected("Remote worker assignment offers are unavailable.");
    }
  }

  public async claimOffer(
    input: ClaimRemoteWorkerAssignmentDispatchOfferInput,
  ): Promise<ClaimRemoteWorkerAssignmentOfferOutcome> {
    const leaseTokenSha256 = hashLeaseToken(input.rawLeaseToken);
    const authority = snapshotRemoteWorkerAssignmentDispatchAuthority(input.authority);
    try {
      const context = await this.resolveExactContext(authority, input.assignmentId, Object.freeze({ kind: "claim" }));
      if (!context) throw rejected("Remote worker assignment offer is unavailable.");
      return await this.assignments.claimTaskBoundChatOffer({
        authority: authority.claim,
        meshAdmission: context.meshAdmission,
        assignmentId: input.assignmentId,
        leaseTokenSha256,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof RemoteWorkerAssignmentDispatchError) throw error;
      throw rejected("Remote worker assignment offer could not be claimed.");
    }
  }

  public async readWorkload(
    input: ReadRemoteWorkerAssignmentDispatchWorkloadInput,
  ): Promise<RemoteWorkerAssignmentWorkloadProjection | undefined> {
    const leaseTokenSha256 = hashLeaseToken(input.rawLeaseToken);
    const authority = snapshotRemoteWorkerAssignmentDispatchAuthority(input.authority);
    try {
      const context = await this.resolveExactContext(
        authority,
        input.assignmentId,
        Object.freeze({
          kind: "workload",
          expectedAssignmentGeneration: input.expectedAssignmentGeneration,
          expectedLeaseRevision: input.expectedLeaseRevision,
        }),
      );
      if (!context) return undefined;
      return await this.assignments.resolveTaskBoundChatWorkload({
        authority: authority.claim,
        meshAdmission: context.meshAdmission,
        registryWorkspaceId: authority.claim.registryWorkspaceId,
        assignmentId: input.assignmentId,
        expectedAssignmentGeneration: input.expectedAssignmentGeneration,
        expectedLeaseRevision: input.expectedLeaseRevision,
        leaseTokenSha256,
      });
    } catch {
      throw rejected("Remote worker assignment workload is unavailable.");
    }
  }

  private async resolveExactContext(
    authority: RemoteWorkerAssignmentDispatchAuthoritySnapshot,
    assignmentId: string,
    purpose: ResolveRemoteWorkerAssignmentOfferInput["purpose"],
  ): Promise<
    | Readonly<{
        offer: RemoteWorkerAssignmentOffer;
        meshAdmission: RemoteWorkerMeshNodeAuthorityFence;
      }>
    | undefined
  > {
    const advisory = await this.assignments.findTaskBoundChatClaimContext(authority.claim, assignmentId);
    if (!advisory) return undefined;
    const meshAdmission = await this.resolveMeshAdmission(
      authority,
      advisory.assignment.manifest.executionWorkspaceId,
    );
    if (!meshAdmission) return undefined;
    const offer = await this.assignments.resolveTaskBoundChatOffer({
      authority: authority.claim,
      meshAdmission,
      assignmentId,
      purpose,
    });
    return offer === undefined ? undefined : Object.freeze({ offer, meshAdmission });
  }

  private async resolveMeshAdmission(
    authority: RemoteWorkerAssignmentDispatchAuthoritySnapshot,
    workspaceId: string,
  ): Promise<RemoteWorkerMeshNodeAuthorityFence | undefined> {
    return await this.meshAdmissions.resolveCurrentForRuntimeCredential({
      registryWorkspaceId: authority.claim.registryWorkspaceId,
      bootstrapId: authority.claim.bootstrapId,
      workerId: authority.claim.workerId,
      workerGeneration: authority.claim.workerGeneration,
      nodeId: authority.claim.nodeId,
      clientCertificateSha256: authority.claim.clientCertificateSha256,
      protectedAdmissionEnvelopeSha256: authority.claim.protectedAdmissionEnvelopeSha256,
      protectedAdmissionContextSha256: authority.claim.protectedAdmissionContextSha256,
      workspaceId,
      credentialId: authority.claim.credentialId,
      credentialGeneration: authority.claim.credentialGeneration,
      authorizationCredentialSha256: authority.claim.authorizationCredentialSha256,
    });
  }
}

export interface RemoteWorkerAssignmentDispatchAuthoritySnapshot {
  readonly current: CurrentRemoteWorkerRuntimeCredentialAuthority;
  readonly claim: RemoteWorkerAssignmentClaimAuthority;
}

export function snapshotRemoteWorkerAssignmentDispatchAuthority(
  input: CurrentRemoteWorkerRuntimeCredentialAuthority,
): RemoteWorkerAssignmentDispatchAuthoritySnapshot {
  const claims = snapshotClaims(input.claims);
  const claimsSha256 = digest(input.claimsSha256, "claimsSha256");
  const publicKeySpkiDer = snapshotPublicKey(input.publicKeySpkiDer);
  if (
    remoteWorkerRuntimeCredentialClaimsSha256(claims) !== claimsSha256 ||
    claims.registryWorkspaceId !== input.registryWorkspaceId ||
    claims.workerId !== input.workerId ||
    claims.workerGeneration !== input.workerGeneration ||
    claims.workspaceCeilingSha256 !== input.workspaceCeilingSha256 ||
    claims.capabilityCeilingSha256 !== input.capabilityCeilingSha256
  ) {
    publicKeySpkiDer.fill(0);
    throw rejected("Remote worker assignment credential authority is invalid.");
  }
  const current: CurrentRemoteWorkerRuntimeCredentialAuthority = Object.freeze({
    credentialId: identifier(input.credentialId, "credentialId"),
    credentialGeneration: positiveInteger(input.credentialGeneration, "credentialGeneration"),
    authorizationCredentialSha256: digest(input.authorizationCredentialSha256, "authorizationCredentialSha256"),
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    bootstrapId: identifier(input.bootstrapId, "bootstrapId"),
    workerId: identifier(input.workerId, "workerId"),
    workerGeneration: positiveInteger(input.workerGeneration, "workerGeneration"),
    nodeId: identifier(input.nodeId, "nodeId"),
    publicKeySpkiDer,
    publicKeySpkiSha256: digest(input.publicKeySpkiSha256, "publicKeySpkiSha256"),
    clientCertificateSha256: digest(input.clientCertificateSha256, "clientCertificateSha256"),
    transportTrustAnchorSha256: digest(input.transportTrustAnchorSha256, "transportTrustAnchorSha256"),
    runtimeManifestSha256: digest(input.runtimeManifestSha256, "runtimeManifestSha256"),
    workspaceCeilingSha256: digest(input.workspaceCeilingSha256, "workspaceCeilingSha256"),
    capabilityCeilingSha256: digest(input.capabilityCeilingSha256, "capabilityCeilingSha256"),
    protectedAdmissionEnvelopeSha256: digest(
      input.protectedAdmissionEnvelopeSha256,
      "protectedAdmissionEnvelopeSha256",
    ),
    protectedAdmissionContextSha256: digest(
      input.protectedAdmissionContextSha256,
      "protectedAdmissionContextSha256",
    ),
    claims,
    claimsSha256,
  });
  if (!safeDigestEqual(createHash("sha256").update(publicKeySpkiDer).digest("hex"), current.publicKeySpkiSha256)) {
    publicKeySpkiDer.fill(0);
    throw rejected("Remote worker assignment credential authority is invalid.");
  }
  const claim: RemoteWorkerAssignmentClaimAuthority = Object.freeze({
    registryWorkspaceId: current.registryWorkspaceId,
    bootstrapId: current.bootstrapId,
    workerId: current.workerId,
    workerGeneration: current.workerGeneration,
    credentialId: current.credentialId,
    credentialGeneration: current.credentialGeneration,
    authorizationCredentialSha256: current.authorizationCredentialSha256,
    nodeId: current.nodeId,
    clientCertificateSha256: current.clientCertificateSha256,
    runtimeManifestSha256: current.runtimeManifestSha256,
    workspaceCeilingSha256: current.workspaceCeilingSha256,
    capabilityCeilingSha256: current.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: current.protectedAdmissionEnvelopeSha256,
    protectedAdmissionContextSha256: current.protectedAdmissionContextSha256,
    claimsSha256,
  });
  return Object.freeze({ current, claim });
}

function contractDispatchRoute<Code extends 8 | 9 | 10>(
  code: Code,
): Extract<RemoteWorkerPopV2RouteBinding, { readonly code: Code }> {
  const route = REMOTE_WORKER_POP_V2_ROUTE_BINDINGS.find((candidate) => candidate.code === code);
  if (route === undefined || route.method !== "POST" || route.authorityKind !== "credential") {
    throw new Error(`Remote worker assignment dispatch route ${String(code)} is unavailable.`);
  }
  return route as Extract<RemoteWorkerPopV2RouteBinding, { readonly code: Code }>;
}

function snapshotClaims(input: RemoteWorkerRuntimeCredentialClaims): RemoteWorkerRuntimeCredentialClaims {
  const claims = JSON.parse(canonicalJsonString(input)) as RemoteWorkerRuntimeCredentialClaims;
  assertRemoteWorkerRuntimeCredentialClaims(claims);
  return Object.freeze({
    ...claims,
    allowedWorkspaceIds: Object.freeze([...claims.allowedWorkspaceIds]),
    capabilityClasses: Object.freeze([...claims.capabilityClasses]),
  });
}

function snapshotPublicKey(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength !== 44) {
    throw rejected("Remote worker assignment credential authority is invalid.");
  }
  return Buffer.from(value);
}

function hashLeaseToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Remote worker assignment lease secret must be canonical 32-byte base64url.");
  }
  const decoded = Buffer.from(value, "base64url");
  try {
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
      throw new TypeError("Remote worker assignment lease secret must be canonical 32-byte base64url.");
    }
    return createHash("sha256").update(value, "utf8").digest("hex");
  } finally {
    decoded.fill(0);
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`Remote worker assignment ${field} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Remote worker assignment ${field} is invalid.`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker assignment ${field} is invalid.`);
  }
  return value;
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function rejected(message: string): RemoteWorkerAssignmentDispatchError {
  return new RemoteWorkerAssignmentDispatchError(message);
}

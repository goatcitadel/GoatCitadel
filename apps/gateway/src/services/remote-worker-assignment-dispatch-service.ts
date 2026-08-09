import { createHash } from "node:crypto";
import {
  assertRemoteWorkerRuntimeCredentialClaims,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerMeshNodeAuthorityFence,
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
  ResolveRemoteWorkerAssignmentWorkloadInput,
} from "@goatcitadel/storage";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";

type Awaitable<T> = T | Promise<T>;

/**
 * Contract-reserved assignment dispatch purposes. These descriptors are not
 * registered in the native mux or any HTTP composition; the runtime remains
 * production-dark until protected-v2 transport activation owns them.
 */
export const REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES = Object.freeze({
  pollOffers: Object.freeze({
    rawPath: "/api/v1/remote-workers/assignment-offer-polls",
    operation: "assignment.offers.poll",
  }),
  claim: Object.freeze({
    rawPath: "/api/v1/remote-workers/assignment-claims",
    operation: "assignment.claim",
  }),
  readWorkload: Object.freeze({
    rawPath: "/api/v1/remote-workers/assignment-workload-reads",
    operation: "assignment.workload.read",
  }),
} as const);

export interface RemoteWorkerAssignmentDispatchStorePort {
  listTaskBoundChatOffers(
    input: ListRemoteWorkerAssignmentOffersInput,
  ): Awaitable<ListRemoteWorkerAssignmentOffersResult>;
  findTaskBoundChatClaimContext(
    authority: RemoteWorkerAssignmentClaimAuthority,
    assignmentId: string,
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
    const authority = snapshotAuthority(input.authority);
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
        if (meshAdmission) items.push(offer);
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
    const authority = snapshotAuthority(input.authority);
    try {
      const context = await this.assignments.findTaskBoundChatClaimContext(authority.claim, input.assignmentId);
      if (!context) throw rejected("Remote worker assignment offer is unavailable.");
      const meshAdmission = await this.resolveMeshAdmission(
        authority,
        context.assignment.manifest.executionWorkspaceId,
      );
      if (!meshAdmission) throw rejected("Remote worker assignment mesh admission is unavailable.");
      return await this.assignments.claimTaskBoundChatOffer({
        authority: authority.claim,
        meshAdmission,
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
    const authority = snapshotAuthority(input.authority);
    try {
      const context = await this.assignments.findTaskBoundChatClaimContext(authority.claim, input.assignmentId);
      if (!context) return undefined;
      const meshAdmission = await this.resolveMeshAdmission(
        authority,
        context.assignment.manifest.executionWorkspaceId,
      );
      if (!meshAdmission) return undefined;
      return await this.assignments.resolveTaskBoundChatWorkload({
        authority: authority.claim,
        meshAdmission,
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

  private async resolveMeshAdmission(
    authority: SnapshotAuthority,
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

interface SnapshotAuthority {
  readonly claim: RemoteWorkerAssignmentClaimAuthority;
}

function snapshotAuthority(input: CurrentRemoteWorkerRuntimeCredentialAuthority): SnapshotAuthority {
  assertRemoteWorkerRuntimeCredentialClaims(input.claims);
  const claimsSha256 = digest(input.claimsSha256, "claimsSha256");
  if (
    remoteWorkerRuntimeCredentialClaimsSha256(input.claims) !== claimsSha256 ||
    input.claims.registryWorkspaceId !== input.registryWorkspaceId ||
    input.claims.workerId !== input.workerId ||
    input.claims.workerGeneration !== input.workerGeneration ||
    input.claims.workspaceCeilingSha256 !== input.workspaceCeilingSha256 ||
    input.claims.capabilityCeilingSha256 !== input.capabilityCeilingSha256
  ) {
    throw rejected("Remote worker assignment credential authority is invalid.");
  }
  const claim: RemoteWorkerAssignmentClaimAuthority = Object.freeze({
    registryWorkspaceId: identifier(input.registryWorkspaceId, "registryWorkspaceId"),
    bootstrapId: identifier(input.bootstrapId, "bootstrapId"),
    workerId: identifier(input.workerId, "workerId"),
    workerGeneration: positiveInteger(input.workerGeneration, "workerGeneration"),
    credentialId: identifier(input.credentialId, "credentialId"),
    credentialGeneration: positiveInteger(input.credentialGeneration, "credentialGeneration"),
    authorizationCredentialSha256: digest(input.authorizationCredentialSha256, "authorizationCredentialSha256"),
    nodeId: identifier(input.nodeId, "nodeId"),
    clientCertificateSha256: digest(input.clientCertificateSha256, "clientCertificateSha256"),
    runtimeManifestSha256: digest(input.runtimeManifestSha256, "runtimeManifestSha256"),
    workspaceCeilingSha256: digest(input.workspaceCeilingSha256, "workspaceCeilingSha256"),
    capabilityCeilingSha256: digest(input.capabilityCeilingSha256, "capabilityCeilingSha256"),
    protectedAdmissionEnvelopeSha256: digest(
      input.protectedAdmissionEnvelopeSha256,
      "protectedAdmissionEnvelopeSha256",
    ),
    protectedAdmissionContextSha256: digest(input.protectedAdmissionContextSha256, "protectedAdmissionContextSha256"),
    claimsSha256,
  });
  return Object.freeze({ claim });
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

function rejected(message: string): RemoteWorkerAssignmentDispatchError {
  return new RemoteWorkerAssignmentDispatchError(message);
}

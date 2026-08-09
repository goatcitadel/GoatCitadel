import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalJsonString,
  normalizeIssueRemoteWorkerMeshNodeJoinAuthorityRequest,
  normalizeRemoteWorkerMeshNodeJoinAuthorityRecord,
  normalizeRemoteWorkerMeshNodeJoinAuthorityRevocationRecord,
  normalizeRevokeRemoteWorkerMeshNodeJoinAuthorityRequest,
  redactSecretText,
  type RemoteWorkerMeshNodeJoinAuthorityRecord,
  type RemoteWorkerMeshNodeJoinAuthorityRevocationRecord,
  type RemoteWorkerMeshNodeJoinCredentialIssuance,
} from "@goatcitadel/contracts";
import type { CurrentRemoteWorkerProtectedAdmissionAuthority } from "./remote-worker-protected-admission-authority-service.js";

type Awaitable<T> = T | Promise<T>;

export interface RemoteWorkerMeshNodeJoinAuthorityStorePort {
  issueJoinAuthority(input: {
    readonly registryWorkspaceId: string;
    readonly bootstrapId: string;
    readonly workerId: string;
    readonly workerGeneration: number;
    readonly nodeId: string;
    readonly clientCertificateSha256: string;
    readonly protectedAdmissionEnvelopeSha256: string;
    readonly protectedAdmissionContextSha256: string;
    readonly workspaceId: string;
    readonly expiresInSeconds: number;
    readonly issuedByActorId: string;
    readonly idempotencyKey: string;
    readonly rawMeshNodeCredential: string;
  }): Awaitable<RemoteWorkerMeshNodeJoinCredentialIssuance>;
  revokeJoinAuthority(input: {
    readonly registryWorkspaceId: string;
    readonly workerId: string;
    readonly workerGeneration: number;
    readonly workspaceId: string;
    readonly joinAuthorityGeneration: number;
    readonly reasonCode: string;
    readonly reason: string;
    readonly revokedByActorId: string;
    readonly idempotencyKey: string;
  }): Awaitable<RemoteWorkerMeshNodeJoinAuthorityRevocationRecord>;
}

export interface RemoteWorkerMeshNodeJoinProtectedAuthorityPort {
  resolveCurrent(input: {
    readonly registryWorkspaceId: string;
    readonly workerId: string;
    readonly workerGeneration: number;
  }): Awaitable<CurrentRemoteWorkerProtectedAdmissionAuthority>;
}

export interface RemoteWorkerMeshNodeJoinAuditPort {
  append(
    stream: "approvals",
    payload: Record<string, unknown>,
    options: { readonly deliveryId: string },
  ): Awaitable<void>;
}

export interface RemoteWorkerMeshNodeJoinAuthorityServiceDependencies {
  readonly authorities: RemoteWorkerMeshNodeJoinAuthorityStorePort;
  readonly protectedAuthority: RemoteWorkerMeshNodeJoinProtectedAuthorityPort;
  readonly audit: RemoteWorkerMeshNodeJoinAuditPort;
  readonly randomSecretBytes?: (size: number) => Buffer;
}

export interface IssueRemoteWorkerMeshNodeJoinAuthorityInput {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly workspaceId: string;
  readonly expiresInSeconds: number;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface RevokeRemoteWorkerMeshNodeJoinAuthorityInput {
  readonly registryWorkspaceId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly workspaceId: string;
  readonly joinAuthorityGeneration: number;
  readonly reasonCode: string;
  readonly reason: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export class RemoteWorkerMeshNodeJoinAuthorityError extends Error {
  public constructor(message = "Remote worker mesh-node join authority request is invalid.") {
    super(message);
    this.name = "RemoteWorkerMeshNodeJoinAuthorityError";
  }
}

/**
 * Operator-side secret-once issuance owner. The audit request is committed
 * before random secret generation; durable storage then selects and locks the
 * latest runtime credential and persists only the join credential digest.
 */
export class RemoteWorkerMeshNodeJoinAuthorityService {
  public constructor(private readonly dependencies: RemoteWorkerMeshNodeJoinAuthorityServiceDependencies) {}

  public async issue(
    input: IssueRemoteWorkerMeshNodeJoinAuthorityInput,
  ): Promise<RemoteWorkerMeshNodeJoinCredentialIssuance & { readonly auditDeliveryId: string }> {
    try {
      const request = normalizeIssueRemoteWorkerMeshNodeJoinAuthorityRequest({
        registryWorkspaceId: input.registryWorkspaceId,
        workerId: input.workerId,
        workerGeneration: input.workerGeneration,
        workspaceId: input.workspaceId,
        expiresInSeconds: input.expiresInSeconds,
        idempotencyKey: input.idempotencyKey,
      });
      const actorId = identifier(input.actorId, 256);
      const current = await this.dependencies.protectedAuthority.resolveCurrent({
        registryWorkspaceId: request.registryWorkspaceId,
        workerId: request.workerId,
        workerGeneration: request.workerGeneration,
      });
      assertProtectedBindings(request, current);
      const auditDeliveryId = auditId("issue", { request, actorId });
      await this.dependencies.audit.append(
        "approvals",
        {
          event: "remote_worker.mesh_node_join_authority.requested",
          registryWorkspaceId: request.registryWorkspaceId,
          workerId: request.workerId,
          workerGeneration: request.workerGeneration,
          workspaceId: request.workspaceId,
          expiresInSeconds: request.expiresInSeconds,
          protectedAdmissionEnvelopeSha256: current.evidence.envelopeSha256,
          protectedAdmissionContextSha256: current.evidence.contextSha256,
          issuedByActorId: actorId,
        },
        { deliveryId: auditDeliveryId },
      );
      const secretBytes = (this.dependencies.randomSecretBytes ?? randomBytes)(32);
      if (!Buffer.isBuffer(secretBytes) || secretBytes.byteLength !== 32) {
        secretBytes?.fill?.(0);
        throw new RemoteWorkerMeshNodeJoinAuthorityError();
      }
      const rawMeshNodeCredential = secretBytes.toString("base64url");
      secretBytes.fill(0);
      const outcome = await this.dependencies.authorities.issueJoinAuthority({
        registryWorkspaceId: current.generation.registryWorkspaceId,
        bootstrapId: current.generation.bootstrapId,
        workerId: current.generation.workerId,
        workerGeneration: current.generation.workerGeneration,
        nodeId: current.generation.nodeId,
        clientCertificateSha256: current.generation.clientCertificateSha256,
        protectedAdmissionEnvelopeSha256: current.evidence.envelopeSha256,
        protectedAdmissionContextSha256: current.evidence.contextSha256,
        workspaceId: request.workspaceId,
        expiresInSeconds: request.expiresInSeconds,
        issuedByActorId: actorId,
        idempotencyKey: request.idempotencyKey,
        rawMeshNodeCredential,
      });
      const authority = normalizeRemoteWorkerMeshNodeJoinAuthorityRecord(outcome.authority);
      assertIssuedBindings(request, current, actorId, authority);
      if (outcome.disposition === "created") {
        if (
          outcome.secretDisposition !== "returned_once" ||
          outcome.meshNodeCredential !== rawMeshNodeCredential ||
          !safeDigestEqual(authority.joinCredentialSha256, sha256(rawMeshNodeCredential))
        ) {
          throw new RemoteWorkerMeshNodeJoinAuthorityError();
        }
        return Object.freeze({
          disposition: "created",
          authority,
          meshNodeCredential: rawMeshNodeCredential,
          secretDisposition: "returned_once",
          auditDeliveryId,
        });
      }
      if (
        outcome.disposition !== "replayed_without_secret" ||
        outcome.secretDisposition !== "not_recoverable" ||
        outcome.meshNodeCredential !== undefined
      ) {
        throw new RemoteWorkerMeshNodeJoinAuthorityError();
      }
      return Object.freeze({
        disposition: "replayed_without_secret",
        authority,
        secretDisposition: "not_recoverable",
        auditDeliveryId,
      });
    } catch (error) {
      if (error instanceof RemoteWorkerMeshNodeJoinAuthorityError) throw error;
      throw new RemoteWorkerMeshNodeJoinAuthorityError();
    }
  }

  public async revoke(
    input: RevokeRemoteWorkerMeshNodeJoinAuthorityInput,
  ): Promise<RemoteWorkerMeshNodeJoinAuthorityRevocationRecord & { readonly auditDeliveryId: string }> {
    try {
      const request = normalizeRevokeRemoteWorkerMeshNodeJoinAuthorityRequest({
        registryWorkspaceId: input.registryWorkspaceId,
        workerId: input.workerId,
        workerGeneration: input.workerGeneration,
        workspaceId: input.workspaceId,
        joinAuthorityGeneration: input.joinAuthorityGeneration,
        reasonCode: input.reasonCode,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      if (
        redactSecretText(request.reasonCode).redactionCount > 0 ||
        redactSecretText(request.reason).redactionCount > 0
      ) {
        throw new RemoteWorkerMeshNodeJoinAuthorityError();
      }
      const actorId = identifier(input.actorId, 256);
      const auditDeliveryId = auditId("revoke", { request, actorId });
      await this.dependencies.audit.append(
        "approvals",
        {
          event: "remote_worker.mesh_node_join_authority.revocation_requested",
          registryWorkspaceId: request.registryWorkspaceId,
          workerId: request.workerId,
          workerGeneration: request.workerGeneration,
          workspaceId: request.workspaceId,
          joinAuthorityGeneration: request.joinAuthorityGeneration,
          reasonCode: request.reasonCode,
          reasonSha256: sha256(request.reason),
          revokedByActorId: actorId,
        },
        { deliveryId: auditDeliveryId },
      );
      const revoked = normalizeRemoteWorkerMeshNodeJoinAuthorityRevocationRecord(
        await this.dependencies.authorities.revokeJoinAuthority({
          ...request,
          revokedByActorId: actorId,
        }),
      );
      if (
        revoked.registryWorkspaceId !== request.registryWorkspaceId ||
        revoked.workerId !== request.workerId ||
        revoked.workerGeneration !== request.workerGeneration ||
        revoked.workspaceId !== request.workspaceId ||
        revoked.joinAuthorityGeneration !== request.joinAuthorityGeneration ||
        revoked.reasonCode !== request.reasonCode ||
        revoked.reasonSha256 !== sha256(request.reason) ||
        revoked.revokedByActorId !== actorId ||
        revoked.idempotencyKey !== request.idempotencyKey
      ) {
        throw new RemoteWorkerMeshNodeJoinAuthorityError();
      }
      return Object.freeze({ ...revoked, auditDeliveryId });
    } catch (error) {
      if (error instanceof RemoteWorkerMeshNodeJoinAuthorityError) throw error;
      throw new RemoteWorkerMeshNodeJoinAuthorityError();
    }
  }
}

function assertProtectedBindings(
  request: { readonly registryWorkspaceId: string; readonly workerId: string; readonly workerGeneration: number },
  current: CurrentRemoteWorkerProtectedAdmissionAuthority,
): void {
  if (
    current.generation.registryWorkspaceId !== request.registryWorkspaceId ||
    current.generation.workerId !== request.workerId ||
    current.generation.workerGeneration !== request.workerGeneration ||
    current.generation.transportIdentitySource !== "native_mtls" ||
    !isDigest(current.evidence.envelopeSha256) ||
    !isDigest(current.evidence.contextSha256)
  ) {
    throw new RemoteWorkerMeshNodeJoinAuthorityError();
  }
}

function assertIssuedBindings(
  request: {
    readonly registryWorkspaceId: string;
    readonly workerId: string;
    readonly workerGeneration: number;
    readonly workspaceId: string;
    readonly idempotencyKey: string;
  },
  current: CurrentRemoteWorkerProtectedAdmissionAuthority,
  actorId: string,
  authority: RemoteWorkerMeshNodeJoinAuthorityRecord,
): void {
  if (
    authority.registryWorkspaceId !== request.registryWorkspaceId ||
    authority.bootstrapId !== current.generation.bootstrapId ||
    authority.workerId !== request.workerId ||
    authority.workerGeneration !== request.workerGeneration ||
    authority.nodeId !== current.generation.nodeId ||
    authority.workspaceId !== request.workspaceId ||
    authority.clientCertificateSha256 !== current.generation.clientCertificateSha256 ||
    authority.protectedAdmissionEnvelopeSha256 !== current.evidence.envelopeSha256 ||
    authority.protectedAdmissionContextSha256 !== current.evidence.contextSha256 ||
    authority.issuedByActorId !== actorId ||
    authority.idempotencyKey !== request.idempotencyKey
  ) {
    throw new RemoteWorkerMeshNodeJoinAuthorityError();
  }
}

function identifier(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value !== value.normalize("NFKC").trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new RemoteWorkerMeshNodeJoinAuthorityError();
  }
  return value;
}

function auditId(action: string, material: object): string {
  return `remote-worker-mesh-node-join-${action}:${sha256(canonicalJsonString(material))}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function safeDigestEqual(left: string, right: string): boolean {
  return isDigest(left) && isDigest(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

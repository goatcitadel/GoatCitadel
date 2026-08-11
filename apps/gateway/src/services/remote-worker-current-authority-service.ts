import { createHash, timingSafeEqual } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import {
  assertRemoteWorkerGenerationRecord,
  assertRemoteWorkerRuntimeCredentialClaims,
  assertRemoteWorkerRuntimeCredentialRecord,
  canonicalJsonString,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerRuntimeCredentialClaims,
} from "@goatcitadel/contracts";
import type { ResolvedRemoteWorkerRuntimeCredential } from "@goatcitadel/storage";
import type { CurrentRemoteWorkerProtectedAdmissionAuthority } from "./remote-worker-protected-admission-authority-service.js";

type Awaitable<T> = T | Promise<T>;

export interface RemoteWorkerCurrentRuntimeCredentialStorePort {
  resolveRuntimeCredentialByHash(tokenSha256: string): Awaitable<ResolvedRemoteWorkerRuntimeCredential | undefined>;
}

export interface RemoteWorkerCurrentProtectedAdmissionAuthorityPort {
  resolveCurrent(input: {
    readonly registryWorkspaceId: string;
    readonly workerId: string;
    readonly workerGeneration: number;
  }): Awaitable<CurrentRemoteWorkerProtectedAdmissionAuthority>;
}

/**
 * Cryptographically verified M2 authority plus the latest fresh runtime
 * credential. The evidence digests are a commit fence, not a substitute for
 * the storage owner's locked re-read at the eventual mutation.
 */
export interface CurrentRemoteWorkerRuntimeCredentialAuthority {
  readonly credentialId: string;
  readonly credentialGeneration: number;
  readonly authorizationCredentialSha256: string;
  readonly registryWorkspaceId: string;
  readonly bootstrapId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly nodeId: string;
  readonly publicKeySpkiDer: Buffer;
  readonly publicKeySpkiSha256: string;
  readonly clientCertificateSha256: string;
  readonly transportTrustAnchorSha256: string;
  readonly runtimeManifestSha256: string;
  readonly workspaceCeilingSha256: string;
  readonly capabilityCeilingSha256: string;
  readonly protectedAdmissionEnvelopeSha256: string;
  readonly protectedAdmissionContextSha256: string;
  readonly claims: RemoteWorkerRuntimeCredentialClaims;
  readonly claimsSha256: string;
}

export interface RemoteWorkerCurrentRuntimeCredentialAuthorityPort {
  resolveByCredentialTokenSha256(
    credentialTokenSha256: string,
  ): Awaitable<CurrentRemoteWorkerRuntimeCredentialAuthority | undefined>;
}

export class RemoteWorkerCurrentAuthorityService implements RemoteWorkerCurrentRuntimeCredentialAuthorityPort {
  public constructor(
    private readonly credentials: RemoteWorkerCurrentRuntimeCredentialStorePort,
    private readonly protectedAuthority: RemoteWorkerCurrentProtectedAdmissionAuthorityPort,
  ) {}

  public async resolveByCredentialTokenSha256(
    credentialTokenSha256: string,
  ): Promise<CurrentRemoteWorkerRuntimeCredentialAuthority | undefined> {
    const tokenSha256 = digest(credentialTokenSha256, "credential token digest");
    const resolved = await this.credentials.resolveRuntimeCredentialByHash(tokenSha256);
    if (resolved === undefined) return undefined;
    try {
      assertRemoteWorkerGenerationRecord(resolved.generation);
      assertRemoteWorkerRuntimeCredentialRecord(resolved.credential);
      assertRemoteWorkerRuntimeCredentialClaims(resolved.credential.claims);
      const generation = resolved.generation;
      const credential = resolved.credential;
      const protectedCurrent = await this.protectedAuthority.resolveCurrent({
        registryWorkspaceId: generation.registryWorkspaceId,
        workerId: generation.workerId,
        workerGeneration: generation.workerGeneration,
      });
      const publicKeySpkiDer = snapshotEd25519Spki(protectedCurrent.workerPublicKeySpkiDer);
      const claims = snapshotClaims(credential.claims);
      if (
        canonicalJsonString(protectedCurrent.generation) !== canonicalJsonString(generation) ||
        credential.registryWorkspaceId !== generation.registryWorkspaceId ||
        credential.workerId !== generation.workerId ||
        credential.workerGeneration !== generation.workerGeneration ||
        claims.registryWorkspaceId !== generation.registryWorkspaceId ||
        claims.workerId !== generation.workerId ||
        claims.workerGeneration !== generation.workerGeneration ||
        claims.workspaceCeilingSha256 !== generation.workspaceCeilingSha256 ||
        claims.capabilityCeilingSha256 !== generation.capabilityCeilingSha256 ||
        canonicalJsonString(claims.allowedWorkspaceIds) !== canonicalJsonString(resolved.allowedWorkspaceIds) ||
        canonicalJsonString(claims.capabilityClasses) !== canonicalJsonString(resolved.capabilityClasses) ||
        !safeDigestEqual(remoteWorkerRuntimeCredentialClaimsSha256(claims), credential.claimsSha256) ||
        !safeDigestEqual(sha256Bytes(publicKeySpkiDer), generation.publicKeySpkiSha256)
      ) {
        publicKeySpkiDer.fill(0);
        throw unavailable();
      }
      return Object.freeze({
        credentialId: credential.credentialId,
        credentialGeneration: credential.credentialGeneration,
        authorizationCredentialSha256: tokenSha256,
        registryWorkspaceId: generation.registryWorkspaceId,
        bootstrapId: generation.bootstrapId,
        workerId: generation.workerId,
        workerGeneration: generation.workerGeneration,
        nodeId: generation.nodeId,
        publicKeySpkiDer,
        publicKeySpkiSha256: generation.publicKeySpkiSha256,
        clientCertificateSha256: generation.clientCertificateSha256,
        transportTrustAnchorSha256: generation.transportTrustAnchorSha256,
        runtimeManifestSha256: generation.runtimeManifestSha256,
        workspaceCeilingSha256: generation.workspaceCeilingSha256,
        capabilityCeilingSha256: generation.capabilityCeilingSha256,
        protectedAdmissionEnvelopeSha256: protectedCurrent.evidence.envelopeSha256,
        protectedAdmissionContextSha256: protectedCurrent.evidence.contextSha256,
        claims,
        claimsSha256: credential.claimsSha256,
      });
    } catch {
      throw unavailable();
    }
  }
}

function snapshotClaims(value: RemoteWorkerRuntimeCredentialClaims): RemoteWorkerRuntimeCredentialClaims {
  const claims = JSON.parse(canonicalJsonString(value)) as RemoteWorkerRuntimeCredentialClaims;
  assertRemoteWorkerRuntimeCredentialClaims(claims);
  return Object.freeze({
    ...claims,
    allowedWorkspaceIds: Object.freeze([...claims.allowedWorkspaceIds]),
    capabilityClasses: Object.freeze([...claims.capabilityClasses]),
  });
}

function snapshotEd25519Spki(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || nodeUtilTypes.isProxy(value) || value.byteLength !== 44) throw unavailable();
  return Buffer.from(value);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function unavailable(): Error {
  return new Error("Current remote worker runtime credential authority is unavailable.");
}

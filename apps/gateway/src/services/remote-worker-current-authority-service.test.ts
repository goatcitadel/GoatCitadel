import { createHash, generateKeyPairSync } from "node:crypto";
import {
  REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
  buildRemoteWorkerRuntimeCredentialClaims,
  remoteWorkerRuntimeCredentialClaimsSha256,
  type RemoteWorkerGenerationRecord,
  type RemoteWorkerRuntimeCredentialRecord,
} from "@goatcitadel/contracts";
import type { ResolvedRemoteWorkerRuntimeCredential } from "@goatcitadel/storage";
import { describe, expect, it, vi } from "vitest";
import { RemoteWorkerCurrentAuthorityService } from "./remote-worker-current-authority-service.js";
import type { CurrentRemoteWorkerProtectedAdmissionAuthority } from "./remote-worker-protected-admission-authority-service.js";

const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function fixture() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKeySpkiDer)) throw new Error("test key export failed");
  const claims = buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    workerGeneration: 4,
    allowedWorkspaceIds: ["registry-a", "workspace-a"],
    capabilityClasses: ["durable_compute"],
  });
  const generation: RemoteWorkerGenerationRecord = {
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    nodeId: "node-a",
    workerGeneration: 4,
    bootstrapId: "bootstrap-a",
    publicKeySpkiSha256: D(publicKeySpkiDer),
    clientCertificateSha256: D("certificate-a"),
    runtimeManifestSha256: D("manifest-a"),
    workspaceCeilingSha256: claims.workspaceCeilingSha256,
    capabilityCeilingSha256: claims.capabilityCeilingSha256,
    transportIdentitySource: "native_mtls",
    transportTrustAnchorSha256: D("trust-anchor-a"),
    transportVerificationReceiptSha256: D("transport-receipt-a"),
    proofOfPossessionReceiptSha256: D("pop-receipt-a"),
    downloadVerificationReceiptSha256: D("download-receipt-a"),
    installedTreeAttestationSha256: D("tree-attestation-a"),
    installedTreeVerificationReceiptSha256: D("tree-receipt-a"),
    exchangeIdempotencyKey: "exchange-a",
    exchangeRequestSha256: D("exchange-request-a"),
    admittedAt: "2026-08-08T20:00:00.000Z",
  };
  const credential: RemoteWorkerRuntimeCredentialRecord = {
    registryWorkspaceId: generation.registryWorkspaceId,
    workerId: generation.workerId,
    workerGeneration: generation.workerGeneration,
    credentialGeneration: 5,
    credentialId: "credential-a",
    purpose: REMOTE_WORKER_RUNTIME_CREDENTIAL_PURPOSE,
    claims,
    claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
    issuanceProofSha256: D("issuance-a"),
    idempotencyKey: "credential-a",
    requestSha256: D("credential-request-a"),
    issuedAt: "2026-08-08T20:00:00.000Z",
    expiresAt: "2026-08-08T20:10:00.000Z",
  };
  const resolved: ResolvedRemoteWorkerRuntimeCredential = {
    generation,
    credential,
    allowedWorkspaceIds: [...claims.allowedWorkspaceIds],
    capabilityClasses: [...claims.capabilityClasses],
  };
  const protectedAuthority = {
    generation,
    evidence: {
      envelopeSha256: D("protected-envelope-a"),
      contextSha256: D("protected-context-a"),
    },
    workerPublicKeySpkiDer: publicKeySpkiDer,
  } as CurrentRemoteWorkerProtectedAdmissionAuthority;
  return { resolved, protectedAuthority };
}

describe("RemoteWorkerCurrentAuthorityService", () => {
  it("awaits Promise-backed storage and returns an immutable exact M2/runtime-credential fence", async () => {
    const f = fixture();
    const credentials = { resolveRuntimeCredentialByHash: vi.fn(async () => f.resolved) };
    const protectedAuthority = { resolveCurrent: vi.fn(async () => f.protectedAuthority) };
    const service = new RemoteWorkerCurrentAuthorityService(credentials, protectedAuthority);
    const tokenSha256 = D("runtime-credential-a");

    const current = await service.resolveByCredentialTokenSha256(tokenSha256);
    expect(current).toMatchObject({
      authorizationCredentialSha256: tokenSha256,
      registryWorkspaceId: "registry-a",
      workerId: "worker-a",
      workerGeneration: 4,
      credentialId: "credential-a",
      credentialGeneration: 5,
      protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
      protectedAdmissionContextSha256: D("protected-context-a"),
    });
    expect(credentials.resolveRuntimeCredentialByHash).toHaveBeenCalledWith(tokenSha256);
    expect(protectedAuthority.resolveCurrent).toHaveBeenCalledWith({
      registryWorkspaceId: "registry-a",
      workerId: "worker-a",
      workerGeneration: 4,
    });
    expect(Object.isFrozen(current)).toBe(true);
  });

  it("fails closed on protected-generation drift or malformed credential digests", async () => {
    const f = fixture();
    const service = new RemoteWorkerCurrentAuthorityService(
      { resolveRuntimeCredentialByHash: async () => f.resolved },
      {
        resolveCurrent: async () => ({
          ...f.protectedAuthority,
          generation: { ...f.protectedAuthority.generation, workerGeneration: 99 },
        }),
      },
    );
    await expect(service.resolveByCredentialTokenSha256(D("runtime-credential-a"))).rejects.toThrow(
      "Current remote worker runtime credential authority is unavailable",
    );
    await expect(service.resolveByCredentialTokenSha256("not-a-digest")).rejects.toThrow(
      "Remote worker credential token digest is invalid",
    );
  });
});

import { createHash, generateKeyPairSync } from "node:crypto";
import {
  REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_REVOCATION_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION,
  type RemoteWorkerGenerationRecord,
  type RemoteWorkerMeshNodeJoinAuthorityRecord,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RemoteWorkerMeshNodeJoinAuthorityError,
  RemoteWorkerMeshNodeJoinAuthorityService,
} from "./remote-worker-mesh-node-join-authority-service.js";
import type { CurrentRemoteWorkerProtectedAdmissionAuthority } from "./remote-worker-protected-admission-authority-service.js";

const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const RAW = Buffer.alloc(32, 0x22).toString("base64url");

function protectedAuthority(): CurrentRemoteWorkerProtectedAdmissionAuthority {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKeySpkiDer)) throw new Error("test key export failed");
  const generation: RemoteWorkerGenerationRecord = {
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    nodeId: "node-a",
    workerGeneration: 2,
    bootstrapId: "bootstrap-a",
    publicKeySpkiSha256: D(publicKeySpkiDer),
    clientCertificateSha256: D("certificate-a"),
    runtimeManifestSha256: D("manifest-a"),
    workspaceCeilingSha256: D("workspace-ceiling-a"),
    capabilityCeilingSha256: D("capability-ceiling-a"),
    transportIdentitySource: "native_mtls",
    transportTrustAnchorSha256: D("trust-anchor-a"),
    transportVerificationReceiptSha256: D("transport-a"),
    proofOfPossessionReceiptSha256: D("pop-a"),
    downloadVerificationReceiptSha256: D("download-a"),
    installedTreeAttestationSha256: D("tree-a"),
    installedTreeVerificationReceiptSha256: D("tree-receipt-a"),
    exchangeIdempotencyKey: "exchange-a",
    exchangeRequestSha256: D("exchange-request-a"),
    admittedAt: "2026-08-09T07:00:00.000Z",
  };
  return {
    generation,
    evidence: {
      envelopeSha256: D("protected-envelope-a"),
      contextSha256: D("protected-context-a"),
    },
    workerPublicKeySpkiDer: publicKeySpkiDer,
  } as CurrentRemoteWorkerProtectedAdmissionAuthority;
}

function authority(joinCredentialSha256 = D(RAW)): RemoteWorkerMeshNodeJoinAuthorityRecord {
  return {
    schemaVersion: REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION,
    registryWorkspaceId: "registry-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    workerGeneration: 2,
    credentialId: "credential-a",
    credentialGeneration: 3,
    nodeId: "node-a",
    workspaceId: "workspace-a",
    joinAuthorityGeneration: 1,
    targetAdmissionGeneration: 1,
    joinCredentialSha256,
    clientCertificateSha256: D("certificate-a"),
    protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
    protectedAdmissionContextSha256: D("protected-context-a"),
    issuedByActorId: "operator-a",
    idempotencyKey: "join-a",
    requestSha256: D("request-a"),
    issuedAt: "2026-08-09T07:00:00.000Z",
    expiresAt: "2026-08-09T07:05:00.000Z",
  };
}

function issueInput() {
  return {
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    workerGeneration: 2,
    workspaceId: "workspace-a",
    expiresInSeconds: 300,
    actorId: "operator-a",
    idempotencyKey: "join-a",
  } as const;
}

describe("RemoteWorkerMeshNodeJoinAuthorityService", () => {
  it("commits secret-free audit before generating and storing one raw credential", async () => {
    const order: string[] = [];
    const service = new RemoteWorkerMeshNodeJoinAuthorityService({
      protectedAuthority: { resolveCurrent: vi.fn(async () => protectedAuthority()) },
      audit: { append: vi.fn(async () => order.push("audit")) },
      randomSecretBytes: vi.fn(() => {
        order.push("random");
        return Buffer.alloc(32, 0x22);
      }),
      authorities: {
        issueJoinAuthority: vi.fn(async (input) => {
          order.push("store");
          expect(input.rawMeshNodeCredential).toBe(RAW);
          expect(input).not.toHaveProperty("runtimeCredentialTokenSha256");
          return {
            disposition: "created",
            authority: authority(),
            meshNodeCredential: input.rawMeshNodeCredential,
            secretDisposition: "returned_once",
          };
        }),
        revokeJoinAuthority: vi.fn(),
      },
    });
    const issued = await service.issue(issueInput());
    expect(order).toStrictEqual(["audit", "random", "store"]);
    expect(issued).toMatchObject({
      disposition: "created",
      meshNodeCredential: RAW,
      secretDisposition: "returned_once",
    });
    expect(JSON.stringify(issued.authority)).not.toContain(RAW);
  });

  it("returns no generated secret for exact idempotent replay", async () => {
    const service = new RemoteWorkerMeshNodeJoinAuthorityService({
      protectedAuthority: { resolveCurrent: async () => protectedAuthority() },
      audit: { append: async () => undefined },
      randomSecretBytes: () => Buffer.alloc(32, 0x22),
      authorities: {
        issueJoinAuthority: async () => ({
          disposition: "replayed_without_secret",
          authority: authority(D("original-secret")),
          secretDisposition: "not_recoverable",
        }),
        revokeJoinAuthority: vi.fn(),
      },
    });
    await expect(service.issue(issueInput())).resolves.toMatchObject({
      disposition: "replayed_without_secret",
      secretDisposition: "not_recoverable",
    });
    expect((await service.issue(issueInput())).meshNodeCredential).toBeUndefined();
  });

  it("audits and validates immutable revocation receipts", async () => {
    const reason = "Operator rotated the node enrollment window.";
    const service = new RemoteWorkerMeshNodeJoinAuthorityService({
      protectedAuthority: { resolveCurrent: async () => protectedAuthority() },
      audit: { append: vi.fn(async () => undefined) },
      authorities: {
        issueJoinAuthority: vi.fn(),
        revokeJoinAuthority: async (input) => ({
          schemaVersion: REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_REVOCATION_SCHEMA_VERSION,
          registryWorkspaceId: input.registryWorkspaceId,
          workerId: input.workerId,
          workerGeneration: input.workerGeneration,
          workspaceId: input.workspaceId,
          joinAuthorityGeneration: input.joinAuthorityGeneration,
          reasonCode: input.reasonCode,
          reasonSha256: D(input.reason),
          revokedByActorId: input.revokedByActorId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: D("revoke-request-a"),
          revokedAt: "2026-08-09T07:01:00.000Z",
        }),
      },
    });
    await expect(
      service.revoke({
        registryWorkspaceId: "registry-a",
        workerId: "worker-a",
        workerGeneration: 2,
        workspaceId: "workspace-a",
        joinAuthorityGeneration: 1,
        reasonCode: "operator_rotation",
        reason,
        actorId: "operator-a",
        idempotencyKey: "revoke-a",
      }),
    ).resolves.toMatchObject({ reasonSha256: D(reason), auditDeliveryId: expect.any(String) });
  });

  it.each([
    {
      label: "reason code",
      reasonCode: "ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "Operator revoked the enrollment window.",
    },
    {
      label: "reason text",
      reasonCode: "operator_rotation",
      reason: "Operator pasted ghp_aaaaaaaaaaaaaaaaaaaaaaaa into the revocation reason.",
    },
  ])("rejects secret-like $label before audit or storage", async ({ reasonCode, reason }) => {
    const append = vi.fn();
    const revokeJoinAuthority = vi.fn();
    const service = new RemoteWorkerMeshNodeJoinAuthorityService({
      protectedAuthority: { resolveCurrent: vi.fn(async () => protectedAuthority()) },
      audit: { append },
      authorities: { issueJoinAuthority: vi.fn(), revokeJoinAuthority },
    });
    await expect(
      service.revoke({
        registryWorkspaceId: "registry-a",
        workerId: "worker-a",
        workerGeneration: 2,
        workspaceId: "workspace-a",
        joinAuthorityGeneration: 1,
        reasonCode,
        reason,
        actorId: "operator-a",
        idempotencyKey: "revoke-secret-a",
      }),
    ).rejects.toBeInstanceOf(RemoteWorkerMeshNodeJoinAuthorityError);
    expect(append).not.toHaveBeenCalled();
    expect(revokeJoinAuthority).not.toHaveBeenCalled();
  });

  it("fails closed on noncanonical secret sources", async () => {
    const service = new RemoteWorkerMeshNodeJoinAuthorityService({
      protectedAuthority: { resolveCurrent: async () => protectedAuthority() },
      audit: { append: async () => undefined },
      randomSecretBytes: () => Buffer.alloc(31),
      authorities: { issueJoinAuthority: vi.fn(), revokeJoinAuthority: vi.fn() },
    });
    await expect(service.issue(issueInput())).rejects.toBeInstanceOf(RemoteWorkerMeshNodeJoinAuthorityError);
  });
});

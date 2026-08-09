import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER,
  REMOTE_WORKER_MESH_NODE_PROVENANCE,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  buildRemoteWorkerRuntimeCredentialClaims,
  buildRemoteWorkerPopV2Preimage,
  canonicalJsonString,
  remoteWorkerRuntimeCredentialClaimsSha256,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
  REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
  REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
  RemoteWorkerMeshNodeAdmissionError,
  RemoteWorkerMeshNodeAdmissionService,
  type RemoteWorkerMeshNodeAdmissionStoreInput,
  type RemoteWorkerMeshNodeAdmissionStoreOutcome,
} from "./remote-worker-mesh-node-admission-service.js";
import {
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_HEADERS,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  type RemoteWorkerProtocolBody,
} from "./remote-worker-protocol.js";
import type { CurrentRemoteWorkerRuntimeCredentialAuthority } from "./remote-worker-current-authority-service.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

const NOW = new Date("2026-08-08T20:00:00.000Z");
const RUNTIME_CREDENTIAL = Buffer.alloc(32, 0x11).toString("base64url");
const JOIN_CREDENTIAL = Buffer.alloc(32, 0x22).toString("base64url");
const NONCE = Buffer.alloc(32, 0x33).toString("base64url");
const D = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function fixture(proofVersion: "v1" | "v2" = "v2") {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(publicKeySpkiDer)) throw new Error("test key export failed");
  const claims = buildRemoteWorkerRuntimeCredentialClaims({
    registryWorkspaceId: "registry-a",
    workerId: "worker-a",
    workerGeneration: 2,
    allowedWorkspaceIds: ["registry-a", "workspace-a"],
    capabilityClasses: ["durable_compute"],
  });
  const tlsExporter = Buffer.alloc(32, 0x44);
  const transportIdentity: RemoteWorkerTransportIdentity = {
    source: "native_mtls",
    certificateDerSha256: D("certificate-a"),
    publicKeySpkiSha256: D(publicKeySpkiDer),
    trustAnchorDerSha256: D("trust-anchor-a"),
    tlsExporterSha256: D(tlsExporter),
    tlsExporter,
  };
  const authority: CurrentRemoteWorkerRuntimeCredentialAuthority = {
    credentialId: "credential-a",
    credentialGeneration: 3,
    authorizationCredentialSha256: D(RUNTIME_CREDENTIAL),
    registryWorkspaceId: "registry-a",
    bootstrapId: "bootstrap-a",
    workerId: "worker-a",
    workerGeneration: 2,
    nodeId: "node-a",
    publicKeySpkiDer,
    publicKeySpkiSha256: D(publicKeySpkiDer),
    clientCertificateSha256: transportIdentity.certificateDerSha256,
    transportTrustAnchorSha256: transportIdentity.trustAnchorDerSha256,
    runtimeManifestSha256: D("manifest-a"),
    workspaceCeilingSha256: claims.workspaceCeilingSha256,
    capabilityCeilingSha256: claims.capabilityCeilingSha256,
    protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
    protectedAdmissionContextSha256: D("protected-context-a"),
    claims,
    claimsSha256: remoteWorkerRuntimeCredentialClaimsSha256(claims),
  };
  const body: RemoteWorkerProtocolBody = {
    schemaVersion: proofVersion === "v2" ? REMOTE_WORKER_POP_V2_SCHEMA_VERSION : REMOTE_WORKER_POP_SCHEMA_VERSION,
    operation: REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
    authorityId: authority.credentialId,
    authorityGeneration: authority.credentialGeneration,
    ...(proofVersion === "v2" ? { workerGeneration: authority.workerGeneration } : {}),
    idempotencyKey: "mesh-node-admit-a",
    payload: {
      schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      joinCredentialSha256: D(JOIN_CREDENTIAL),
    },
  };
  const bodySha256 = remoteWorkerProtocolBodySha256(body);
  const signedBytes =
    proofVersion === "v2"
      ? Buffer.from(
          buildRemoteWorkerPopV2Preimage({
            schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
            method: REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
            rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
            operation: REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
            bodySha256,
            nonce: NONCE,
            timestamp: NOW.toISOString(),
            idempotencyKey: body.idempotencyKey,
            authorityKind: "credential",
            authorityId: body.authorityId,
            authorityGeneration: body.authorityGeneration,
            workerGeneration: authority.workerGeneration,
            tlsExporterSha256: transportIdentity.tlsExporterSha256,
            clientCertificateSha256: transportIdentity.certificateDerSha256,
            workerPublicKeySpkiSha256: authority.publicKeySpkiSha256,
          }),
        )
      : Buffer.from(
          canonicalJsonString(
            buildRemoteWorkerPopMaterial({
              rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
              bodySha256,
              operation: REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
              nonce: NONCE,
              timestamp: NOW.toISOString(),
              idempotencyKey: body.idempotencyKey,
              authorityId: body.authorityId,
              authorityGeneration: body.authorityGeneration,
              transportIdentity,
            }),
          ),
          "utf8",
        );
  const headers = {
    [REMOTE_WORKER_PROTOCOL_HEADERS.authorization]: `Bearer ${RUNTIME_CREDENTIAL}`,
    [REMOTE_WORKER_PROTOCOL_HEADERS.timestamp]: NOW.toISOString(),
    [REMOTE_WORKER_PROTOCOL_HEADERS.nonce]: NONCE,
    [REMOTE_WORKER_PROTOCOL_HEADERS.operation]: REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
    [REMOTE_WORKER_PROTOCOL_HEADERS.proof]: sign(null, signedBytes, keyPair.privateKey).toString("base64url"),
    [REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey]: body.idempotencyKey,
    [REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER]: JOIN_CREDENTIAL,
  };
  return { authority, body, headers, transportIdentity };
}

function outcome(input: RemoteWorkerMeshNodeAdmissionStoreInput): RemoteWorkerMeshNodeAdmissionStoreOutcome {
  const stableEffectSha256 = D("stable-effect-a");
  const admittedAt = NOW.toISOString();
  return {
    disposition: "admitted",
    admission: {
      workspaceId: "workspace-a",
      nodeId: "node-a",
      admissionGeneration: 1,
      joinCredentialSha256: D(JOIN_CREDENTIAL),
      mtlsRequired: true,
      tlsFingerprint: input.command.clientCertificateSha256,
      provenance: REMOTE_WORKER_MESH_NODE_PROVENANCE,
      admittedByActorId: "remote-worker:worker-a:2",
      idempotencyKey: input.command.idempotencyKey,
      requestSha256: D("admission-request-a"),
      admittedAt,
    },
    binding: {
      schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION,
      provenance: REMOTE_WORKER_MESH_NODE_PROVENANCE,
      registryWorkspaceId: "registry-a",
      bootstrapId: "bootstrap-a",
      workerId: "worker-a",
      workerGeneration: 2,
      credentialId: "credential-a",
      credentialGeneration: 3,
      workspaceId: "workspace-a",
      nodeId: "node-a",
      admissionGeneration: 1,
      joinAuthorityGeneration: 1,
      joinCredentialSha256: D(JOIN_CREDENTIAL),
      protectedAdmissionEnvelopeSha256: D("protected-envelope-a"),
      protectedAdmissionContextSha256: D("protected-context-a"),
      stableEffectSha256,
      admittedByActorId: "remote-worker:worker-a:2",
      idempotencyKey: input.command.idempotencyKey,
      admittedAt,
    },
    stableEffectSha256,
  };
}

describe("RemoteWorkerMeshNodeAdmissionService", () => {
  it("verifies native mTLS and PoP, then hands the raw secret to one atomic storage operation", async () => {
    const f = fixture();
    const admitWithNonce = vi.fn(async (input: RemoteWorkerMeshNodeAdmissionStoreInput) => outcome(input));
    const service = new RemoteWorkerMeshNodeAdmissionService({
      currentAuthority: { resolveByCredentialTokenSha256: vi.fn(async () => f.authority) },
      admissions: { assertAvailable: vi.fn(async () => undefined), admitWithNonce },
      clock: () => NOW,
    });

    await expect(
      service.admit({
        method: REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
        rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
        headers: f.headers,
        body: f.body,
        transportIdentity: f.transportIdentity,
      }),
    ).resolves.toMatchObject({ disposition: "admitted", workspaceId: "workspace-a", nodeId: "node-a" });
    expect(admitWithNonce).toHaveBeenCalledOnce();
    expect(admitWithNonce.mock.calls[0]?.[0]).toMatchObject({
      command: {
        rawMeshNodeCredential: JOIN_CREDENTIAL,
        protocolBodySha256: remoteWorkerProtocolBodySha256(f.body),
        clientCertificateSha256: f.authority.clientCertificateSha256,
      },
      nonce: { authority: { kind: "credential", credentialId: "credential-a" } },
    });
  });

  it("never accepts the stored digest as the join bearer credential", async () => {
    const f = fixture();
    f.headers[REMOTE_WORKER_MESH_NODE_JOIN_CREDENTIAL_HEADER] = D(JOIN_CREDENTIAL);
    const admitWithNonce = vi.fn();
    const service = new RemoteWorkerMeshNodeAdmissionService({
      currentAuthority: { resolveByCredentialTokenSha256: vi.fn(async () => f.authority) },
      admissions: { assertAvailable: vi.fn(async () => undefined), admitWithNonce },
      clock: () => NOW,
    });
    await expect(
      service.admit({
        method: REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
        rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
        headers: f.headers,
        body: f.body,
        transportIdentity: f.transportIdentity,
      }),
    ).rejects.toBeInstanceOf(RemoteWorkerMeshNodeAdmissionError);
    expect(admitWithNonce).not.toHaveBeenCalled();
  });

  it("rejects legacy proof v1 without downgrading the protected remote authority", async () => {
    const f = fixture("v1");
    const admitWithNonce = vi.fn();
    const service = new RemoteWorkerMeshNodeAdmissionService({
      currentAuthority: { resolveByCredentialTokenSha256: vi.fn(async () => f.authority) },
      admissions: { assertAvailable: vi.fn(async () => undefined), admitWithNonce },
      clock: () => NOW,
    });
    await expect(
      service.admit({
        method: REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
        rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
        headers: f.headers,
        body: f.body,
        transportIdentity: f.transportIdentity,
      }),
    ).rejects.toBeInstanceOf(RemoteWorkerMeshNodeAdmissionError);
    expect(admitWithNonce).not.toHaveBeenCalled();
  });

  it("rejects workspace drift before storage mutation", async () => {
    const f = fixture();
    f.body.payload = { ...f.body.payload, workspaceId: "workspace-b" };
    const admitWithNonce = vi.fn();
    const service = new RemoteWorkerMeshNodeAdmissionService({
      currentAuthority: { resolveByCredentialTokenSha256: vi.fn(async () => f.authority) },
      admissions: { assertAvailable: vi.fn(async () => undefined), admitWithNonce },
      clock: () => NOW,
    });
    await expect(
      service.admit({
        method: REMOTE_WORKER_MESH_NODE_ADMISSION_METHOD,
        rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
        headers: f.headers,
        body: f.body,
        transportIdentity: f.transportIdentity,
      }),
    ).rejects.toBeInstanceOf(RemoteWorkerMeshNodeAdmissionError);
    expect(admitWithNonce).not.toHaveBeenCalled();
  });
});

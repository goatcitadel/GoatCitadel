import { createHash } from "node:crypto";
import {
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  type RemoteWorkerMeshNodeAuthorityFence,
} from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MESH_NODE_TLS_FINGERPRINT_HEADER,
  MeshCapabilityPublicationService,
  type MeshCapabilityRemoteWorkerAuthorityPort,
} from "./mesh-capability-publication-service.js";

const CERTIFICATE = "c".repeat(64);
const fence: RemoteWorkerMeshNodeAuthorityFence = {
  schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
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
  joinCredentialSha256: "1".repeat(64),
  protectedAdmissionEnvelopeSha256: "2".repeat(64),
  protectedAdmissionContextSha256: "3".repeat(64),
};

let storage: Storage | undefined;
afterEach(() => {
  storage?.close();
  storage = undefined;
});

function service(remoteWorkerAuthority: MeshCapabilityRemoteWorkerAuthorityPort): MeshCapabilityPublicationService {
  storage = new Storage({ dbPath: ":memory:" });
  return new MeshCapabilityPublicationService({ storage: createSqliteAsyncStorage(storage), remoteWorkerAuthority });
}

describe("MeshCapabilityPublicationService remote-worker authority", () => {
  it("never downgrades explicit remote provenance when its binding is missing", async () => {
    const publication = service({
      resolveByRawMeshNodeCredential: vi.fn(async () => ({
        disposition: "unavailable",
        provenance: "remote_worker",
        reason: "missing_remote_binding",
      })),
    });
    await expect(
      publication.authenticateNodeRequest({
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          [MESH_NODE_TLS_FINGERPRINT_HEADER]: CERTIFICATE,
        },
      }),
    ).resolves.toMatchObject({ statusCode: 403, reason: "mesh_node_unknown_or_revoked" });
  });

  it("does not treat the caller-controlled fingerprint header as native mTLS", async () => {
    const publication = service({
      resolveByRawMeshNodeCredential: vi.fn(async () => ({
        disposition: "current",
        provenance: "remote_worker",
        admission: {
          workspaceId: "workspace-a",
          nodeId: "node-a",
          admissionGeneration: 1,
          mtlsRequired: true,
          tlsFingerprint: CERTIFICATE,
        },
        fence,
      })),
    });
    await expect(
      publication.authenticateNodeRequest({
        headers: {
          authorization: `Bearer ${"a".repeat(43)}`,
          [MESH_NODE_TLS_FINGERPRINT_HEADER]: CERTIFICATE,
        },
      }),
    ).resolves.toMatchObject({ statusCode: 503, reason: "mesh_node_native_mtls_required" });
  });

  it("carries the exact current fence only from a matching native transport identity", async () => {
    const publication = service({
      resolveByRawMeshNodeCredential: vi.fn(async () => ({
        disposition: "current",
        provenance: "remote_worker",
        admission: {
          workspaceId: "workspace-a",
          nodeId: "node-a",
          admissionGeneration: 1,
          mtlsRequired: true,
          tlsFingerprint: CERTIFICATE,
        },
        fence,
      })),
    });
    const tlsExporter = Buffer.alloc(32, 0x11);
    await expect(
      publication.authenticateNodeRequest({
        headers: { authorization: `Bearer ${"a".repeat(43)}` },
        transportIdentity: {
          source: "native_mtls",
          certificateDerSha256: CERTIFICATE,
          publicKeySpkiSha256: "4".repeat(64),
          trustAnchorDerSha256: "5".repeat(64),
          tlsExporterSha256: createHash("sha256").update(tlsExporter).digest("hex"),
          tlsExporter,
        },
      }),
    ).resolves.toMatchObject({
      identity: {
        provenance: "remote_worker",
        workspaceId: "workspace-a",
        nodeId: "node-a",
        remoteWorkerAuthorityFence: fence,
      },
    });
  });
});

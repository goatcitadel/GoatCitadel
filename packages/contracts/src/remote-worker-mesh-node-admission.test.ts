import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
  REMOTE_WORKER_MESH_NODE_JOIN_AUTHORITY_SCHEMA_VERSION,
  normalizeIssueRemoteWorkerMeshNodeJoinAuthorityRequest,
  normalizeRemoteWorkerMeshNodeAdmissionBindingRecord,
  normalizeRemoteWorkerMeshNodeAdmissionPayload,
  normalizeRemoteWorkerMeshNodeAuthorityFence,
  normalizeRemoteWorkerMeshNodeJoinAuthorityRecord,
  remoteWorkerMeshNodeStableEffectSha256,
} from "./remote-worker-mesh-node-admission.js";

const digest = (character: string): string => character.repeat(64);

function authority() {
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
    joinAuthorityGeneration: 4,
    targetAdmissionGeneration: 5,
    joinCredentialSha256: digest("1"),
    clientCertificateSha256: digest("2"),
    protectedAdmissionEnvelopeSha256: digest("3"),
    protectedAdmissionContextSha256: digest("4"),
    issuedByActorId: "operator-a",
    idempotencyKey: "issue-a",
    requestSha256: digest("5"),
    issuedAt: "2026-08-08T19:50:00.000Z",
    expiresAt: "2026-08-08T20:00:00.000Z",
  } as const;
}

describe("remote worker mesh-node admission contracts", () => {
  it("binds one join authority to an exact credential, workspace, and HX-408 generation", () => {
    expect(normalizeRemoteWorkerMeshNodeJoinAuthorityRecord(authority())).toEqual(authority());
    expect(() =>
      normalizeRemoteWorkerMeshNodeJoinAuthorityRecord({
        ...authority(),
        expiresAt: "2026-08-08T20:00:00.001Z",
      }),
    ).toThrow();
  });

  it("treats the client digest as a signed binding, never as the raw credential", () => {
    const payload = normalizeRemoteWorkerMeshNodeAdmissionPayload({
      schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_PAYLOAD_SCHEMA_VERSION,
      workspaceId: "workspace-a",
      joinCredentialSha256: digest("1"),
    });
    expect(payload.joinCredentialSha256).toBe(digest("1"));
    expect(() => normalizeRemoteWorkerMeshNodeAdmissionPayload({ ...payload, meshNodeCredential: "secret" })).toThrow();
  });

  it("keeps operator issuance bounded and workspace-scoped", () => {
    expect(
      normalizeIssueRemoteWorkerMeshNodeJoinAuthorityRequest({
        registryWorkspaceId: "registry-a",
        workerId: "worker-a",
        workerGeneration: 2,
        workspaceId: "workspace-a",
        expiresInSeconds: 600,
        idempotencyKey: "issue-a",
      }),
    ).toMatchObject({ workspaceId: "workspace-a", expiresInSeconds: 600 });
    expect(() =>
      normalizeIssueRemoteWorkerMeshNodeJoinAuthorityRequest({
        registryWorkspaceId: "registry-a",
        workerId: "worker-a",
        workerGeneration: 2,
        workspaceId: "workspace-a",
        expiresInSeconds: 601,
        idempotencyKey: "issue-a",
      }),
    ).toThrow();
  });

  it("preserves explicit remote provenance and a storage-checkable current-authority fence", () => {
    const fence = {
      schemaVersion: REMOTE_WORKER_MESH_NODE_AUTHORITY_FENCE_SCHEMA_VERSION,
      registryWorkspaceId: "registry-a",
      bootstrapId: "bootstrap-a",
      workerId: "worker-a",
      workerGeneration: 2,
      credentialId: "credential-a",
      credentialGeneration: 3,
      workspaceId: "workspace-a",
      nodeId: "node-a",
      admissionGeneration: 5,
      joinAuthorityGeneration: 4,
      joinCredentialSha256: digest("1"),
      protectedAdmissionEnvelopeSha256: digest("3"),
      protectedAdmissionContextSha256: digest("4"),
    } as const;
    expect(normalizeRemoteWorkerMeshNodeAuthorityFence(fence)).toEqual(fence);
    expect(
      normalizeRemoteWorkerMeshNodeAdmissionBindingRecord({
        ...fence,
        schemaVersion: REMOTE_WORKER_MESH_NODE_ADMISSION_BINDING_SCHEMA_VERSION,
        provenance: "remote_worker",
        stableEffectSha256: digest("6"),
        admittedByActorId: "remote-worker:worker-a:2",
        idempotencyKey: "admit-a",
        admittedAt: "2026-08-08T19:55:00.000Z",
      }),
    ).toMatchObject({ provenance: "remote_worker", admissionGeneration: 5 });
  });

  it("hashes stable effect identity without accepting per-attempt receipts", () => {
    const effect = {
      method: "POST",
      rawPath: "/api/v1/remote-workers/mesh-node-admissions",
      operation: "mesh.node.admit",
      registryWorkspaceId: "registry-a",
      bootstrapId: "bootstrap-a",
      workerId: "worker-a",
      workerGeneration: 2,
      credentialId: "credential-a",
      credentialGeneration: 3,
      workspaceId: "workspace-a",
      nodeId: "node-a",
      joinAuthorityGeneration: 4,
      targetAdmissionGeneration: 5,
      joinCredentialSha256: digest("1"),
      clientCertificateSha256: digest("2"),
      protocolBodySha256: digest("7"),
      idempotencyKey: "admit-a",
    } as const;
    expect(remoteWorkerMeshNodeStableEffectSha256(effect)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      remoteWorkerMeshNodeStableEffectSha256({ ...effect, proofOfPossessionReceiptSha256: digest("8") } as never),
    ).toThrow();
  });
});

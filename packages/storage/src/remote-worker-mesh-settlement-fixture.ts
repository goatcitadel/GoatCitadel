import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  deriveMeshCapabilityId,
  type MeshToolCapabilityDescriptor,
  type RemoteWorkerMeshNodeAuthorityFence,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import {
  MeshCapabilityPublicationRepository,
  buildMeshCapabilityActivationApprovalPayload,
  buildMeshCapabilityActivationDiffs,
  computeMeshCapabilityDescriptorSha256,
  computeMeshCapabilityEntrySha256,
  computeMeshCapabilityManifestSha256,
  type ActivateMeshCapabilityInput,
  type SettleMeshCapabilityInvocationInput,
} from "./mesh-capability-publication-repo.js";
import { MeshRepository } from "./mesh-repo.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Uses real protected M2/M3 rows supplied by the shared worker admission fixture. */
export function verifyRemoteWorkerMeshSettlements(
  db: DatabaseClient,
  seed: string,
  fence: RemoteWorkerMeshNodeAuthorityFence,
  certificateSha256: string,
  revokeAuthority: () => void,
): void {
  const repo = new MeshCapabilityPublicationRepository(db);
  const mesh = new MeshRepository(db);
  const now = new Date().toISOString();
  const lease = mesh.acquireLease(`mesh-capability-publication:${fence.workspaceId}:${fence.nodeId}`, fence.nodeId, 600, now);
  repo.registerRemoteWorkerPublisher({
    authorityFence: fence,
    publisher: {
      workspaceId: fence.workspaceId, nodeId: fence.nodeId, admissionGeneration: fence.admissionGeneration,
      publisherGeneration: 1, mtlsRequired: true, tlsFingerprint: certificateSha256,
      publicationLeaseKey: lease.leaseKey, publicationLeaseFencingToken: lease.fencingToken,
      publicationLeaseExpiresAt: lease.expiresAt, idempotencyKey: `${seed}:publisher`,
    },
  });
  const descriptor: MeshToolCapabilityDescriptor = {
    kind: "tool", title: "Controlled worker status", semanticVersion: "1.0.0", effectPosture: "read_only",
    permissions: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
      filesystemRead: [], filesystemWrite: [], networkOrigins: [], environmentNames: [], deviceCapabilities: [],
    },
    resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 1024, maxResponseBytes: 1024 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, idempotency: "intrinsic",
  };
  const unsignedEntry = {
    localId: "status", kind: "tool" as const, capabilityId: deriveMeshCapabilityId(fence.nodeId, "tool", "status"),
    descriptor, descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor),
    permissionEnvelopeSha256: computeMeshCapabilityDescriptorSha256(descriptor.permissions),
  };
  const entry = { ...unsignedEntry, entrySha256: computeMeshCapabilityEntrySha256(unsignedEntry) };
  const unsignedManifest = {
    schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    workspaceId: fence.workspaceId, nodeId: fence.nodeId, admissionGeneration: fence.admissionGeneration,
    publisherGeneration: 1, publicationKey: `${seed}:manifest`, publicationLeaseFencingToken: lease.fencingToken,
    entries: [entry], createdAt: now,
  };
  const manifest = repo.publishRemoteWorkerManifest({
    authorityFence: fence,
    manifest: { ...unsignedManifest, manifestSha256: computeMeshCapabilityManifestSha256(unsignedManifest) },
  });
  const activationInput: ActivateMeshCapabilityInput = {
    workspaceId: fence.workspaceId, nodeId: fence.nodeId, publisherGeneration: 1, healthGeneration: 1,
    publicationLeaseFencingToken: lease.fencingToken, manifestSha256: manifest.manifestSha256,
    entrySha256: entry.entrySha256, descriptorSha256: entry.descriptorSha256,
    permissionEnvelopeSha256: entry.permissionEnvelopeSha256, effectPosture: descriptor.effectPosture,
    ...buildMeshCapabilityActivationDiffs({ currentEntry: entry }),
    capabilityId: entry.capabilityId, activationId: `${seed}:activation`, activationRevision: 1,
    approvalId: `${seed}:approval`, actorId: "operator-a", idempotencyKey: `${seed}:activation`,
  };
  db.prepare(`INSERT INTO approvals (
    approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
    explanation_status, created_at, expires_at, resolved_at, resolved_by
  ) VALUES (?, 'mesh.capability.activate', 'high', 'approved', ?, ?, '{}', 'not_requested', ?, ?, ?, 'operator-a')`)
    .run(activationInput.approvalId, JSON.stringify({ workspaceId: fence.workspaceId }),
      JSON.stringify(buildMeshCapabilityActivationApprovalPayload(activationInput)), now, lease.expiresAt, now);
  const activation = repo.activate(activationInput);
  const submission = (suffix: string): SettleMeshCapabilityInvocationInput => {
    const intent = repo.createInvocationIntent({
      workspaceId: fence.workspaceId, invocationId: `${seed}:${suffix}`, activationId: activation.activationId,
      activationRevision: activation.activationRevision, capabilityId: activation.capabilityId, nodeId: fence.nodeId,
      publisherGeneration: 1, healthGeneration: 1, publicationLeaseFencingToken: lease.fencingToken,
      manifestSha256: manifest.manifestSha256, entrySha256: entry.entrySha256,
      descriptorSha256: entry.descriptorSha256, permissionEnvelopeSha256: entry.permissionEnvelopeSha256,
      executionProfileSha256: digest(`${seed}:profile`), inputSha256: digest(`${seed}:input`),
      sessionId: `${seed}:session`, turnId: `${seed}:turn`, deadlineAt: new Date(Date.now() + 20_000).toISOString(),
      idempotencyKey: `${seed}:invoke:${suffix}`,
    });
    return {
      workspaceId: fence.workspaceId, invocationId: intent.invocationId, disposition: "succeeded",
      outputSha256: digest(`${seed}:output`), settlementSha256: digest(`${seed}:settlement`),
      publisherGeneration: 1, publicationLeaseFencingToken: lease.fencingToken, idempotencyKey: `${seed}:settle:${suffix}`,
    };
  };
  const first = submission("first");
  const pending = submission("pending");
  const settle = (settlement: SettleMeshCapabilityInvocationInput, authorityFence = fence) =>
    repo.settleRemoteWorkerInvocation({ authorityFence, settlement });
  for (const patch of [
    { nodeId: `${fence.nodeId}-other` }, { workspaceId: "other-workspace" },
    { admissionGeneration: fence.admissionGeneration + 1 }, { credentialGeneration: fence.credentialGeneration + 1 },
    { protectedAdmissionContextSha256: digest(`${seed}:wrong-context`) },
  ]) assert.throws(() => settle(first, { ...fence, ...patch }));
  assert.equal(repo.findInvocationSettlement(fence.workspaceId, first.invocationId), undefined);

  // Withdrawing activation prevents new work, but a still-admitted node can report an already dispatched outcome.
  repo.revoke({ workspaceId: fence.workspaceId, activationId: activation.activationId, reason: "Controlled withdrawal",
    actorId: "operator-a", idempotencyKey: `${seed}:withdraw` });
  const retained = settle(first);
  assert.deepEqual(settle(first), retained);
  assert.throws(() => settle({ ...first, disposition: "failed" }), /different request bytes/u);
  assert.throws(() => settle(pending, { ...fence, credentialId: `${fence.credentialId}-other` }));

  revokeAuthority();
  assert.throws(() => settle(first), "revocation must also reject an otherwise identical replay");
  assert.throws(() => settle(pending), "revocation must reject the first submission of a dispatched result");
  assert.deepEqual(repo.findInvocationSettlement(fence.workspaceId, first.invocationId), retained);
  assert.equal(repo.findInvocationSettlement(fence.workspaceId, pending.invocationId), undefined);
}

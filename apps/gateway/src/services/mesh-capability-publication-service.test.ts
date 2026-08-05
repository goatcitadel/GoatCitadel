import { createHash } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import {
  MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  deriveMeshCapabilityId,
  type MeshCapabilityDescriptor,
} from "@goatcitadel/contracts";
import {
  Storage,
  buildMeshCapabilityActivationApprovalPayload,
  computeMeshCapabilityDescriptorSha256,
  createSqliteAsyncStorage,
  type ActivateMeshCapabilityInput,
} from "@goatcitadel/storage";
import {
  MESH_NODE_TLS_FINGERPRINT_HEADER,
  MeshCapabilityPublicationService,
  isMeshCapabilityNodePublicationPath,
  toMeshCapabilityPublicationHttpError,
  type MeshCapabilityAuthenticatedNodeIdentity,
  type MeshCapabilityManifestEntrySubmission,
} from "./mesh-capability-publication-service.js";

const storages: Storage[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
});

function createStorage(): Storage {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  storages.push(storage);
  return storage;
}

function admitNode(
  storage: Storage,
  input: {
    workspaceId?: string;
    nodeId: string;
    token: string;
    mtlsRequired?: boolean;
    tlsFingerprint?: string;
    expectedAdmissionGeneration?: number;
    nodeStatus?: "online" | "offline";
  },
): void {
  const workspaceId = input.workspaceId ?? "default";
  const fingerprint = input.tlsFingerprint ?? `sha256:${input.nodeId}`;
  const mtlsRequired = input.mtlsRequired ?? true;
  const now = new Date().toISOString();
  storage.mesh.upsertNode({
    nodeId: input.nodeId,
    transport: "lan",
    status: input.nodeStatus ?? "online",
    capabilities: [],
    ...(mtlsRequired || input.tlsFingerprint !== undefined ? { tlsFingerprint: fingerprint } : {}),
    joinedAt: now,
    lastSeenAt: now,
  });
  storage.mesh.issueJoinToken(input.token, "2099-01-01T00:00:00.000Z");
  expect(storage.mesh.consumeJoinToken(input.token, input.nodeId, now)).toBe(true);
  storage.meshCapabilityNodeAdmissions.admit({
    workspaceId,
    nodeId: input.nodeId,
    expectedAdmissionGeneration: input.expectedAdmissionGeneration ?? 0,
    joinTokenSha256: createHash("sha256").update(input.token).digest("hex"),
    mtlsRequired,
    ...(mtlsRequired || input.tlsFingerprint !== undefined ? { tlsFingerprint: fingerprint } : {}),
    admittedByActorId: "operator-a",
    idempotencyKey: `admit:${workspaceId}:${input.nodeId}:${input.token}`,
  });
}

function nodeHeaders(token: string, fingerprint?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(fingerprint === undefined ? {} : { [MESH_NODE_TLS_FINGERPRINT_HEADER]: fingerprint }),
  };
}

function descriptorOf(kind: "tool" | "mcp_server" | "skill", title = "Project status"): MeshCapabilityDescriptor {
  const base = {
    title,
    semanticVersion: "1.0.0",
    effectPosture: "read_only" as const,
    permissions: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
      filesystemRead: ["workspace://project"],
      filesystemWrite: [],
      networkOrigins: [],
      environmentNames: [],
      deviceCapabilities: [],
    },
    resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 },
    healthCheck: { protocol: "mesh.capability-health.v1" as const, intervalMs: 30_000, timeoutMs: 5_000 },
  };
  if (kind === "tool") {
    return {
      ...base,
      kind,
      inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      idempotency: "intrinsic",
    };
  }
  if (kind === "mcp_server") {
    return {
      ...base,
      kind,
      protocol: "mcp",
      protocolVersion: "2025-06-18",
      tools: [{ name: "files.read", inputSchemaSha256: "4".repeat(64) }],
    };
  }
  return {
    ...base,
    kind,
    manifestSha256: "1".repeat(64),
    instructionsSha256: "2".repeat(64),
    proofSha256: "3".repeat(64),
  };
}

function submissionEntry(
  kind: "tool" | "mcp_server" | "skill",
  localId: string,
  descriptor = descriptorOf(kind) as unknown as Record<string, unknown>,
): MeshCapabilityManifestEntrySubmission {
  return {
    localId,
    kind,
    descriptor,
    descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor),
  };
}

async function authenticate(service: MeshCapabilityPublicationService, token: string, fingerprint?: string) {
  const result = await service.authenticateNodeRequest({ headers: nodeHeaders(token, fingerprint) });
  expect(result).toHaveProperty("identity");
  return (result as { identity: MeshCapabilityAuthenticatedNodeIdentity }).identity;
}

function createService(storage: Storage): MeshCapabilityPublicationService {
  return new MeshCapabilityPublicationService({ storage: createSqliteAsyncStorage(storage) });
}

function approveActivation(storage: Storage, input: ActivateMeshCapabilityInput): void {
  const payload = buildMeshCapabilityActivationApprovalPayload(input);
  storage.db
    .prepare(
      `
      INSERT INTO approvals (
        approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
        explanation_status, created_at, expires_at, resolved_at, resolved_by
      ) VALUES (?, 'mesh.capability.activate', 'high', 'approved', ?, ?, '{}', 'not_requested', ?, ?, ?, 'operator-a')
    `,
    )
    .run(
      input.approvalId,
      JSON.stringify({ workspaceId: input.workspaceId, sessionId: input.sessionId, turnId: input.turnId }),
      JSON.stringify(payload),
      "2026-07-14T12:00:00.000Z",
      "2099-01-01T02:00:00.000Z",
      "2026-07-14T12:01:00.000Z",
    );
}

describe("MeshCapabilityPublicationService node authentication", () => {
  it("resolves the identity tuple from the durable admission authority only", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);

    await expect(service.authenticateNodeRequest({ headers: {} })).resolves.toMatchObject({
      statusCode: 401,
      reason: "mesh_node_token_required",
    });
    await expect(
      service.authenticateNodeRequest({ headers: nodeHeaders("wrong-token", "sha256:node-a") }),
    ).resolves.toMatchObject({
      statusCode: 403,
      reason: "mesh_node_unknown_or_revoked",
    });
    await expect(service.authenticateNodeRequest({ headers: nodeHeaders("join-node-a") })).resolves.toMatchObject({
      statusCode: 403,
      reason: "mesh_node_certificate_mismatch",
    });
    await expect(
      service.authenticateNodeRequest({ headers: nodeHeaders("join-node-a", "sha256:forged") }),
    ).resolves.toMatchObject({
      statusCode: 403,
      reason: "mesh_node_certificate_mismatch",
    });

    const identity = await authenticate(service, "join-node-a", "sha256:node-a");
    expect(identity).toEqual({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
    });
  });

  it("rejects superseded and revoked admission credentials", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a-1" });
    storage.meshCapabilityNodeAdmissions.revoke({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      reason: "Rotate the admission identity.",
      revokedByActorId: "operator-a",
      idempotencyKey: "revoke:node-a:1",
    });
    const service = createService(storage);
    await expect(
      service.authenticateNodeRequest({ headers: nodeHeaders("join-node-a-1", "sha256:node-a") }),
    ).resolves.toMatchObject({
      statusCode: 403,
      reason: "mesh_node_unknown_or_revoked",
    });

    admitNode(storage, { nodeId: "node-a", token: "join-node-a-2", expectedAdmissionGeneration: 1 });
    await expect(
      service.authenticateNodeRequest({ headers: nodeHeaders("join-node-a-1", "sha256:node-a") }),
    ).resolves.toMatchObject({
      statusCode: 403,
      reason: "mesh_node_unknown_or_revoked",
    });
    expect((await authenticate(service, "join-node-a-2", "sha256:node-a")).admissionGeneration).toBe(2);
  });
});

describe("MeshCapabilityPublicationService manifest publication", () => {
  it("publishes a validated manifest with server-derived identity, replays same bytes, and conflicts on drift", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);
    const identity = await authenticate(service, "join-node-a", "sha256:node-a");

    const submission = {
      publicationKey: "publication-1",
      entries: [submissionEntry("skill", "project.guide"), submissionEntry("tool", "project.status")],
    };
    const receipt = await service.publishCapabilityManifest(identity, submission);
    expect(receipt.replayed).toBe(false);
    expect(receipt.manifest.workspaceId).toBe("default");
    expect(receipt.manifest.nodeId).toBe("node-a");
    expect(receipt.manifest.admissionGeneration).toBe(1);
    expect(receipt.manifest.publisherGeneration).toBe(1);
    expect(receipt.manifest.entries.map((entry) => entry.capabilityId)).toEqual([
      deriveMeshCapabilityId("node-a", "skill", "project.guide"),
      deriveMeshCapabilityId("node-a", "tool", "project.status"),
    ]);
    expect(receipt.entries.map((entry) => entry.status)).toEqual(["review_required", "review_required"]);
    expect(receipt.entries.find((entry) => entry.capabilityKind === "skill")?.reasons).toContain(
      "skill_descriptor_never_callable",
    );

    const replay = await service.publishCapabilityManifest(identity, submission);
    expect(replay.replayed).toBe(true);
    expect(replay.manifest.manifestSha256).toBe(receipt.manifest.manifestSha256);
    expect(storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")?.publisherGeneration).toBe(1);

    await expect(
      service.publishCapabilityManifest(identity, {
        publicationKey: "publication-1",
        entries: [submissionEntry("tool", "project.changed")],
      }),
    ).rejects.toThrow(/different request bytes/);
  });

  it("fails malformed submissions closed before any publisher-binding write", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);
    const identity = await authenticate(service, "join-node-a", "sha256:node-a");

    const tampered = submissionEntry("tool", "project.status");
    tampered.descriptorSha256 = "0".repeat(64);
    await expect(
      service.publishCapabilityManifest(identity, { publicationKey: "p-digest", entries: [tampered] }),
    ).rejects.toThrow(/digest does not match/);

    const unknownField = descriptorOf("tool") as unknown as Record<string, unknown>;
    unknownField.extraField = "surprise";
    await expect(
      service.publishCapabilityManifest(identity, {
        publicationKey: "p-unknown",
        entries: [submissionEntry("tool", "project.status", unknownField)],
      }),
    ).rejects.toThrow(/unknown field/);

    const smuggledUrl = descriptorOf("tool") as unknown as Record<string, unknown>;
    smuggledUrl.inputSchema = { type: "object", endpoint: "https://bypass.example" };
    await expect(
      service.publishCapabilityManifest(identity, {
        publicationKey: "p-url",
        entries: [submissionEntry("tool", "project.status", smuggledUrl)],
      }),
    ).rejects.toThrow(/direct transport or credential field/);

    const smuggledCredential = descriptorOf("tool") as unknown as Record<string, unknown>;
    smuggledCredential.description = "authorization: bearer AAAAAAAAAAAAAAAA";
    await expect(
      service.publishCapabilityManifest(identity, {
        publicationKey: "p-credential",
        entries: [submissionEntry("tool", "project.status", smuggledCredential)],
      }),
    ).rejects.toThrow(/credential material/);

    await expect(
      service.publishCapabilityManifest(identity, {
        publicationKey: "p-duplicate",
        entries: [submissionEntry("tool", "project.status"), submissionEntry("tool", "project.status")],
      }),
    ).rejects.toThrow(/duplicate entry/);

    await expect(
      service.publishCapabilityManifest(identity, { publicationKey: "p-empty", entries: [] }),
    ).rejects.toThrow(/between 1 and 128/);

    // Every failure above happened before the first durable publisher write.
    expect(storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")).toBeUndefined();
    expect(storage.mesh.listLeases(10)).toEqual([]);
  });

  it("keeps one publisher generation across publishes and supersedes manifests within it", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);
    const identity = await authenticate(service, "join-node-a", "sha256:node-a");

    const first = await service.publishCapabilityManifest(identity, {
      publicationKey: "publication-1",
      entries: [submissionEntry("tool", "project.status")],
    });
    const second = await service.publishCapabilityManifest(identity, {
      publicationKey: "publication-2",
      supersedesManifestSha256: first.manifest.manifestSha256,
      entries: [submissionEntry("tool", "project.status"), submissionEntry("skill", "project.guide")],
    });
    expect(second.manifest.publisherGeneration).toBe(1);
    expect(second.manifest.supersedesManifestSha256).toBe(first.manifest.manifestSha256);

    const inspection = await service.listPublicationInspection("default");
    const firstView = inspection.manifests.find((view) => view.manifestSha256 === first.manifest.manifestSha256);
    const secondView = inspection.manifests.find((view) => view.manifestSha256 === second.manifest.manifestSha256);
    expect(firstView?.supersededByManifestSha256).toBe(second.manifest.manifestSha256);
    expect(firstView?.entries.map((entry) => entry.status)).toEqual(["superseded"]);
    expect(firstView?.entries[0]?.reasons).toContain("manifest_superseded");
    expect(secondView?.entries.map((entry) => entry.status)).toEqual(["review_required", "review_required"]);
  });

  it("registers a new publisher generation after terminal health instead of resuming the old one", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);
    const identity = await authenticate(service, "join-node-a", "sha256:node-a");

    const first = await service.publishCapabilityManifest(identity, {
      publicationKey: "publication-1",
      entries: [submissionEntry("tool", "project.status")],
    });
    const publisher = storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: publisher.tlsFingerprint,
    });

    const reconnected = await service.publishCapabilityManifest(identity, {
      publicationKey: "publication-reconnected",
      entries: [submissionEntry("tool", "project.status")],
    });
    expect(reconnected.manifest.publisherGeneration).toBe(2);

    const inspection = await service.listPublicationInspection("default");
    const oldView = inspection.manifests.find((view) => view.manifestSha256 === first.manifest.manifestSha256);
    expect(oldView?.entries[0]?.status).toBe("superseded");
    expect(oldView?.entries[0]?.reasons).toContain("publisher_generation_superseded");
    const newView = inspection.manifests.find((view) => view.manifestSha256 === reconnected.manifest.manifestSha256);
    expect(newView?.entries[0]?.status).toBe("review_required");
  });

  it("rejects publication while another holder owns the publication lease", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);
    const identity = await authenticate(service, "join-node-a", "sha256:node-a");
    storage.mesh.acquireLease("mesh-capability-publication:default:node-a", "node-other", 3_600);

    await expect(
      service.publishCapabilityManifest(identity, {
        publicationKey: "publication-1",
        entries: [submissionEntry("tool", "project.status")],
      }),
    ).rejects.toThrow(/currently held/);
  });
});

describe("MeshCapabilityPublicationService projections", () => {
  it("projects offline statuses for node disconnect and lease expiry, and revoked for admission revocation", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);
    const identity = await authenticate(service, "join-node-a", "sha256:node-a");
    await service.publishCapabilityManifest(identity, {
      publicationKey: "publication-1",
      entries: [submissionEntry("tool", "project.status")],
    });

    const node = storage.mesh.getNode("node-a");
    storage.mesh.upsertNode({ ...node, status: "offline" });
    let entry = (await service.listPublicationInspection("default")).manifests[0]!.entries[0]!;
    expect(entry.status).toBe("offline");
    expect(entry.reasons).toContain("node_disconnected");
    storage.mesh.upsertNode(node);

    storage.db
      .prepare("UPDATE mesh_leases SET expires_at = ? WHERE lease_key = ?")
      .run("2000-01-01T00:00:00.000Z", "mesh-capability-publication:default:node-a");
    entry = (await service.listPublicationInspection("default")).manifests[0]!.entries[0]!;
    expect(entry.status).toBe("offline");
    expect(entry.reasons).toContain("publication_lease_expired");

    const publisher = storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: publisher.tlsFingerprint,
    });
    entry = (await service.listPublicationInspection("default")).manifests[0]!.entries[0]!;
    expect(entry.status).toBe("offline");
    expect(entry.reasons).toContain("publisher_health_offline");

    storage.meshCapabilityNodeAdmissions.revoke({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      reason: "Operator revoked the admitted node.",
      revokedByActorId: "operator-a",
      idempotencyKey: "revoke:node-a:1",
    });
    entry = (await service.listPublicationInspection("default")).manifests[0]!.entries[0]!;
    expect(entry.status).toBe("revoked");
    expect(entry.reasons).toContain("node_admission_revoked");
  });

  it("keeps workspaces isolated even when publication keys and derived IDs collide", async () => {
    const storage = createStorage();
    const beta = storage.workspaces.create({ name: "Beta", slug: "beta-workspace" });
    admitNode(storage, { nodeId: "node-a", token: "join-default" });
    admitNode(storage, { workspaceId: beta.workspaceId, nodeId: "node-a", token: "join-beta" });
    const service = createService(storage);

    const defaultIdentity = await authenticate(service, "join-default", "sha256:node-a");
    const betaIdentity = await authenticate(service, "join-beta", "sha256:node-a");
    expect(betaIdentity.workspaceId).toBe(beta.workspaceId);

    const submission = {
      publicationKey: "publication-shared-key",
      entries: [submissionEntry("tool", "project.status")],
    };
    const defaultReceipt = await service.publishCapabilityManifest(defaultIdentity, submission);
    const betaReceipt = await service.publishCapabilityManifest(betaIdentity, submission);
    expect(defaultReceipt.replayed).toBe(false);
    expect(betaReceipt.replayed).toBe(false);
    expect(betaReceipt.manifest.workspaceId).toBe(beta.workspaceId);
    expect(betaReceipt.manifest.entries[0]?.capabilityId).toBe(defaultReceipt.manifest.entries[0]?.capabilityId);

    const defaultInspection = await service.listPublicationInspection("default");
    const betaInspection = await service.listPublicationInspection(beta.workspaceId);
    expect(defaultInspection.manifests.map((view) => view.manifestSha256)).toEqual([
      defaultReceipt.manifest.manifestSha256,
    ]);
    expect(betaInspection.manifests.map((view) => view.manifestSha256)).toEqual([betaReceipt.manifest.manifestSha256]);
    expect((await service.listOwnPublications(defaultIdentity)).manifests).toHaveLength(1);
    expect(await service.listCatalogEntries("default")).toHaveLength(1);
    expect(await service.listCatalogEntries(beta.workspaceId)).toHaveLength(1);
  });

  it("lists the node's own publications only", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    admitNode(storage, { nodeId: "node-b", token: "join-node-b" });
    const service = createService(storage);
    const identityA = await authenticate(service, "join-node-a", "sha256:node-a");
    const identityB = await authenticate(service, "join-node-b", "sha256:node-b");
    await service.publishCapabilityManifest(identityA, {
      publicationKey: "publication-a",
      entries: [submissionEntry("tool", "project.status")],
    });
    await service.publishCapabilityManifest(identityB, {
      publicationKey: "publication-b",
      entries: [submissionEntry("tool", "project.status")],
    });

    const own = await service.listOwnPublications(identityA);
    expect(own.manifests).toHaveLength(1);
    expect(own.manifests[0]?.publicationKey).toBe("publication-a");
    expect(own.manifests[0]?.entries[0]?.nodeId).toBe("node-a");
  });

  it("projects an empty callable catalog without activations and never marks skills callable", async () => {
    const storage = createStorage();
    admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
    const service = createService(storage);
    const identity = await authenticate(service, "join-node-a", "sha256:node-a");
    const receipt = await service.publishCapabilityManifest(identity, {
      publicationKey: "publication-1",
      entries: [
        submissionEntry("skill", "project.guide"),
        submissionEntry("tool", "project.status"),
        submissionEntry("mcp_server", "project.files"),
      ],
    });

    const catalog = await service.listCatalogEntries("default");
    expect(catalog).toHaveLength(3);
    expect(catalog.every((entry) => entry.callable === false)).toBe(true);
    expect(catalog.every((entry) => entry.category === "mesh_published")).toBe(true);
    expect(new Set(catalog.map((entry) => entry.kind))).toEqual(
      new Set(["mesh_tool", "mesh_mcp_server", "mesh_skill"]),
    );
    expect(catalog.map((entry) => entry.mesh?.status)).toEqual([
      "review_required",
      "review_required",
      "review_required",
    ]);

    // A real governed activation (storage-approved) makes exactly that tool
    // entry project as callable while the skill stays review-only.
    const tool = receipt.manifest.entries.find((entry) => entry.kind === "tool")!;
    const activation: ActivateMeshCapabilityInput = {
      workspaceId: "default",
      activationId: "activation-tool",
      activationRevision: 1,
      capabilityId: tool.capabilityId,
      nodeId: "node-a",
      publisherGeneration: receipt.manifest.publisherGeneration,
      healthGeneration: 1,
      publicationLeaseFencingToken: receipt.manifest.publicationLeaseFencingToken,
      manifestSha256: receipt.manifest.manifestSha256,
      entrySha256: tool.entrySha256,
      descriptorSha256: tool.descriptorSha256,
      permissionEnvelopeSha256: tool.permissionEnvelopeSha256,
      effectPosture: tool.descriptor.effectPosture,
      permissionDiff: {
        schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
        disposition: "initial",
        currentPermissionEnvelopeSha256: tool.permissionEnvelopeSha256,
        added: [],
        removed: [],
      },
      effectDiff: {
        schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
        disposition: "initial",
        currentEffectPosture: tool.descriptor.effectPosture,
      },
      approvalId: "approval-activation-tool",
      actorId: "operator-a",
      sessionId: "session-a",
      turnId: "turn-a",
      idempotencyKey: "activate-tool",
    };
    approveActivation(storage, activation);
    storage.meshCapabilityPublications.activate(activation);

    const activatedCatalog = await service.listCatalogEntries("default");
    const activatedTool = activatedCatalog.find((entry) => entry.kind === "mesh_tool");
    const skillEntry = activatedCatalog.find((entry) => entry.kind === "mesh_skill");
    expect(activatedTool?.callable).toBe(true);
    expect(activatedTool?.mesh?.status).toBe("active");
    expect(skillEntry?.callable).toBe(false);
    expect(skillEntry?.mesh?.status).toBe("review_required");
  });
});

describe("mesh publication helpers", () => {
  it("classifies node-publication paths exactly", () => {
    expect(isMeshCapabilityNodePublicationPath("/api/v1/mesh/capabilities/manifests")).toBe(true);
    expect(isMeshCapabilityNodePublicationPath("/api/v1/mesh/capabilities/manifests?x=1")).toBe(true);
    expect(isMeshCapabilityNodePublicationPath("/api/v1/mesh/capabilities/manifests/self")).toBe(true);
    expect(isMeshCapabilityNodePublicationPath("/api/v1/mesh/capabilities/publications")).toBe(false);
    expect(isMeshCapabilityNodePublicationPath("/api/v1/mesh/join")).toBe(false);
  });

  it("maps service failures onto the route contract", () => {
    expect(toMeshCapabilityPublicationHttpError(new TypeError("Mesh capability manifest is invalid."))).toEqual({
      statusCode: 400,
      body: { error: "Mesh capability manifest is invalid." },
    });
    expect(toMeshCapabilityPublicationHttpError(new Error("boom"))).toBeUndefined();
  });
});

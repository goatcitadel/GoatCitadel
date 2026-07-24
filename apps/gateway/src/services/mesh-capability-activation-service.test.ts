import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  type MeshCapabilityEffectPosture,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
} from "@goatcitadel/contracts";
import {
  Storage,
  buildMeshCapabilityActivationDiffs,
  computeMeshCapabilityDescriptorSha256,
} from "@goatcitadel/storage";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";
import { createMeshCapabilityActivationApproval } from "./mesh-capability-activation-approval-service.js";
import {
  MeshCapabilityActivationService,
  MeshCapabilityActivationServiceError,
  activationRequestJourneyIdempotencyKey,
  deriveMeshCapabilityActivationId,
} from "./mesh-capability-activation-service.js";
import {
  MeshCapabilityPublicationService,
  type MeshCapabilityAuthenticatedNodeIdentity,
} from "./mesh-capability-publication-service.js";
import type { ServiceContext } from "./service-context.js";

const storages: Storage[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const storage of storages.splice(0)) storage.close();
});

function createHarness(): {
  storage: Storage;
  publication: MeshCapabilityPublicationService;
  service: MeshCapabilityActivationService;
  identity: MeshCapabilityAuthenticatedNodeIdentity;
} {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  storages.push(storage);
  admitNode(storage, { nodeId: "node-a", token: "join-node-a" });
  const publication = new MeshCapabilityPublicationService({ storage });
  const service = new MeshCapabilityActivationService({ storage, publication });
  const auth = publication.authenticateNodeRequest({
    headers: {
      authorization: "Bearer join-node-a",
      "x-goatcitadel-mesh-tls-fingerprint": "sha256:node-a",
    },
  });
  expect(auth).toHaveProperty("identity");
  const identity = (auth as { identity: MeshCapabilityAuthenticatedNodeIdentity }).identity;
  return { storage, publication, service, identity };
}

function admitNode(storage: Storage, input: { nodeId: string; token: string; workspaceId?: string }): void {
  const workspaceId = input.workspaceId ?? "default";
  const now = new Date().toISOString();
  storage.mesh.upsertNode({
    nodeId: input.nodeId,
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint: `sha256:${input.nodeId}`,
    joinedAt: now,
    lastSeenAt: now,
  });
  storage.mesh.issueJoinToken(input.token, "2099-01-01T00:00:00.000Z");
  expect(storage.mesh.consumeJoinToken(input.token, input.nodeId, now)).toBe(true);
  storage.meshCapabilityNodeAdmissions.admit({
    workspaceId,
    nodeId: input.nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256: createHash("sha256").update(input.token).digest("hex"),
    mtlsRequired: true,
    tlsFingerprint: `sha256:${input.nodeId}`,
    admittedByActorId: "operator-a",
    idempotencyKey: `admit:${workspaceId}:${input.nodeId}:${input.token}`,
  });
}

function descriptorOf(
  kind: "tool" | "mcp_server" | "skill",
  options: { effectPosture?: MeshCapabilityEffectPosture; networkOrigins?: string[] } = {},
): Record<string, unknown> {
  const base = {
    title: "Project status",
    semanticVersion: "1.0.0",
    effectPosture: options.effectPosture ?? ("read_only" as const),
    permissions: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
      filesystemRead: ["workspace://project"],
      filesystemWrite: [],
      networkOrigins: options.networkOrigins ?? [],
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

function publish(
  harness: ReturnType<typeof createHarness>,
  options: {
    publicationKey?: string;
    entries?: Array<{ kind: "tool" | "mcp_server" | "skill"; localId: string; descriptor?: Record<string, unknown> }>;
    supersedesManifestSha256?: string;
  } = {},
): MeshCapabilityManifest {
  const entries = options.entries ?? [
    { kind: "tool" as const, localId: "project.status" },
    { kind: "mcp_server" as const, localId: "project.files" },
    { kind: "skill" as const, localId: "project.guide" },
  ];
  const receipt = harness.publication.publishCapabilityManifest(harness.identity, {
    publicationKey: options.publicationKey ?? "publication-1",
    ...(options.supersedesManifestSha256 === undefined
      ? {}
      : { supersedesManifestSha256: options.supersedesManifestSha256 }),
    entries: entries.map((entry) => {
      const descriptor = entry.descriptor ?? descriptorOf(entry.kind);
      return {
        localId: entry.localId,
        kind: entry.kind,
        descriptor,
        descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor),
      };
    }),
  });
  return receipt.manifest;
}

function entryOf(manifest: MeshCapabilityManifest, kind: "tool" | "mcp_server" | "skill"): MeshCapabilityManifestEntry {
  const entry = manifest.entries.find((candidate) => candidate.kind === kind);
  expect(entry).toBeDefined();
  return entry!;
}

function requestFor(
  manifest: MeshCapabilityManifest,
  entry: MeshCapabilityManifestEntry,
  overrides: Partial<Parameters<MeshCapabilityActivationService["requestActivation"]>[0]> = {},
) {
  return {
    workspaceId: "default",
    capabilityId: entry.capabilityId,
    manifestSha256: manifest.manifestSha256,
    entrySha256: entry.entrySha256,
    actorId: "operator-a",
    sessionId: "session-a",
    turnId: "turn-a",
    ...overrides,
  };
}

function approve(storage: Storage, approvalId: string, resolvedBy = "operator-approver"): void {
  storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy });
}

describe("MeshCapabilityActivationService request + approve + activate", () => {
  it("activates one exact tool entry through a real deterministic approval and replays idempotently", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");

    const first = harness.service.requestActivation(requestFor(manifest, tool));
    expect(first.replayed).toBe(false);
    expect(first.activationRevision).toBe(1);
    expect(first.approval.kind).toBe(MESH_CAPABILITY_ACTIVATION_APPROVAL_KIND);
    expect(first.approval.riskLevel).toBe("danger");
    expect(first.approval.status).toBe("pending");
    expect(first.approval.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(first.approval.linkage).toEqual({ workspaceId: "default", sessionId: "session-a", turnId: "turn-a" });
    expect(first.permissionDiff.disposition).toBe("initial");
    expect(first.effectDiff).toMatchObject({ disposition: "initial", currentEffectPosture: "read_only" });
    // Request Journey evidence commits atomically with the approval.
    const evidence = harness.storage.governanceJourneyEvents.findByIdempotencyKey(
      activationRequestJourneyIdempotencyKey(first.approval.approvalId),
    );
    expect(evidence).toMatchObject({
      actorId: "operator-a",
      approvalId: first.approval.approvalId,
      action: "activation_requested",
      subjectId: first.activationId,
    });

    // Determinism: the same exact request converges on the same approval.
    const replay = harness.service.requestActivation(requestFor(manifest, tool));
    expect(replay.replayed).toBe(true);
    expect(replay.approval.approvalId).toBe(first.approval.approvalId);
    expect(replay.activationId).toBe(first.activationId);
    // A different requester derives a different deterministic identity.
    const otherActor = harness.service.requestActivation(requestFor(manifest, tool, { actorId: "operator-b" }));
    expect(otherActor.approval.approvalId).not.toBe(first.approval.approvalId);

    // Not yet approved: the apply fails closed and nothing becomes callable.
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: first.approval.approvalId }),
    ).toThrow(MeshCapabilityActivationServiceError);
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);

    approve(harness.storage, first.approval.approvalId);
    const applied = harness.service.executeApprovedActivation({
      workspaceId: "default",
      approvalId: first.approval.approvalId,
    });
    expect(applied.replayed).toBe(false);
    expect(applied.activation).toMatchObject({
      activationId: first.activationId,
      activationRevision: 1,
      capabilityId: tool.capabilityId,
      approvalId: first.approval.approvalId,
      actorId: "operator-a",
      effectPosture: "read_only",
    });
    expect(
      harness.storage.meshCapabilityPublications.listCallableActivations("default").map((row) => row.activationId),
    ).toEqual([first.activationId]);
    const catalogTool = harness.publication
      .listCatalogEntries("default")
      .find((candidate) => candidate.kind === "mesh_tool");
    expect(catalogTool?.callable).toBe(true);
    expect(catalogTool?.mesh?.status).toBe("active");
    expect(catalogTool?.mesh?.activation).toMatchObject({
      activationId: first.activationId,
      activationRevision: 1,
      approvalId: first.approval.approvalId,
      revoked: false,
    });

    // Replayed apply converges without a second activation row.
    const reapplied = harness.service.executeApprovedActivation({
      workspaceId: "default",
      approvalId: first.approval.approvalId,
    });
    expect(reapplied.replayed).toBe(true);
    expect(reapplied.activation.activationId).toBe(first.activationId);
  });

  it("activates an exact mcp_server entry and preserves an unknown effect posture end to end", () => {
    const harness = createHarness();
    const manifest = publish(harness, {
      entries: [
        { kind: "mcp_server", localId: "project.files" },
        { kind: "tool", localId: "project.mutate", descriptor: descriptorOf("tool", { effectPosture: "unknown" }) },
      ],
    });
    const mcp = entryOf(manifest, "mcp_server");
    const unknownTool = entryOf(manifest, "tool");

    const mcpRequest = harness.service.requestActivation(requestFor(manifest, mcp));
    approve(harness.storage, mcpRequest.approval.approvalId);
    const mcpApplied = harness.service.executeApprovedActivation({
      workspaceId: "default",
      approvalId: mcpRequest.approval.approvalId,
    });
    expect(mcpApplied.activation.capabilityId).toBe(mcp.capabilityId);

    const unknownRequest = harness.service.requestActivation(requestFor(manifest, unknownTool));
    expect(unknownRequest.effectDiff.currentEffectPosture).toBe("unknown");
    approve(harness.storage, unknownRequest.approval.approvalId);
    const unknownApplied = harness.service.executeApprovedActivation({
      workspaceId: "default",
      approvalId: unknownRequest.approval.approvalId,
    });
    // Unknown is preserved as unknown — never upgraded to none.
    expect(unknownApplied.activation.effectPosture).toBe("unknown");
    expect(unknownApplied.activation.effectDiff.currentEffectPosture).toBe("unknown");
    const binding = harness.service.resolveProfileBinding({
      workspaceId: "default",
      capabilityId: unknownTool.capabilityId,
      entrySha256: unknownTool.entrySha256,
      manifestSha256: manifest.manifestSha256,
      publisherGeneration: manifest.publisherGeneration,
    });
    expect(binding?.effectPosture).toBe("unknown");
  });

  it("defers genuine storage infrastructure errors for retry while keeping guard conflicts terminal", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const requested = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, requested.approval.approvalId);

    // Genuine infrastructure failure (SQLITE_BUSY / serialization): the raw
    // error must propagate so the approval-effect worker defers the effect
    // for bounded retry instead of failing it terminally.
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const activateSpy = vi.spyOn(harness.storage.meshCapabilityPublications, "activate").mockImplementation(() => {
      throw busy;
    });
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: requested.approval.approvalId }),
    ).toThrow(busy);
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: requested.approval.approvalId }),
    ).not.toThrow(MeshCapabilityActivationServiceError);

    // Storage guard/constraint violations stay terminal governance conflicts.
    activateSpy.mockImplementation(() => {
      throw new ConflictError("Mesh capability activation conflicts with a storage invariant.");
    });
    try {
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: requested.approval.approvalId });
      expect.unreachable("guard conflicts must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(MeshCapabilityActivationServiceError);
      expect((error as MeshCapabilityActivationServiceError).code).toBe("mesh_capability_activation_conflict");
    }

    // After the transient failure clears, the retry converges normally.
    activateSpy.mockRestore();
    const applied = harness.service.executeApprovedActivation({
      workspaceId: "default",
      approvalId: requested.approval.approvalId,
    });
    expect(applied.activation.capabilityId).toBe(tool.capabilityId);
  });

  it("fails skill activation closed as deferred staging without writing any approval", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const skill = entryOf(manifest, "skill");

    expect(() => harness.service.requestActivation(requestFor(manifest, skill))).toThrow(
      /mesh_capability_skill_staging_deferred/u,
    );
    expect(harness.storage.approvals.list(undefined, 10)).toHaveLength(0);
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
  });

  it("rejects cross-workspace requests, unknown manifests, and stale entry bindings", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");

    expect(() => harness.service.requestActivation(requestFor(manifest, tool, { workspaceId: "workspace-b" }))).toThrow(
      /mesh_capability_manifest_not_found/u,
    );
    expect(() =>
      harness.service.requestActivation(requestFor(manifest, tool, { manifestSha256: "9".repeat(64) })),
    ).toThrow(/mesh_capability_manifest_not_found/u);
    expect(() =>
      harness.service.requestActivation(requestFor(manifest, tool, { entrySha256: "8".repeat(64) })),
    ).toThrow(/mesh_capability_entry_binding_mismatch/u);
    expect(() =>
      harness.service.requestActivation(
        requestFor(manifest, tool, { capabilityId: entryOf(manifest, "mcp_server").capabilityId }),
      ),
    ).toThrow(/mesh_capability_entry_binding_mismatch/u);
  });

  it("requires a healthy publisher at request time", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const publisher = harness.storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    harness.storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "suspect",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });

    expect(() => harness.service.requestActivation(requestFor(manifest, tool))).toThrow(
      /mesh_capability_publisher_not_activatable/u,
    );
  });

  it("fails closed on missing, foreign, pending, workspace-mismatched, and expired approvals", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));

    expect(() =>
      harness.service.executeApprovedActivation({
        workspaceId: "default",
        approvalId: "00000000-0000-0000-0000-000000000000",
      }),
    ).toThrow(/mesh_capability_approval_not_executable/u);
    // Pending approval is not executable.
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId }),
    ).toThrow(/mesh_capability_approval_not_executable/u);
    // Foreign kind under a workspace linkage is not executable.
    const foreign = harness.storage.approvals.createDeterministicDetachedWithTtlDuration(
      {
        approvalId: "11111111-1111-4111-8111-111111111111",
        kind: "foreign.approval",
        riskLevel: "danger",
        payload: { foreign: true },
        preview: {},
        linkage: { workspaceId: "default" },
      },
      15 * 60_000,
    );
    approve(harness.storage, foreign.approval.approvalId);
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: foreign.approval.approvalId }),
    ).toThrow(/mesh_capability_approval_not_executable/u);

    approve(harness.storage, request.approval.approvalId);
    // Cross-workspace execution is rejected even with the right approval.
    expect(() =>
      harness.service.executeApprovedActivation({
        workspaceId: "workspace-b",
        approvalId: request.approval.approvalId,
      }),
    ).toThrow(/mesh_capability_approval_not_executable/u);

    // A stale (expired) approval fails closed before any rebuild.
    const staleClock = new MeshCapabilityActivationService({
      storage: harness.storage,
      publication: harness.publication,
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    expect(() =>
      staleClock.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId }),
    ).toThrow(/mesh_capability_approval_expired/u);
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
  });

  it("fails closed when the requester Journey evidence is missing", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    // Bypass the request owner: commit an otherwise-valid approval WITHOUT the
    // atomically-committed request Journey evidence the apply must recover.
    const health = harness.storage.meshCapabilityPublications.getPublisherHealth("default", "node-a", 1);
    const diffs = buildMeshCapabilityActivationDiffs({ currentEntry: tool });
    const activationId = deriveMeshCapabilityActivationId({
      workspaceId: "default",
      capabilityId: tool.capabilityId,
      activationRevision: 1,
      nodeId: "node-a",
      publisherGeneration: manifest.publisherGeneration,
      healthGeneration: health.healthGeneration,
      publicationLeaseFencingToken: health.publicationLeaseFencingToken,
      manifestSha256: manifest.manifestSha256,
      entrySha256: tool.entrySha256,
      actorId: "operator-ghost",
      sessionId: "session-a",
      turnId: "turn-a",
    });
    const bare = createMeshCapabilityActivationApproval(
      { storage: harness.storage },
      {
        workspaceId: "default",
        activationId,
        activationRevision: 1,
        capabilityId: tool.capabilityId,
        nodeId: "node-a",
        publisherGeneration: manifest.publisherGeneration,
        healthGeneration: health.healthGeneration,
        publicationLeaseFencingToken: health.publicationLeaseFencingToken,
        manifestSha256: manifest.manifestSha256,
        entrySha256: tool.entrySha256,
        descriptorSha256: tool.descriptorSha256,
        permissionEnvelopeSha256: tool.permissionEnvelopeSha256,
        effectPosture: tool.descriptor.effectPosture,
        permissionDiff: diffs.permissionDiff,
        effectDiff: diffs.effectDiff,
        actorId: "operator-ghost",
        sessionId: "session-a",
        turnId: "turn-a",
        idempotencyKey: `mesh-capability-activation:${activationId}`,
      },
    );
    expect(
      harness.storage.governanceJourneyEvents.findByIdempotencyKey(
        activationRequestJourneyIdempotencyKey(bare.approval.approvalId),
      ),
    ).toBeUndefined();
    approve(harness.storage, bare.approval.approvalId);
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: bare.approval.approvalId }),
    ).toThrow(/mesh_capability_request_evidence_missing/u);
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
  });

  it("fails closed on permission drift (manifest supersession) between request and approve", () => {
    const harness = createHarness();
    const manifest = publish(harness, {
      entries: [{ kind: "tool", localId: "project.status" }],
    });
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, request.approval.approvalId);

    // The node publishes a superseding manifest whose tool wants MORE permissions.
    publish(harness, {
      publicationKey: "publication-2",
      supersedesManifestSha256: manifest.manifestSha256,
      entries: [
        {
          kind: "tool",
          localId: "project.status",
          descriptor: descriptorOf("tool", { networkOrigins: ["https://drifted.example"] }),
        },
      ],
    });

    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId }),
    ).toThrow(MeshCapabilityActivationServiceError);
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
  });

  it("fails closed on publisher health drift between request and approve", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, request.approval.approvalId);
    const publisher = harness.storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    harness.storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "suspect",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });

    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId }),
    ).toThrow(/mesh_capability_activation_state_drift/u);

    // Recovering to online bumps the health generation: the approved bytes
    // still bind the request-time generation, so the apply stays closed.
    harness.storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 2,
      status: "online",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId }),
    ).toThrow(/mesh_capability_activation_state_drift/u);
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
  });

  it("fails closed on an expired publication lease between request and approve", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, request.approval.approvalId);
    const publisher = harness.storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    harness.storage.db
      .prepare("UPDATE mesh_leases SET expires_at = ? WHERE lease_key = ?")
      .run("2000-01-01T00:00:00.000Z", publisher.publicationLeaseKey);

    // The storage activation guard rejects the insert on its own DB clock.
    expect(() =>
      harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId }),
    ).toThrow(MeshCapabilityActivationServiceError);
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
  });
});

describe("MeshCapabilityActivationService revoke + projection", () => {
  it("revoke removes callability immediately, flips the projection, and replays terminally", () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, request.approval.approvalId);
    harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId });
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(1);

    const revoked = harness.service.revokeActivation({
      workspaceId: "default",
      activationId: request.activationId,
      reason: "Operator revoked the grant.",
      actorId: "operator-a",
    });
    expect(revoked.replayed).toBe(false);
    // Callability is gone before the next read.
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
    const catalogTool = harness.publication
      .listCatalogEntries("default")
      .find((candidate) => candidate.kind === "mesh_tool");
    expect(catalogTool?.callable).toBe(false);
    expect(catalogTool?.mesh?.status).toBe("review_required");
    expect(catalogTool?.mesh?.reasons).toContain("activation_revoked");
    expect(catalogTool?.mesh?.activation).toMatchObject({ activationId: request.activationId, revoked: true });

    const replay = harness.service.revokeActivation({
      workspaceId: "default",
      activationId: request.activationId,
      reason: "Different reason converges on the immutable revocation.",
      actorId: "operator-b",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.revocation.reason).toBe("Operator revoked the grant.");

    expect(() =>
      harness.service.revokeActivation({
        workspaceId: "default",
        activationId: "missing-activation",
        reason: "No such activation.",
        actorId: "operator-a",
      }),
    ).toThrow(/mesh_capability_activation_not_found/u);
    expect(() =>
      harness.service.revokeActivation({
        workspaceId: "workspace-b",
        activationId: request.activationId,
        reason: "Cross-workspace revoke.",
        actorId: "operator-a",
      }),
    ).toThrow(/mesh_capability_activation_not_found/u);
  });
});

describe("MeshCapabilityActivationService freeze binding + pre-dispatch gate", () => {
  function activateTool(harness: ReturnType<typeof createHarness>) {
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, request.approval.approvalId);
    harness.service.executeApprovedActivation({ workspaceId: "default", approvalId: request.approval.approvalId });
    return { manifest, tool, request };
  }

  it("resolves the packet's exact snapshot fields for a callable entry and blocks on every drift class", () => {
    const harness = createHarness();
    const { manifest, tool, request } = activateTool(harness);
    const bindingInput = {
      workspaceId: "default",
      capabilityId: tool.capabilityId,
      entrySha256: tool.entrySha256,
      manifestSha256: manifest.manifestSha256,
      publisherGeneration: manifest.publisherGeneration,
    };
    const binding = harness.service.resolveProfileBinding(bindingInput);
    expect(binding).toEqual({
      nodeId: "node-a",
      publisherGeneration: 1,
      manifestSha256: manifest.manifestSha256,
      entrySha256: tool.entrySha256,
      activationId: request.activationId,
      activationRevision: 1,
      publicationLeaseFencingToken: 1,
      permissionEnvelopeSha256: tool.permissionEnvelopeSha256,
      effectPosture: "read_only",
      healthGeneration: 1,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    // Wrong exact identity never resolves a binding.
    expect(harness.service.resolveProfileBinding({ ...bindingInput, entrySha256: "9".repeat(64) })).toBeUndefined();
    expect(harness.service.resolveProfileBinding({ ...bindingInput, workspaceId: "workspace-b" })).toBeUndefined();

    // Valid binding: the M2 pre-dispatch terminal is the M3-pending rejection.
    expect(harness.service.resolvePreDispatchBlock("default", binding!)).toBe("mesh_capability_dispatch_unready");

    // Node disconnect removes callability: freeze and dispatch both block.
    const node = harness.storage.mesh.getNode("node-a");
    harness.storage.mesh.upsertNode({ ...node, status: "offline" });
    expect(harness.service.resolveProfileBinding(bindingInput)).toBeUndefined();
    expect(harness.service.resolvePreDispatchBlock("default", binding!)).toBe("mesh_capability_binding_drift");
    harness.storage.mesh.upsertNode(node);
    expect(harness.service.resolvePreDispatchBlock("default", binding!)).toBe("mesh_capability_dispatch_unready");

    // Publisher health offline removes callability.
    const publisher = harness.storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    harness.storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });
    expect(harness.service.resolveProfileBinding(bindingInput)).toBeUndefined();
    expect(harness.service.resolvePreDispatchBlock("default", binding!)).toBe("mesh_capability_binding_drift");
  });

  it("blocks on lease expiry, manifest supersession, revoke, and reconnect-new-generation", () => {
    const harness = createHarness();
    const { manifest, tool, request } = activateTool(harness);
    const bindingInput = {
      workspaceId: "default",
      capabilityId: tool.capabilityId,
      entrySha256: tool.entrySha256,
      manifestSha256: manifest.manifestSha256,
      publisherGeneration: manifest.publisherGeneration,
    };
    const binding = harness.service.resolveProfileBinding(bindingInput)!;
    const publisher = harness.storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;

    // Lease expiry (database clock) removes callability.
    harness.storage.db
      .prepare("UPDATE mesh_leases SET expires_at = ? WHERE lease_key = ?")
      .run("2000-01-01T00:00:00.000Z", publisher.publicationLeaseKey);
    expect(harness.service.resolveProfileBinding(bindingInput)).toBeUndefined();
    expect(harness.service.resolvePreDispatchBlock("default", binding)).toBe("mesh_capability_binding_drift");
    harness.storage.mesh.acquireLease(publisher.publicationLeaseKey, "node-a", 3_600, new Date().toISOString());
    expect(harness.service.resolvePreDispatchBlock("default", binding)).toBe("mesh_capability_dispatch_unready");

    // Manifest supersession removes callability for the superseded entry.
    publish(harness, {
      publicationKey: "publication-2",
      supersedesManifestSha256: manifest.manifestSha256,
      entries: [{ kind: "tool", localId: "project.status" }],
    });
    expect(harness.service.resolveProfileBinding(bindingInput)).toBeUndefined();
    expect(harness.service.resolvePreDispatchBlock("default", binding)).toBe("mesh_capability_binding_drift");

    // Revoke stays terminal regardless of later state.
    harness.service.revokeActivation({
      workspaceId: "default",
      activationId: request.activationId,
      reason: "Terminal revoke.",
      actorId: "operator-a",
    });
    expect(harness.service.resolveProfileBinding(bindingInput)).toBeUndefined();
    expect(harness.service.resolvePreDispatchBlock("default", binding)).toBe("mesh_capability_binding_drift");
  });

  it("never resumes callability for a prior generation after reconnect", () => {
    const harness = createHarness();
    const { manifest, tool } = activateTool(harness);
    const bindingInput = {
      workspaceId: "default",
      capabilityId: tool.capabilityId,
      entrySha256: tool.entrySha256,
      manifestSha256: manifest.manifestSha256,
      publisherGeneration: manifest.publisherGeneration,
    };
    const binding = harness.service.resolveProfileBinding(bindingInput)!;
    const publisher = harness.storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    // Terminal health forces the next publish onto generation 2.
    harness.storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });
    const reconnected = publish(harness, { publicationKey: "publication-reconnected" });
    expect(reconnected.publisherGeneration).toBe(2);

    // The generation-1 activation never revalidates again.
    expect(harness.service.resolveProfileBinding(bindingInput)).toBeUndefined();
    expect(harness.service.resolvePreDispatchBlock("default", binding)).toBe("mesh_capability_binding_drift");
    // The new generation's entry requires its own governed review.
    const reconnectedTool = entryOf(reconnected, "tool");
    expect(
      harness.service.resolveProfileBinding({
        workspaceId: "default",
        capabilityId: reconnectedTool.capabilityId,
        entrySha256: reconnectedTool.entrySha256,
        manifestSha256: reconnected.manifestSha256,
        publisherGeneration: 2,
      }),
    ).toBeUndefined();
  });
});

describe("mesh activation approval resolution effect", () => {
  it("enqueues one deterministic apply effect on approve and executes it through the composed owner", async () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, request.approval.approvalId);
    const approvedApproval = harness.storage.approvals.get(request.approval.approvalId);

    const backgroundTasks = new Set<Promise<void>>();
    const effectsService = new ApprovalEffectsService(
      { storage: harness.storage, publishRealtime: vi.fn() } as unknown as ServiceContext,
      {
        backgroundTasks,
        wakeDurableRun: vi.fn(() => ({ outcome: "not_found" }) as never),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "default"),
        executeApprovedMeshCapabilityActivation: (input) => harness.service.executeApprovedActivation(input),
      },
    );

    const enqueued = effectsService.enqueueResolutionEffects(approvedApproval, {
      decision: "approve",
      resolvedBy: "operator-approver",
    });
    const meshEffect = enqueued.find((effect) => effect.effectKind === "mesh_capability_activation_apply");
    expect(meshEffect).toMatchObject({
      targetKind: "mesh_capability_activation",
      targetId: request.activationId,
      payload: {
        workspaceId: "default",
        activationId: request.activationId,
        activationRevision: 1,
      },
    });

    effectsService.requestEffectProcessing();
    await Promise.all([...backgroundTasks]);
    effectsService.stopWorker();

    const settled = harness.storage.approvalEffects.get(meshEffect!.effectId);
    expect(settled.status).toBe("completed");
    expect(settled.result).toMatchObject({
      disposition: "activated",
      activationId: request.activationId,
      replayed: false,
    });
    expect(
      harness.storage.meshCapabilityPublications.listCallableActivations("default").map((row) => row.activationId),
    ).toEqual([request.activationId]);

    // Re-enqueueing the same resolution converges on the same effect row.
    const replayed = effectsService.enqueueResolutionEffects(approvedApproval, {
      decision: "approve",
      resolvedBy: "operator-approver",
    });
    const replayedEffect = replayed.find((effect) => effect.effectKind === "mesh_capability_activation_apply");
    expect(replayedEffect?.effectId).toBe(meshEffect!.effectId);
  });

  it("fails the effect closed with the content-free code when live state drifted after approval", async () => {
    const harness = createHarness();
    const manifest = publish(harness);
    const tool = entryOf(manifest, "tool");
    const request = harness.service.requestActivation(requestFor(manifest, tool));
    approve(harness.storage, request.approval.approvalId);
    const approvedApproval = harness.storage.approvals.get(request.approval.approvalId);
    const publisher = harness.storage.meshCapabilityPublications.findCurrentPublisher("default", "node-a")!;
    harness.storage.meshCapabilityPublications.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: publisher.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "suspect",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });

    const backgroundTasks = new Set<Promise<void>>();
    const effectsService = new ApprovalEffectsService(
      { storage: harness.storage, publishRealtime: vi.fn() } as unknown as ServiceContext,
      {
        backgroundTasks,
        wakeDurableRun: vi.fn(() => ({ outcome: "not_found" }) as never),
        requestRunProcessing: vi.fn(),
        findProactiveDurableRunIdsForApproval: vi.fn(() => []),
        executeCodeModePendingApproval: vi.fn(),
        executeApprovedPendingAction: vi.fn(),
        enqueueAfterHooks: vi.fn(),
        resolveApprovalHookWorkspaceId: vi.fn(() => "default"),
        executeApprovedMeshCapabilityActivation: (input) => harness.service.executeApprovedActivation(input),
      },
    );
    const enqueued = effectsService.enqueueResolutionEffects(approvedApproval, {
      decision: "approve",
      resolvedBy: "operator-approver",
    });
    const meshEffect = enqueued.find((effect) => effect.effectKind === "mesh_capability_activation_apply");

    effectsService.requestEffectProcessing();
    await Promise.all([...backgroundTasks]);
    effectsService.stopWorker();

    const settled = harness.storage.approvalEffects.get(meshEffect!.effectId);
    expect(settled.status).toBe("failed");
    expect(settled.result).toMatchObject({ errorCode: "mesh_capability_activation_state_drift" });
    expect(harness.storage.meshCapabilityPublications.listCallableActivations("default")).toHaveLength(0);
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
  deriveMeshCapabilityId,
  type MeshCapabilityDescriptor,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
  type MeshCapabilityPermissionEnvelope,
} from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import {
  MeshCapabilityPublicationRepository,
  buildMeshCapabilityActivationApprovalPayload,
  buildMeshCapabilityActivationDiffs,
  computeMeshCapabilityActivationRequestSha256,
  computeMeshCapabilityDescriptorSha256,
  computeMeshCapabilityEntrySha256,
  computeMeshCapabilityManifestSha256,
  type ActivateMeshCapabilityInput,
} from "./mesh-capability-publication-repo.js";
import { MeshRepository } from "./mesh-repo.js";
import { createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function createHarness() {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  const mesh = new MeshRepository(db);
  mesh.upsertNode({
    nodeId: "node-a",
    transport: "lan",
    status: "online",
    capabilities: [],
    tlsFingerprint: "sha256:node-a",
    joinedAt: FUTURE,
    lastSeenAt: FUTURE,
  });
  admitNode(db, mesh, "node-a", true, "sha256:node-a");
  const lease = mesh.acquireLease("mesh-capability-publication:default:node-a", "node-a", 3_600, FUTURE);
  const repo = new MeshCapabilityPublicationRepository(db);
  const publisher = repo.registerPublisher({
    workspaceId: "default",
    nodeId: "node-a",
    admissionGeneration: 1,
    publisherGeneration: 1,
    mtlsRequired: true,
    tlsFingerprint: "sha256:node-a",
    publicationLeaseKey: lease.leaseKey,
    publicationLeaseFencingToken: lease.fencingToken,
    publicationLeaseExpiresAt: lease.expiresAt,
    idempotencyKey: "publisher-1",
  });
  return { db, mesh, repo, lease, publisher };
}

function createPostgresFacade(db: DatabaseClient, preparedSql: string[]): DatabaseClient {
  return {
    dialect: "postgres",
    prepare(sql: string): DbStatement {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      preparedSql.push(normalized);
      if (normalized.includes("pg_advisory_xact_lock")) return staticStatement({ locked: null });
      return db.prepare(sql);
    },
    exec: (sql) => db.exec(sql),
    close: () => undefined,
    transaction: (mode, callback) => db.transaction(mode, callback),
  };
}

function staticStatement(row: Record<string, unknown>): DbStatement {
  return {
    run: () => ({ changes: 0 }),
    get: () => row,
    all: () => [row],
  } as unknown as DbStatement;
}

function assertPublisherAdmissionLocksPrecedeReplayRead(preparedSql: string[]): void {
  const workspaceLockIndex = preparedSql.findIndex((sql) => sql.includes("hashtextextended(@workspaceId, 411)"));
  const nodeLockIndex = preparedSql.findIndex((sql) =>
    sql.includes("hashtextextended(@workspaceId || ':' || @nodeId, 412)"),
  );
  const replayReadIndex = preparedSql.findIndex(
    (sql) =>
      sql.startsWith("SELECT *") && sql.includes("FROM mesh_capability_publishers") && sql.includes("idempotency_key"),
  );
  assert.ok(workspaceLockIndex >= 0, "expected the workspace admission advisory lock");
  assert.ok(nodeLockIndex >= 0, "expected the node admission advisory lock");
  assert.ok(replayReadIndex >= 0, "expected the publisher idempotency replay read");
  assert.ok(workspaceLockIndex < nodeLockIndex, "workspace lock 411 must precede node lock 412");
  assert.ok(nodeLockIndex < replayReadIndex, "node admission lock must precede the publisher replay read");
}

function admitNode(
  db: DatabaseClient,
  mesh: MeshRepository,
  nodeId: string,
  mtlsRequired: boolean,
  tlsFingerprint?: string,
): void {
  const rawToken = `join:${nodeId}`;
  mesh.issueJoinToken(rawToken, FUTURE);
  assert.equal(mesh.consumeJoinToken(rawToken, nodeId, "2026-07-14T12:00:00.000Z"), true);
  const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(nodeId, rawToken).tokenHash;
  assert.ok(joinTokenSha256);
  new MeshCapabilityNodeAdmissionRepository(db).admit({
    workspaceId: "default",
    nodeId,
    expectedAdmissionGeneration: 0,
    joinTokenSha256,
    mtlsRequired,
    ...(tlsFingerprint === undefined ? {} : { tlsFingerprint }),
    admittedByActorId: "operator-a",
    idempotencyKey: `admit:${nodeId}`,
  });
}

function permissions(): MeshCapabilityPermissionEnvelope {
  return {
    schemaVersion: MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
    filesystemRead: ["workspace://project"],
    filesystemWrite: [],
    networkOrigins: [],
    environmentNames: [],
    deviceCapabilities: [],
  };
}

function entry(kind: "tool" | "mcp_server" | "skill", localId: string): MeshCapabilityManifestEntry {
  const base = {
    title: kind === "tool" ? "Project status" : "Status review guidance",
    semanticVersion: "1.0.0",
    effectPosture: "read_only" as const,
    permissions: permissions(),
    resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 },
    healthCheck: { protocol: "mesh.capability-health.v1" as const, intervalMs: 30_000, timeoutMs: 5_000 },
  };
  const descriptor: MeshCapabilityDescriptor =
    kind === "tool"
      ? {
          ...base,
          kind,
          inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
          outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
          idempotency: "intrinsic",
        }
      : kind === "mcp_server"
        ? {
            ...base,
            kind,
            protocol: "mcp",
            protocolVersion: "2025-06-18",
            tools: [{ name: "files.read", inputSchemaSha256: "4".repeat(64) }],
          }
        : {
            ...base,
            kind,
            manifestSha256: "1".repeat(64),
            instructionsSha256: "2".repeat(64),
            proofSha256: "3".repeat(64),
          };
  const unsigned = {
    localId,
    kind,
    capabilityId: deriveMeshCapabilityId("node-a", kind, localId),
    descriptor,
    descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor),
    permissionEnvelopeSha256: computeMeshCapabilityDescriptorSha256(descriptor.permissions),
  };
  return { ...unsigned, entrySha256: computeMeshCapabilityEntrySha256(unsigned) };
}

function manifest(
  publicationKey = "publication-1",
  entries = [entry("skill", "project.guide"), entry("tool", "project.status")],
  supersedesManifestSha256?: string,
  publisherGeneration = 1,
): MeshCapabilityManifest {
  const unsigned = {
    schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    workspaceId: "default",
    nodeId: "node-a",
    admissionGeneration: 1,
    publisherGeneration,
    publicationKey,
    publicationLeaseFencingToken: 1,
    ...(supersedesManifestSha256 === undefined ? {} : { supersedesManifestSha256 }),
    entries,
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  return { ...unsigned, manifestSha256: computeMeshCapabilityManifestSha256(unsigned) };
}

function activationFor(
  manifestRecord: MeshCapabilityManifest,
  capability: MeshCapabilityManifestEntry,
  activationId: string,
): ActivateMeshCapabilityInput {
  return {
    workspaceId: "default",
    activationId,
    activationRevision: 1,
    capabilityId: capability.capabilityId,
    nodeId: "node-a",
    publisherGeneration: manifestRecord.publisherGeneration,
    healthGeneration: 1,
    publicationLeaseFencingToken: 1,
    manifestSha256: manifestRecord.manifestSha256,
    entrySha256: capability.entrySha256,
    descriptorSha256: capability.descriptorSha256,
    permissionEnvelopeSha256: capability.permissionEnvelopeSha256,
    effectPosture: capability.descriptor.effectPosture,
    permissionDiff: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentPermissionEnvelopeSha256: capability.permissionEnvelopeSha256,
      added: [],
      removed: [],
    },
    effectDiff: {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentEffectPosture: capability.descriptor.effectPosture,
    },
    approvalId: `approval-${activationId}`,
    actorId: "operator-a",
    sessionId: "session-a",
    turnId: "turn-a",
    idempotencyKey: `activate-${activationId}`,
  };
}

function approve(db: DatabaseClient, input: ActivateMeshCapabilityInput): void {
  const requestSha256 = computeMeshCapabilityActivationRequestSha256(input);
  const approvalPayload = buildMeshCapabilityActivationApprovalPayload(input);
  assert.equal(approvalPayload.requestSha256, requestSha256);
  db.prepare(
    `
    INSERT INTO approvals (
      approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
      explanation_status, created_at, expires_at, resolved_at, resolved_by
    ) VALUES (?, 'mesh.capability.activate', 'high', 'approved', ?, ?, '{}', 'not_requested', ?, ?, ?, 'operator-a')
  `,
  ).run(
    input.approvalId,
    JSON.stringify({ workspaceId: input.workspaceId, sessionId: input.sessionId, turnId: input.turnId }),
    JSON.stringify(approvalPayload),
    "2026-07-14T12:00:00.000Z",
    "2099-01-01T02:00:00.000Z",
    "2026-07-14T12:01:00.000Z",
  );
}

function boundedDeadline(offsetMs = 20_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("MeshCapabilityPublicationRepository", () => {
  it("locks Postgres admission authority before identical or changed publisher replay reads", () => {
    const { db, publisher } = createHarness();
    const preparedSql: string[] = [];
    const repo = new MeshCapabilityPublicationRepository(createPostgresFacade(db, preparedSql));
    const input = {
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: 1,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
      publicationLeaseKey: publisher.publicationLeaseKey,
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      idempotencyKey: publisher.idempotencyKey,
    };

    assert.deepEqual(repo.registerPublisher(input), publisher);
    assertPublisherAdmissionLocksPrecedeReplayRead(preparedSql);
    preparedSql.length = 0;
    assert.throws(() => repo.registerPublisher({ ...input, admissionGeneration: 2 }), /different request bytes/);
    assertPublisherAdmissionLocksPrecedeReplayRead(preparedSql);
  });

  it("stores immutable generations and manifests with same-byte replay and workspace isolation", () => {
    const { repo, publisher } = createHarness();
    const replay = repo.registerPublisher({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: 1,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
      publicationLeaseKey: publisher.publicationLeaseKey,
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      idempotencyKey: "publisher-1",
    });
    assert.deepEqual(replay, publisher);
    assert.throws(() =>
      repo.registerPublisher({
        workspaceId: "default",
        nodeId: "node-a",
        admissionGeneration: 8,
        publisherGeneration: 1,
        mtlsRequired: true,
        tlsFingerprint: "sha256:node-a",
        publicationLeaseKey: publisher.publicationLeaseKey,
        publicationLeaseFencingToken: 1,
        publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
        idempotencyKey: "publisher-1",
      }),
    );
    assert.throws(() =>
      repo.registerPublisher({
        workspaceId: "default",
        nodeId: "node-a",
        admissionGeneration: 6,
        publisherGeneration: 2,
        mtlsRequired: true,
        tlsFingerprint: "sha256:node-a",
        publicationLeaseKey: publisher.publicationLeaseKey,
        publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
        publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
        idempotencyKey: "publisher-regressed-admission",
      }),
    );

    const published = repo.publishManifest(manifest());
    assert.deepEqual(repo.publishManifest(manifest()), published);
    const digestDrift = manifest("publication-digest-drift");
    digestDrift.entries[0] = {
      ...digestDrift.entries[0]!,
      descriptor: { ...digestDrift.entries[0]!.descriptor, title: "Changed without recomputing descriptor bytes" },
    };
    const { manifestSha256: _discardedDigest, ...unsignedDigestDrift } = digestDrift;
    digestDrift.manifestSha256 = computeMeshCapabilityManifestSha256(unsignedDigestDrift);
    assert.throws(() => repo.publishManifest(digestDrift), /descriptor digest mismatch/);
    const changed = manifest("publication-1", [entry("skill", "project.guide"), entry("tool", "project.changed")]);
    assert.throws(() => repo.publishManifest(changed), /different request bytes/);
    assert.throws(() => repo.getManifest("other", "node-a", 1, published.manifestSha256), /not found/);
  });

  it("exposes read-only current-publisher, publication-key, and manifest-list projections", () => {
    const { repo, publisher } = createHarness();
    assert.deepEqual(repo.findCurrentPublisher("default", "node-a"), publisher);
    assert.equal(repo.findCurrentPublisher("default", "node-unknown"), undefined);
    assert.equal(repo.getManifestByPublicationKey("default", "publication-unused"), undefined);

    const first = repo.publishManifest(manifest());
    assert.deepEqual(repo.getManifestByPublicationKey("default", "publication-1"), first);
    const second = repo.publishManifest(manifest("publication-2", first.entries, first.manifestSha256));

    const records = repo.listManifestRecords("default", { nodeId: "node-a" });
    assert.deepEqual(
      records.map((record) => ({
        manifestSha256: record.manifest.manifestSha256,
        supersededBy: record.supersededByManifestSha256,
      })),
      [
        { manifestSha256: second.manifestSha256, supersededBy: undefined },
        { manifestSha256: first.manifestSha256, supersededBy: second.manifestSha256 },
      ],
    );
    assert.deepEqual(repo.listManifestRecords("default"), records);
    assert.deepEqual(repo.listManifestRecords("default", { nodeId: "node-unknown" }), []);
    assert.deepEqual(repo.listManifestRecords("other-workspace"), []);
    assert.equal(repo.listManifestRecords("default", { limit: 1 }).length, 1);
    assert.throws(() => repo.listManifestRecords("default", { limit: 0 }), /limit/);

    const nextGeneration = repo.registerPublisher({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: 2,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
      publicationLeaseKey: publisher.publicationLeaseKey,
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      idempotencyKey: "publisher-2",
    });
    assert.deepEqual(repo.findCurrentPublisher("default", "node-a"), nextGeneration);
    // Generation supersession is a publisher-generation fact, not a manifest
    // child link: the prior-generation head stays un-superseded in this list.
    const afterGeneration = repo.listManifestRecords("default", { nodeId: "node-a" });
    assert.equal(
      afterGeneration.find((record) => record.manifest.manifestSha256 === second.manifestSha256)
        ?.supersededByManifestSha256,
      undefined,
    );
  });

  it("allows exact tool activation and one settlement while skill activation stays impossible", () => {
    const { db, mesh, repo, lease } = createHarness();
    const published = repo.publishManifest(manifest());
    const skill = published.entries.find((candidate) => candidate.kind === "skill")!;
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;

    const skillActivation = activationFor(published, skill, "skill-activation");
    approve(db, skillActivation);
    assert.throws(() => repo.activate(skillActivation), /never be callable/);

    const toolActivation = activationFor(published, tool, "tool-activation");
    approve(db, toolActivation);
    const active = repo.activate(toolActivation);
    assert.equal(active.capabilityId, tool.capabilityId);
    assert.deepEqual(repo.activate(toolActivation), active);
    assert.deepEqual(
      repo.listCallableActivations("default").map((record) => record.activationId),
      [active.activationId],
    );

    const renewedLease = mesh.renewLease(
      lease.leaseKey,
      "node-a",
      lease.fencingToken,
      3_600,
      "2099-01-01T00:30:00.000Z",
    );
    const refreshedHealth = repo.refreshPublisherLease({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: 1,
      expectedHealthGeneration: 1,
      publicationLeaseFencingToken: renewedLease.fencingToken,
      publicationLeaseExpiresAt: renewedLease.expiresAt,
    });
    assert.equal(refreshedHealth.healthGeneration, 1, "same-token renewal must preserve activation bindings");
    assert.equal(repo.listCallableActivations("default").length, 1);

    const intentInput = {
      workspaceId: "default",
      invocationId: "invocation-1",
      activationId: active.activationId,
      activationRevision: active.activationRevision,
      capabilityId: active.capabilityId,
      nodeId: active.nodeId,
      publisherGeneration: active.publisherGeneration,
      healthGeneration: active.healthGeneration,
      publicationLeaseFencingToken: active.publicationLeaseFencingToken,
      manifestSha256: active.manifestSha256,
      entrySha256: active.entrySha256,
      descriptorSha256: active.descriptorSha256,
      permissionEnvelopeSha256: active.permissionEnvelopeSha256,
      executionProfileSha256: "8".repeat(64),
      inputSha256: "4".repeat(64),
      sessionId: "session-a",
      turnId: "turn-a",
      deadlineAt: boundedDeadline(),
      idempotencyKey: "invoke-1",
    };
    assert.throws(() =>
      repo.createInvocationIntent({
        ...intentInput,
        invocationId: "overlong-invocation",
        deadlineAt: boundedDeadline(120_000),
        idempotencyKey: "overlong-invoke",
      }),
    );
    const intent = repo.createInvocationIntent(intentInput);
    assert.equal(intent.activationId, active.activationId);
    const settlementInput = {
      workspaceId: "default",
      invocationId: intent.invocationId,
      disposition: "succeeded" as const,
      outputSha256: "5".repeat(64),
      settlementSha256: "6".repeat(64),
      effectiveCostAttributionSha256: "d".repeat(64),
      publisherGeneration: 1,
      publicationLeaseFencingToken: 1,
      idempotencyKey: "settle-1",
    };
    const settlement = repo.settleInvocation(settlementInput);
    assert.equal(settlement.effectiveCostAttributionSha256, "d".repeat(64));
    assert.deepEqual(repo.settleInvocation(settlementInput), settlement);
    assert.throws(
      () => repo.settleInvocation({ ...settlementInput, disposition: "failed" }),
      /different request bytes/,
    );
    assert.throws(
      () => repo.settleInvocation({ ...settlementInput, effectiveCostAttributionSha256: "e".repeat(64) }),
      /different request bytes/,
    );

    const revocationInput = {
      workspaceId: "default",
      activationId: active.activationId,
      reason: "Operator withdrew the remote grant.",
      actorId: "operator-a",
      idempotencyKey: "revoke-tool-activation",
    };
    const revoked = repo.revoke(revocationInput);
    assert.deepEqual(repo.revoke(revocationInput), revoked);
    assert.equal(repo.listCallableActivations("default").length, 0);
    assert.throws(() =>
      repo.revoke({
        ...revocationInput,
        reason: "Changed bytes.",
        idempotencyKey: "different-key-same-activation",
      }),
    );
  });

  it("activates an exact MCP descriptor only through the same governed grant path", () => {
    const { db, repo } = createHarness();
    const mcp = entry("mcp_server", "project.files");
    const published = repo.publishManifest(manifest("publication-mcp", [mcp]));
    const activation = activationFor(published, mcp, "mcp-activation");
    approve(db, activation);
    const active = repo.activate(activation);
    assert.equal(active.capabilityId, mcp.capabilityId);
    assert.deepEqual(
      repo.listCallableActivations("default").map((record) => record.activationId),
      [active.activationId],
    );
  });

  it("removes callability after node-admission revoke without blocking a dispatched settlement", () => {
    const { db, repo, publisher } = createHarness();
    const published = repo.publishManifest(manifest("publication-admission-revoke"));
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;
    const activationInput = activationFor(published, tool, "admission-revoke-tool");
    approve(db, activationInput);
    const activation = repo.activate(activationInput);
    const intent = repo.createInvocationIntent({
      workspaceId: "default",
      invocationId: "admission-revoke-invocation",
      activationId: activation.activationId,
      activationRevision: activation.activationRevision,
      capabilityId: activation.capabilityId,
      nodeId: activation.nodeId,
      publisherGeneration: activation.publisherGeneration,
      healthGeneration: activation.healthGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      manifestSha256: activation.manifestSha256,
      entrySha256: activation.entrySha256,
      descriptorSha256: activation.descriptorSha256,
      permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
      executionProfileSha256: "a".repeat(64),
      inputSha256: "b".repeat(64),
      sessionId: "session-a",
      turnId: "turn-admission-revoke",
      deadlineAt: boundedDeadline(),
      idempotencyKey: "invoke-after-admission-revoke",
    });
    repo.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: 1,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: publisher.tlsFingerprint,
    });
    new MeshCapabilityNodeAdmissionRepository(db).revoke({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      reason: "Operator revoked the admitted node.",
      revokedByActorId: "operator-a",
      idempotencyKey: "revoke-admission-node-a",
    });

    assert.equal(repo.listCallableActivations("default").length, 0);
    assert.throws(() =>
      repo.createInvocationIntent({
        workspaceId: "default",
        invocationId: "blocked-after-admission-revoke",
        activationId: activation.activationId,
        activationRevision: activation.activationRevision,
        capabilityId: activation.capabilityId,
        nodeId: activation.nodeId,
        publisherGeneration: activation.publisherGeneration,
        healthGeneration: activation.healthGeneration,
        publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
        manifestSha256: activation.manifestSha256,
        entrySha256: activation.entrySha256,
        descriptorSha256: activation.descriptorSha256,
        permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
        executionProfileSha256: "c".repeat(64),
        inputSha256: "d".repeat(64),
        sessionId: "session-a",
        turnId: "turn-blocked-after-admission-revoke",
        deadlineAt: boundedDeadline(),
        idempotencyKey: "blocked-after-admission-revoke",
      }),
    );
    const settlement = repo.settleInvocation({
      workspaceId: "default",
      invocationId: intent.invocationId,
      disposition: "unknown",
      settlementSha256: "e".repeat(64),
      publisherGeneration: intent.publisherGeneration,
      publicationLeaseFencingToken: intent.publicationLeaseFencingToken,
      idempotencyKey: "settle-after-admission-revoke",
    });
    assert.equal(settlement.disposition, "unknown");
  });

  it("fails legacy publication rows closed when no durable node admission exists", () => {
    const { db, repo } = createHarness();
    const published = repo.publishManifest(manifest("publication-legacy-admission"));
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;
    const activationInput = activationFor(published, tool, "legacy-admission-tool");
    approve(db, activationInput);
    const activation = repo.activate(activationInput);
    assert.equal(repo.listCallableActivations("default").length, 1);

    db.exec("DROP TRIGGER trg_mesh_capability_node_admissions_no_delete");
    db.prepare(
      `DELETE FROM mesh_capability_node_admissions
       WHERE workspace_id = 'default' AND node_id = 'node-a' AND admission_generation = 1`,
    ).run();

    assert.equal(repo.listCallableActivations("default").length, 0);
    assert.throws(() =>
      repo.createInvocationIntent({
        workspaceId: "default",
        invocationId: "legacy-admission-blocked-invocation",
        activationId: activation.activationId,
        activationRevision: activation.activationRevision,
        capabilityId: activation.capabilityId,
        nodeId: activation.nodeId,
        publisherGeneration: activation.publisherGeneration,
        healthGeneration: activation.healthGeneration,
        publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
        manifestSha256: activation.manifestSha256,
        entrySha256: activation.entrySha256,
        descriptorSha256: activation.descriptorSha256,
        permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
        executionProfileSha256: "f".repeat(64),
        inputSha256: "0".repeat(64),
        sessionId: "session-a",
        turnId: "turn-legacy-admission",
        deadlineAt: boundedDeadline(),
        idempotencyKey: "legacy-admission-blocked-invoke",
      }),
    );
  });

  it("invalidates prior activations when an immutable manifest head is superseded", () => {
    const { db, repo } = createHarness();
    const first = repo.publishManifest(manifest());
    const tool = first.entries.find((candidate) => candidate.kind === "tool")!;
    const activation = activationFor(first, tool, "superseded-tool");
    approve(db, activation);
    const active = repo.activate(activation);
    assert.equal(repo.listCallableActivations("default").length, 1);

    repo.publishManifest(manifest("publication-2", first.entries, first.manifestSha256));
    assert.equal(repo.listCallableActivations("default").length, 0);
    assert.throws(() =>
      repo.createInvocationIntent({
        workspaceId: "default",
        invocationId: "superseded-invocation",
        activationId: active.activationId,
        activationRevision: active.activationRevision,
        capabilityId: active.capabilityId,
        nodeId: active.nodeId,
        publisherGeneration: active.publisherGeneration,
        healthGeneration: active.healthGeneration,
        publicationLeaseFencingToken: active.publicationLeaseFencingToken,
        manifestSha256: active.manifestSha256,
        entrySha256: active.entrySha256,
        descriptorSha256: active.descriptorSha256,
        permissionEnvelopeSha256: active.permissionEnvelopeSha256,
        executionProfileSha256: "8".repeat(64),
        inputSha256: "9".repeat(64),
        sessionId: "session-a",
        turnId: "turn-superseded",
        deadlineAt: boundedDeadline(),
        idempotencyKey: "superseded-invoke",
      }),
    );
  });

  it("rejects a first settlement after the publisher generation becomes stale", () => {
    const { db, repo, publisher } = createHarness();
    const published = repo.publishManifest(manifest());
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;
    const activationInput = activationFor(published, tool, "stale-settlement-tool");
    approve(db, activationInput);
    const activation = repo.activate(activationInput);
    const intent = repo.createInvocationIntent({
      workspaceId: "default",
      invocationId: "stale-settlement-invocation",
      activationId: activation.activationId,
      activationRevision: activation.activationRevision,
      capabilityId: activation.capabilityId,
      nodeId: activation.nodeId,
      publisherGeneration: activation.publisherGeneration,
      healthGeneration: activation.healthGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      manifestSha256: activation.manifestSha256,
      entrySha256: activation.entrySha256,
      descriptorSha256: activation.descriptorSha256,
      permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
      executionProfileSha256: "a".repeat(64),
      inputSha256: "b".repeat(64),
      sessionId: "session-a",
      turnId: "turn-stale",
      deadlineAt: boundedDeadline(),
      idempotencyKey: "stale-settlement-invoke",
    });
    repo.registerPublisher({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: 2,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
      publicationLeaseKey: publisher.publicationLeaseKey,
      publicationLeaseFencingToken: publisher.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      idempotencyKey: "publisher-2",
    });
    assert.throws(() =>
      repo.settleInvocation({
        workspaceId: "default",
        invocationId: intent.invocationId,
        disposition: "unknown",
        settlementSha256: "c".repeat(64),
        publisherGeneration: 1,
        publicationLeaseFencingToken: 1,
        idempotencyKey: "stale-settlement",
      }),
    );
  });

  it("exposes non-throwing invocation intent/settlement reads and the expired-unsettled projection", () => {
    const { db, repo } = createHarness();
    const published = repo.publishManifest(manifest());
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;
    const activationInput = activationFor(published, tool, "read-surface-tool");
    approve(db, activationInput);
    const activation = repo.activate(activationInput);

    assert.equal(repo.findInvocationIntent("default", "missing-invocation"), undefined);
    assert.equal(repo.findInvocationSettlement("default", "missing-invocation"), undefined);
    assert.deepEqual(repo.listUnsettledExpiredInvocationIntents("default"), []);

    const intent = repo.createInvocationIntent({
      workspaceId: "default",
      invocationId: "read-surface-invocation",
      activationId: activation.activationId,
      activationRevision: activation.activationRevision,
      capabilityId: activation.capabilityId,
      nodeId: activation.nodeId,
      publisherGeneration: activation.publisherGeneration,
      healthGeneration: activation.healthGeneration,
      publicationLeaseFencingToken: activation.publicationLeaseFencingToken,
      manifestSha256: activation.manifestSha256,
      entrySha256: activation.entrySha256,
      descriptorSha256: activation.descriptorSha256,
      permissionEnvelopeSha256: activation.permissionEnvelopeSha256,
      executionProfileSha256: "1".repeat(64),
      inputSha256: "2".repeat(64),
      sessionId: "session-a",
      turnId: "turn-read-surface",
      deadlineAt: boundedDeadline(1_100),
      idempotencyKey: "read-surface-invoke",
    });
    assert.deepEqual(repo.findInvocationIntent("default", intent.invocationId), intent);
    // Cross-workspace reads stay isolated even when the invocation ID matches.
    assert.equal(repo.findInvocationIntent("other-workspace", intent.invocationId), undefined);
    assert.equal(repo.findInvocationSettlement("default", intent.invocationId), undefined);

    // Not listed while the deadline is still in the future.
    assert.deepEqual(repo.listUnsettledExpiredInvocationIntents("default"), []);
    const start = Date.now();
    while (Date.now() - start < 1_300) {
      // Busy-wait past the database-clock deadline; the intent guard requires a
      // future deadline at insert time, so a short real wait is unavoidable.
    }
    assert.deepEqual(
      repo.listUnsettledExpiredInvocationIntents("default").map((row) => row.invocationId),
      [intent.invocationId],
    );
    assert.deepEqual(repo.listUnsettledExpiredInvocationIntents("other-workspace"), []);
    assert.throws(() => repo.listUnsettledExpiredInvocationIntents("default", 0), /limit/);

    const settlement = repo.settleInvocation({
      workspaceId: "default",
      invocationId: intent.invocationId,
      disposition: "unknown",
      errorCode: "mesh_capability_dispatch_deadline_expired",
      settlementSha256: "3".repeat(64),
      publisherGeneration: intent.publisherGeneration,
      publicationLeaseFencingToken: intent.publicationLeaseFencingToken,
      idempotencyKey: "read-surface-settle",
    });
    assert.deepEqual(repo.findInvocationSettlement("default", intent.invocationId), settlement);
    assert.equal(repo.findInvocationSettlement("other-workspace", intent.invocationId), undefined);
    // Settled intents leave the expired-unsettled projection.
    assert.deepEqual(repo.listUnsettledExpiredInvocationIntents("default"), []);
  });

  it("removes callability on health generation drift and requires explicit reactivation", () => {
    const { db, mesh, repo, publisher } = createHarness();
    const published = repo.publishManifest(manifest());
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;
    const activation = activationFor(published, tool, "tool-health");
    approve(db, activation);
    const active = repo.activate(activation);
    assert.equal(repo.listCallableActivations("default").length, 1);

    const offline = repo.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: 1,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: 1,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });
    assert.equal(offline.healthGeneration, 2);
    assert.equal(repo.listCallableActivations("default").length, 0);
    assert.throws(() =>
      repo.createInvocationIntent({
        workspaceId: "default",
        invocationId: "blocked-invocation",
        activationId: active.activationId,
        activationRevision: active.activationRevision,
        capabilityId: active.capabilityId,
        nodeId: active.nodeId,
        publisherGeneration: active.publisherGeneration,
        healthGeneration: active.healthGeneration,
        publicationLeaseFencingToken: active.publicationLeaseFencingToken,
        manifestSha256: active.manifestSha256,
        entrySha256: active.entrySha256,
        descriptorSha256: active.descriptorSha256,
        permissionEnvelopeSha256: active.permissionEnvelopeSha256,
        executionProfileSha256: "8".repeat(64),
        inputSha256: "7".repeat(64),
        sessionId: "session-a",
        turnId: "turn-b",
        deadlineAt: boundedDeadline(),
        idempotencyKey: "blocked-invoke",
      }),
    );

    assert.throws(() =>
      repo.transitionPublisherHealth({
        workspaceId: "default",
        nodeId: "node-a",
        publisherGeneration: 1,
        expectedHealthGeneration: 2,
        status: "online",
        publicationLeaseFencingToken: 1,
        publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
        tlsFingerprint: "sha256:node-a",
      }),
    );
    repo.registerPublisher({
      workspaceId: "default",
      nodeId: "node-a",
      admissionGeneration: 1,
      publisherGeneration: 2,
      mtlsRequired: true,
      tlsFingerprint: "sha256:node-a",
      publicationLeaseKey: publisher.publicationLeaseKey,
      publicationLeaseFencingToken: 1,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      idempotencyKey: "publisher-reconnected-generation-2",
    });
    const reconnectedManifest = repo.publishManifest(
      manifest("publication-reconnected-generation-2", published.entries, undefined, 2),
    );
    assert.equal(repo.listCallableActivations("default").length, 0, "reconnect must not revive an old grant");

    const reactivation = activationFor(reconnectedManifest, tool, "tool-health-reactivated");
    reactivation.activationRevision = 2;
    reactivation.permissionDiff = {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "unchanged",
      priorActivationId: active.activationId,
      priorPermissionEnvelopeSha256: active.permissionEnvelopeSha256,
      currentPermissionEnvelopeSha256: active.permissionEnvelopeSha256,
      added: [],
      removed: [],
    };
    reactivation.effectDiff = {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "unchanged",
      priorActivationId: active.activationId,
      priorEffectPosture: active.effectPosture,
      currentEffectPosture: active.effectPosture,
    };
    approve(db, reactivation);
    repo.activate(reactivation);
    assert.equal(repo.listCallableActivations("default").length, 1);

    const admittedNode = mesh.getNode("node-a");
    mesh.upsertNode({ ...admittedNode, tlsFingerprint: "sha256:rotated-without-new-generation" });
    assert.equal(repo.listCallableActivations("default").length, 0, "certificate drift must fail closed");
    mesh.upsertNode(admittedNode);
    db.prepare("UPDATE mesh_leases SET expires_at = ? WHERE lease_key = ?").run(
      "2000-01-01T00:00:00.000Z",
      publisher.publicationLeaseKey,
    );
    assert.equal(repo.listCallableActivations("default").length, 0, "database-clock lease expiry must fail closed");
    const expiredOffline = repo.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: "node-a",
      publisherGeneration: 2,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: 1,
      publicationLeaseExpiresAt: publisher.publicationLeaseExpiresAt,
      tlsFingerprint: "sha256:node-a",
    });
    assert.equal(expiredOffline.status, "offline", "expired publishers must still be recordable as offline");
  });

  it("keeps only the latest exact activation revision callable and never falls back after revoke", () => {
    const { db, repo } = createHarness();
    const published = repo.publishManifest(manifest());
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;
    const firstInput = activationFor(published, tool, "revision-one");
    approve(db, firstInput);
    const first = repo.activate(firstInput);

    const forgedDiff = activationFor(published, tool, "forged-revision-two");
    forgedDiff.activationRevision = 2;
    forgedDiff.permissionDiff = {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "widened",
      priorActivationId: first.activationId,
      priorPermissionEnvelopeSha256: first.permissionEnvelopeSha256,
      currentPermissionEnvelopeSha256: first.permissionEnvelopeSha256,
      added: ["networkOrigins:https://forged.example"],
      removed: [],
    };
    forgedDiff.effectDiff = {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "unchanged",
      priorActivationId: first.activationId,
      priorEffectPosture: first.effectPosture,
      currentEffectPosture: first.effectPosture,
    };
    approve(db, forgedDiff);
    assert.throws(() => repo.activate(forgedDiff), /does not match the exact prior and current envelopes/);

    const secondInput = activationFor(published, tool, "revision-two");
    secondInput.activationRevision = 2;
    secondInput.permissionDiff = {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "unchanged",
      priorActivationId: first.activationId,
      priorPermissionEnvelopeSha256: first.permissionEnvelopeSha256,
      currentPermissionEnvelopeSha256: first.permissionEnvelopeSha256,
      added: [],
      removed: [],
    };
    secondInput.effectDiff = {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "unchanged",
      priorActivationId: first.activationId,
      priorEffectPosture: first.effectPosture,
      currentEffectPosture: first.effectPosture,
    };
    approve(db, secondInput);
    const second = repo.activate(secondInput);
    assert.deepEqual(
      repo.listCallableActivations("default").map((record) => record.activationId),
      [second.activationId],
    );
    assert.throws(() =>
      repo.createInvocationIntent({
        workspaceId: "default",
        invocationId: "stale-revision-invocation",
        activationId: first.activationId,
        activationRevision: first.activationRevision,
        capabilityId: first.capabilityId,
        nodeId: first.nodeId,
        publisherGeneration: first.publisherGeneration,
        healthGeneration: first.healthGeneration,
        publicationLeaseFencingToken: first.publicationLeaseFencingToken,
        manifestSha256: first.manifestSha256,
        entrySha256: first.entrySha256,
        descriptorSha256: first.descriptorSha256,
        permissionEnvelopeSha256: first.permissionEnvelopeSha256,
        executionProfileSha256: "e".repeat(64),
        inputSha256: "f".repeat(64),
        sessionId: "session-a",
        turnId: "turn-stale-revision",
        deadlineAt: "2099-01-01T01:00:00.000Z",
        idempotencyKey: "stale-revision-invoke",
      }),
    );

    repo.revoke({
      workspaceId: "default",
      activationId: second.activationId,
      reason: "Revoke the latest exact revision.",
      actorId: "operator-a",
      idempotencyKey: "revoke-revision-two",
    });
    assert.equal(repo.listCallableActivations("default").length, 0, "revocation must not revive an older revision");
  });

  it("reads latest activation, revocation evidence, and the exact storage-owned diff pair", () => {
    const { db, repo } = createHarness();
    const published = repo.publishManifest(manifest());
    const tool = published.entries.find((candidate) => candidate.kind === "tool")!;

    assert.equal(repo.findLatestActivation("default", tool.capabilityId), undefined);
    assert.equal(repo.findActivationRevocation("default", "missing-activation"), undefined);

    const initialDiffs = buildMeshCapabilityActivationDiffs({ currentEntry: tool });
    const firstInput = activationFor(published, tool, "diff-revision-one");
    assert.deepEqual(initialDiffs.permissionDiff, firstInput.permissionDiff);
    assert.deepEqual(initialDiffs.effectDiff, firstInput.effectDiff);
    approve(db, firstInput);
    const first = repo.activate(firstInput);

    const nextDiffs = buildMeshCapabilityActivationDiffs({
      currentEntry: tool,
      prior: { activation: first, entry: tool },
    });
    const secondInput = {
      ...activationFor(published, tool, "diff-revision-two"),
      activationRevision: 2,
      permissionDiff: nextDiffs.permissionDiff,
      effectDiff: nextDiffs.effectDiff,
    };
    approve(db, secondInput);
    const second = repo.activate(secondInput);
    assert.equal(second.activationRevision, 2);
    assert.equal(nextDiffs.permissionDiff.disposition, "unchanged");
    assert.equal(nextDiffs.effectDiff.disposition, "unchanged");

    const latest = repo.findLatestActivation("default", tool.capabilityId);
    assert.equal(latest?.activationId, second.activationId);
    assert.equal(latest?.activationRevision, 2);
    // Cross-workspace reads stay isolated even for the identical capability ID.
    assert.equal(repo.findLatestActivation("workspace-b", tool.capabilityId), undefined);

    assert.equal(repo.findActivationRevocation("default", second.activationId), undefined);
    repo.revoke({
      workspaceId: "default",
      activationId: second.activationId,
      reason: "Revoke for the latest-read proof.",
      actorId: "operator-a",
      idempotencyKey: "revoke-diff-revision-two",
    });
    const revocation = repo.findActivationRevocation("default", second.activationId);
    assert.equal(revocation?.activationId, second.activationId);
    assert.equal(repo.findActivationRevocation("workspace-b", second.activationId), undefined);
    // The latest-read still reports the revoked revision; callability is gone.
    assert.equal(repo.findLatestActivation("default", tool.capabilityId)?.activationId, second.activationId);
    assert.equal(repo.listCallableActivations("default").length, 0);
  });

  it("enforces admitted-publisher and active-manifest caps from canonical storage state", () => {
    const { db, mesh, repo } = createHarness();
    const publishers = new Map<string, ReturnType<typeof repo.registerPublisher>>();
    for (let index = 1; index <= 15; index += 1) {
      const nodeId = `node-${String(index).padStart(2, "0")}`;
      mesh.upsertNode({
        nodeId,
        transport: "lan",
        status: "online",
        capabilities: [],
        joinedAt: FUTURE,
        lastSeenAt: FUTURE,
      });
      admitNode(db, mesh, nodeId, false);
      const lease = mesh.acquireLease(`mesh-capability-publication:default:${nodeId}`, nodeId, 3_600, FUTURE);
      const publisher = repo.registerPublisher({
        workspaceId: "default",
        nodeId,
        admissionGeneration: 1,
        publisherGeneration: 1,
        mtlsRequired: false,
        publicationLeaseKey: lease.leaseKey,
        publicationLeaseFencingToken: lease.fencingToken,
        publicationLeaseExpiresAt: lease.expiresAt,
        idempotencyKey: `publisher-${nodeId}`,
      });
      publishers.set(nodeId, publisher);
    }
    mesh.upsertNode({
      nodeId: "node-over-cap",
      transport: "lan",
      status: "online",
      capabilities: [],
      joinedAt: FUTURE,
      lastSeenAt: FUTURE,
    });
    const overCapToken = "join:node-over-cap";
    mesh.issueJoinToken(overCapToken, FUTURE);
    assert.equal(mesh.consumeJoinToken(overCapToken, "node-over-cap", "2026-07-14T12:00:00.000Z"), true);
    const overCapTokenSha256 = mesh.snapshotRuntimeArtifacts("node-over-cap", overCapToken).tokenHash;
    assert.ok(overCapTokenSha256);
    const admissions = new MeshCapabilityNodeAdmissionRepository(db);
    const overCapAdmissionInput = {
      workspaceId: "default",
      nodeId: "node-over-cap",
      expectedAdmissionGeneration: 0,
      joinTokenSha256: overCapTokenSha256,
      mtlsRequired: false,
      admittedByActorId: "operator-a",
      idempotencyKey: "admit:node-over-cap",
    };
    assert.throws(() => admissions.admit(overCapAdmissionInput));

    const retired = publishers.get("node-01")!;
    repo.transitionPublisherHealth({
      workspaceId: "default",
      nodeId: retired.nodeId,
      publisherGeneration: retired.publisherGeneration,
      expectedHealthGeneration: 1,
      status: "offline",
      publicationLeaseFencingToken: retired.publicationLeaseFencingToken,
      publicationLeaseExpiresAt: retired.publicationLeaseExpiresAt,
      tlsFingerprint: retired.tlsFingerprint,
    });
    admissions.revoke({
      workspaceId: "default",
      nodeId: retired.nodeId,
      admissionGeneration: retired.admissionGeneration,
      reason: "Retire one admitted publisher slot.",
      revokedByActorId: "operator-a",
      idempotencyKey: "revoke:node-01:slot-reuse",
    });

    const replacementAdmission = admissions.admit(overCapAdmissionInput);
    const replacementLease = mesh.acquireLease(
      "mesh-capability-publication:default:node-over-cap",
      "node-over-cap",
      3_600,
      FUTURE,
    );
    assert.equal(
      repo.registerPublisher({
        workspaceId: "default",
        nodeId: "node-over-cap",
        admissionGeneration: replacementAdmission.admissionGeneration,
        publisherGeneration: 1,
        mtlsRequired: false,
        publicationLeaseKey: replacementLease.leaseKey,
        publicationLeaseFencingToken: replacementLease.fencingToken,
        publicationLeaseExpiresAt: replacementLease.expiresAt,
        idempotencyKey: "publisher-node-over-cap-after-retire",
      }).nodeId,
      "node-over-cap",
      "historical publisher rows must not shadow a retired admission slot",
    );

    mesh.upsertNode({
      nodeId: "node-still-over-cap",
      transport: "lan",
      status: "online",
      capabilities: [],
      joinedAt: FUTURE,
      lastSeenAt: FUTURE,
    });
    assert.throws(() => admitNode(db, mesh, "node-still-over-cap", false));

    const repeatedEntry = entry("tool", "manifest.cap");
    for (let index = 1; index <= 32; index += 1) {
      repo.publishManifest(manifest(`manifest-cap-${index}`, [repeatedEntry]));
    }
    assert.throws(() => repo.publishManifest(manifest("manifest-cap-33", [repeatedEntry])));
  });

  it("enforces 256 active callable heads while allowing an exact head replacement", () => {
    const { db, repo } = createHarness();
    const firstEntries = Array.from({ length: 128 }, (_, index) =>
      entry("tool", `bounded.${String(index).padStart(3, "0")}`),
    );
    const secondEntries = Array.from({ length: 128 }, (_, index) =>
      entry("tool", `bounded.${String(index + 128).padStart(3, "0")}`),
    );
    const firstManifest = repo.publishManifest(manifest("bounded-manifest-1", firstEntries));
    const secondManifest = repo.publishManifest(manifest("bounded-manifest-2", secondEntries));
    const activations: ReturnType<typeof repo.activate>[] = [];
    for (const [manifestRecord, entries] of [
      [firstManifest, firstEntries],
      [secondManifest, secondEntries],
    ] as const) {
      for (const capability of entries) {
        const input = activationFor(manifestRecord, capability, `active-${capability.localId}`);
        approve(db, input);
        activations.push(repo.activate(input));
      }
    }
    assert.equal(repo.listCallableActivations("default").length, 256);

    const prior = activations[0]!;
    const replacementInput = activationFor(firstManifest, firstEntries[0]!, "active-head-replacement");
    replacementInput.activationRevision = 2;
    replacementInput.permissionDiff = {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "unchanged",
      priorActivationId: prior.activationId,
      priorPermissionEnvelopeSha256: prior.permissionEnvelopeSha256,
      currentPermissionEnvelopeSha256: prior.permissionEnvelopeSha256,
      added: [],
      removed: [],
    };
    replacementInput.effectDiff = {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "unchanged",
      priorActivationId: prior.activationId,
      priorEffectPosture: prior.effectPosture,
      currentEffectPosture: prior.effectPosture,
    };
    approve(db, replacementInput);
    const replacement = repo.activate(replacementInput);
    const callableIds = repo.listCallableActivations("default").map((record) => record.activationId);
    assert.equal(callableIds.length, 256);
    assert.ok(callableIds.includes(replacement.activationId));
    assert.ok(!callableIds.includes(prior.activationId));

    const extraEntry = entry("tool", "bounded.256");
    const extraManifest = repo.publishManifest(manifest("bounded-manifest-3", [extraEntry]));
    const extraInput = activationFor(extraManifest, extraEntry, "active-over-cap");
    approve(db, extraInput);
    assert.throws(() => repo.activate(extraInput));
  });
});

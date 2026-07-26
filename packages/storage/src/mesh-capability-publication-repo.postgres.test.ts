import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_SCHEMA_VERSION,
  canonicalJsonString,
  deriveMeshCapabilityId,
  type MeshCapabilityDescriptor,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
  type MeshCapabilityPermissionEnvelope,
} from "@goatcitadel/contracts";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import type { DatabaseClient } from "./db.js";
import { MeshCapabilityNodeAdmissionRepository } from "./mesh-capability-node-admission-repo.js";
import {
  MeshCapabilityPublicationRepository,
  buildMeshCapabilityActivationApprovalPayload,
  computeMeshCapabilityActivationRequestSha256,
  computeMeshCapabilityDescriptorSha256,
  computeMeshCapabilityEntrySha256,
  computeMeshCapabilityManifestSha256,
  type ActivateMeshCapabilityInput,
} from "./mesh-capability-publication-repo.js";
import { MeshRepository } from "./mesh-repo.js";

// HX-408 M4 live-PostgreSQL parity proof (packet proof-matrix row: "manifest
// canonicalization, exact replay, conflict, caps, and SQLite/PostgreSQL
// parity"). The suite follows the repo's `.postgres.test.ts` conditional
// convention: it skips with a visible reason when GOATCITADEL_TEST_POSTGRES_URL
// is unset, and the named `verify:mesh:capability-publication` lane provisions
// a hermetic cluster and runs it with the URL set — inside the lane this suite
// may never skip. It exercises the committed 168/110 publication storage
// (publisher registration, manifest publish replay/conflict, governed
// activation under the real approval-verifying trigger, revoke removing
// callability, invocation intents, one-winner settlement replay/conflict, and
// the expired-unsettled recovery projection) against a real cluster after the
// FULL migration ledger runs.
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

const WORKSPACE = "default";
const NODE_ID = "node-pg";
const FUTURE = "2099-01-01T00:00:00.000Z";

describe("HX-408 mesh capability publication live PostgreSQL parity (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "replays exact manifests, conflicts changed bytes, activates under the approval trigger, revokes callability, and settles one winner",
    { timeout: 300_000 },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "");
      const schemaName = `hx408_mesh_caps_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString, max: 2 });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const database = decodeURIComponent(scopedUrl.pathname.replace(/^\//u, "")) || "postgres";
      const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
      const migrations = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database },
        { pool: scopedPool },
      );
      const db = new PostgresSyncDatabaseClient({
        connectionString: scopedUrl.toString(),
        database,
        applicationName: `hx408-mesh-caps-${suffix}`,
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      });

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        db.exec(`SET search_path TO ${schemaName}`);
        assert.equal(
          db.prepare("SELECT current_schema() AS schema_name").get<{ schema_name: string }>()!.schema_name,
          schemaName,
        );
        await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);

        // --- Admitted publisher chain through the real repositories ---
        const mesh = new MeshRepository(db);
        mesh.upsertNode({
          nodeId: NODE_ID,
          transport: "lan",
          status: "online",
          capabilities: [],
          tlsFingerprint: `sha256:${NODE_ID}`,
          joinedAt: FUTURE,
          lastSeenAt: FUTURE,
        });
        const rawToken = `join:${NODE_ID}:${suffix}`;
        mesh.issueJoinToken(rawToken, FUTURE);
        assert.equal(mesh.consumeJoinToken(rawToken, NODE_ID, "2026-07-14T12:00:00.000Z"), true);
        const joinTokenSha256 = mesh.snapshotRuntimeArtifacts(NODE_ID, rawToken).tokenHash;
        assert.ok(joinTokenSha256);
        new MeshCapabilityNodeAdmissionRepository(db).admit({
          workspaceId: WORKSPACE,
          nodeId: NODE_ID,
          expectedAdmissionGeneration: 0,
          joinTokenSha256,
          mtlsRequired: true,
          tlsFingerprint: `sha256:${NODE_ID}`,
          admittedByActorId: "operator-a",
          idempotencyKey: `admit:${NODE_ID}`,
        });
        const lease = mesh.acquireLease(`mesh-capability-publication:${WORKSPACE}:${NODE_ID}`, NODE_ID, 3_600, FUTURE);
        const repo = new MeshCapabilityPublicationRepository(db);
        const publisher = repo.registerPublisher({
          workspaceId: WORKSPACE,
          nodeId: NODE_ID,
          admissionGeneration: 1,
          publisherGeneration: 1,
          mtlsRequired: true,
          tlsFingerprint: `sha256:${NODE_ID}`,
          publicationLeaseKey: lease.leaseKey,
          publicationLeaseFencingToken: lease.fencingToken,
          publicationLeaseExpiresAt: lease.expiresAt,
          idempotencyKey: "publisher-1",
        });
        assert.equal(publisher.publisherGeneration, 1);
        // Publisher registration itself replays idempotently on the same key.
        assert.equal(
          repo.registerPublisher({
            workspaceId: WORKSPACE,
            nodeId: NODE_ID,
            admissionGeneration: 1,
            publisherGeneration: 1,
            mtlsRequired: true,
            tlsFingerprint: `sha256:${NODE_ID}`,
            publicationLeaseKey: lease.leaseKey,
            publicationLeaseFencingToken: lease.fencingToken,
            publicationLeaseExpiresAt: lease.expiresAt,
            idempotencyKey: "publisher-1",
          }).publisherGeneration,
          1,
        );

        // --- Manifest publish: exact replay converges, changed bytes conflict ---
        const entryStatus = buildEntry("tool", "project.status");
        const entryOther = buildEntry("tool", "project.other");
        const manifest = buildManifest("publication-pg-1", [entryOther, entryStatus], lease.fencingToken);
        const stored = repo.publishManifest(manifest);
        assert.equal(stored.manifestSha256, manifest.manifestSha256);
        const replayed = repo.publishManifest(manifest);
        assert.equal(replayed.manifestSha256, manifest.manifestSha256);
        assert.equal(
          Number(
            db
              .prepare(`SELECT COUNT(*) AS count FROM mesh_capability_manifests WHERE workspace_id = @workspaceId`)
              .get<{ count: number | string }>({ workspaceId: WORKSPACE })!.count,
          ),
          1,
          "the byte-exact replay stores no second manifest row",
        );
        assert.deepEqual(
          repo.listManifestRecords(WORKSPACE, { nodeId: NODE_ID }).map((record) => record.manifest.manifestSha256),
          [manifest.manifestSha256],
          "the optional node filter stays typed and executable on live PostgreSQL",
        );
        assert.deepEqual(
          repo.listManifestRecords(WORKSPACE).map((record) => record.manifest.manifestSha256),
          [manifest.manifestSha256],
          "the null node filter stays typed and executable on live PostgreSQL",
        );
        const changed = buildManifest("publication-pg-1", [entryStatus], lease.fencingToken);
        assert.throws(
          () => repo.publishManifest(changed),
          /replay|conflict|already/iu,
          "changed bytes on the same publication key must conflict",
        );

        // --- Governed activation under the real approval-verifying trigger ---
        const activationStatus = activationInput(manifest, entryStatus, `mesh-activation-${"a".repeat(48)}`);
        insertApprovedApproval(db, activationStatus);
        const activation = repo.activate(activationStatus);
        assert.equal(activation.activationRevision, 1);
        // Replay converges on the immutable activation row.
        assert.equal(repo.activate(activationStatus).activationId, activation.activationId);
        // A missing approval row fails the sibling activation closed with the
        // content-free storage conflict (the trigger names no reason).
        const activationOther = activationInput(manifest, entryOther, `mesh-activation-${"b".repeat(48)}`);
        assert.throws(
          () => repo.activate(activationOther),
          /conflict/iu,
          "activation without its approval row fails closed",
        );
        insertApprovedApproval(db, activationOther);
        const otherActivation = repo.activate(activationOther);
        const callable = repo.listCallableActivations(WORKSPACE);
        assert.deepEqual(
          callable.map((row) => row.activationId).sort(),
          [activation.activationId, otherActivation.activationId].sort(),
          "both exact activations revalidate as callable on live PostgreSQL",
        );

        // --- Revoke removes callability before the next read; second revoke converges ---
        const revocation = repo.revoke({
          workspaceId: WORKSPACE,
          activationId: otherActivation.activationId,
          reason: "Operator withdrew the remote grant.",
          actorId: "operator-a",
          idempotencyKey: `revoke:${otherActivation.activationId}`,
        });
        assert.equal(revocation.activationId, otherActivation.activationId);
        assert.equal(
          repo.revoke({
            workspaceId: WORKSPACE,
            activationId: otherActivation.activationId,
            reason: "Operator withdrew the remote grant.",
            actorId: "operator-a",
            idempotencyKey: `revoke:${otherActivation.activationId}`,
          }).revokedAt,
          revocation.revokedAt,
          "revocation replays converge on the immutable row",
        );
        assert.deepEqual(
          repo.listCallableActivations(WORKSPACE).map((row) => row.activationId),
          [activation.activationId],
          "revoked activation is gone from the callable projection immediately",
        );

        // --- Invocation intent + one-winner settlement replay/conflict ---
        const intent = repo.createInvocationIntent({
          workspaceId: WORKSPACE,
          invocationId: `mesh-invocation-${"c".repeat(48)}`,
          activationId: activation.activationId,
          activationRevision: activation.activationRevision,
          capabilityId: activation.capabilityId,
          nodeId: NODE_ID,
          publisherGeneration: 1,
          healthGeneration: 1,
          publicationLeaseFencingToken: lease.fencingToken,
          manifestSha256: manifest.manifestSha256,
          entrySha256: entryStatus.entrySha256,
          descriptorSha256: entryStatus.descriptorSha256,
          permissionEnvelopeSha256: entryStatus.permissionEnvelopeSha256,
          executionProfileSha256: "9".repeat(64),
          inputSha256: "8".repeat(64),
          sessionId: "session-a",
          turnId: "turn-a",
          // The trigger bounds the deadline by the entry's declared timeoutMs
          // (30s here): future, but never beyond the declared ceiling.
          deadlineAt: new Date(Date.now() + 25_000).toISOString(),
          idempotencyKey: "mesh-capability-invocation:tool-run-pg-1",
        });
        const settlementInput = {
          workspaceId: WORKSPACE,
          invocationId: intent.invocationId,
          disposition: "succeeded" as const,
          settlementSha256: "7".repeat(64),
          outputSha256: "6".repeat(64),
          publisherGeneration: 1,
          publicationLeaseFencingToken: lease.fencingToken,
          idempotencyKey: `mesh-capability-settlement:node:${NODE_ID}:${intent.invocationId}`,
        };
        const settled = repo.settleInvocation(settlementInput);
        assert.equal(settled.disposition, "succeeded");
        // Duplicate identical settlement replays idempotently.
        assert.equal(repo.settleInvocation(settlementInput).settledAt, settled.settledAt);
        // Changed settlement bytes for the same invocation conflict (one winner).
        assert.throws(
          () =>
            repo.settleInvocation({
              ...settlementInput,
              disposition: "failed",
              settlementSha256: "5".repeat(64),
              idempotencyKey: `mesh-capability-settlement:gateway:${intent.invocationId}`,
            }),
          /replay|conflict|already/iu,
        );
        assert.equal(repo.findInvocationSettlement(WORKSPACE, intent.invocationId)!.disposition, "succeeded");

        // --- Expired-unsettled recovery projection on the database clock ---
        const expiring = repo.createInvocationIntent({
          workspaceId: WORKSPACE,
          invocationId: `mesh-invocation-${"d".repeat(48)}`,
          activationId: activation.activationId,
          activationRevision: activation.activationRevision,
          capabilityId: activation.capabilityId,
          nodeId: NODE_ID,
          publisherGeneration: 1,
          healthGeneration: 1,
          publicationLeaseFencingToken: lease.fencingToken,
          manifestSha256: manifest.manifestSha256,
          entrySha256: entryStatus.entrySha256,
          descriptorSha256: entryStatus.descriptorSha256,
          permissionEnvelopeSha256: entryStatus.permissionEnvelopeSha256,
          executionProfileSha256: "9".repeat(64),
          inputSha256: "8".repeat(64),
          sessionId: "session-a",
          turnId: "turn-a",
          deadlineAt: new Date(Date.now() + 2_000).toISOString(),
          idempotencyKey: "mesh-capability-invocation:tool-run-pg-2",
        });
        assert.deepEqual(
          repo.listUnsettledExpiredInvocationIntents(WORKSPACE).map((row) => row.invocationId),
          [],
          "an unexpired unsettled intent is not projected for recovery",
        );
        const deadline = Date.now() + 30_000;
        let projected: string[] = [];
        while (Date.now() < deadline) {
          projected = repo.listUnsettledExpiredInvocationIntents(WORKSPACE).map((row) => row.invocationId);
          if (projected.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.deepEqual(projected, [expiring.invocationId], "the expired unsettled intent projects for recovery");
      } finally {
        db.close();
        await migrations.close().catch(() => undefined);
        await scopedPool.end().catch(() => undefined);
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await adminPool.end().catch(() => undefined);
      }
    },
  );
});

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

function buildEntry(kind: "tool", localId: string): MeshCapabilityManifestEntry {
  const descriptor: MeshCapabilityDescriptor = {
    kind,
    title: "Project status",
    semanticVersion: "1.0.0",
    effectPosture: "read_only",
    permissions: permissions(),
    resourceLimits: { timeoutMs: 30_000, maxRequestBytes: 16_384, maxResponseBytes: 65_536 },
    healthCheck: { protocol: "mesh.capability-health.v1", intervalMs: 30_000, timeoutMs: 5_000 },
    inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    idempotency: "intrinsic",
  };
  const unsigned = {
    localId,
    kind,
    capabilityId: deriveMeshCapabilityId(NODE_ID, kind, localId),
    descriptor,
    descriptorSha256: computeMeshCapabilityDescriptorSha256(descriptor),
    permissionEnvelopeSha256: computeMeshCapabilityDescriptorSha256(descriptor.permissions),
  };
  return { ...unsigned, entrySha256: computeMeshCapabilityEntrySha256(unsigned) };
}

function buildManifest(
  publicationKey: string,
  entries: MeshCapabilityManifestEntry[],
  publicationLeaseFencingToken: number,
): MeshCapabilityManifest {
  const unsigned = {
    schemaVersion: MESH_CAPABILITY_MANIFEST_SCHEMA_VERSION,
    workspaceId: WORKSPACE,
    nodeId: NODE_ID,
    admissionGeneration: 1,
    publisherGeneration: 1,
    publicationKey,
    publicationLeaseFencingToken,
    entries,
    createdAt: "2026-07-14T12:00:00.000Z",
  };
  return { ...unsigned, manifestSha256: computeMeshCapabilityManifestSha256(unsigned) };
}

function activationInput(
  manifest: MeshCapabilityManifest,
  entry: MeshCapabilityManifestEntry,
  activationId: string,
): ActivateMeshCapabilityInput {
  return {
    workspaceId: WORKSPACE,
    activationId,
    activationRevision: 1,
    capabilityId: entry.capabilityId,
    nodeId: NODE_ID,
    publisherGeneration: manifest.publisherGeneration,
    healthGeneration: 1,
    publicationLeaseFencingToken: manifest.publicationLeaseFencingToken,
    manifestSha256: manifest.manifestSha256,
    entrySha256: entry.entrySha256,
    descriptorSha256: entry.descriptorSha256,
    permissionEnvelopeSha256: entry.permissionEnvelopeSha256,
    effectPosture: entry.descriptor.effectPosture,
    permissionDiff: {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentPermissionEnvelopeSha256: entry.permissionEnvelopeSha256,
      added: [],
      removed: [],
    },
    effectDiff: {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentEffectPosture: entry.descriptor.effectPosture,
    },
    approvalId: `approval-${activationId}`,
    actorId: "operator-a",
    sessionId: "session-a",
    turnId: "turn-a",
    idempotencyKey: `activate-${activationId}`,
  };
}

function insertApprovedApproval(db: DatabaseClient, input: ActivateMeshCapabilityInput): void {
  const requestSha256 = computeMeshCapabilityActivationRequestSha256(input);
  const approvalPayload = buildMeshCapabilityActivationApprovalPayload(input);
  assert.equal(approvalPayload.requestSha256, requestSha256);
  db.prepare(
    `
    INSERT INTO approvals (
      approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
      explanation_status, created_at, expires_at, resolved_at, resolved_by
    ) VALUES (
      @approvalId, 'mesh.capability.activate', 'high', 'approved', @linkageJson, @payloadJson, '{}',
      'not_requested', @createdAt, @expiresAt, @resolvedAt, 'operator-a'
    )
  `,
  ).run({
    approvalId: input.approvalId,
    linkageJson: JSON.stringify({ workspaceId: input.workspaceId, sessionId: input.sessionId, turnId: input.turnId }),
    payloadJson: canonicalJsonString(approvalPayload),
    createdAt: "2026-07-14T12:00:00.000Z",
    expiresAt: FUTURE,
    resolvedAt: "2026-07-14T12:00:00.000Z",
  });
}

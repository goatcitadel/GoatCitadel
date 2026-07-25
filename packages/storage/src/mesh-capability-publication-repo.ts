/* eslint-disable max-lines -- This established owner exceeds the line limit; decomposition belongs in a separate behavior-preserving tranche. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
  MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
  NotFoundError,
  assertMeshCallableKind,
  assertMeshCapabilityEffectDiff,
  assertMeshCapabilityManifest,
  assertMeshCapabilityPermissionDiff,
  canonicalJsonString,
  type MeshCapabilityActivationRecord,
  type MeshCapabilityActivationApprovalPayload,
  type MeshCapabilityActivationRevocationRecord,
  type MeshCapabilityEffectPosture,
  type MeshCapabilityInvocationIntentRecord,
  type MeshCapabilityInvocationSettlementRecord,
  type MeshCapabilityManifest,
  type MeshCapabilityManifestEntry,
  type MeshCapabilityEffectDiff,
  type MeshCapabilityPermissionDiff,
  type MeshCapabilityPermissionEnvelope,
  type MeshCapabilityPublisherGenerationRecord,
  type MeshCapabilityPublisherHealthRecord,
  type MeshCapabilityPublisherHealthStatus,
  type MeshCapabilitySettlementDisposition,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export interface RegisterMeshCapabilityPublisherInput {
  workspaceId: string;
  nodeId: string;
  admissionGeneration: number;
  publisherGeneration: number;
  tlsFingerprint?: string;
  mtlsRequired: boolean;
  publicationLeaseKey: string;
  publicationLeaseFencingToken: number;
  publicationLeaseExpiresAt: string;
  idempotencyKey: string;
}

export interface TransitionMeshCapabilityPublisherHealthInput {
  workspaceId: string;
  nodeId: string;
  publisherGeneration: number;
  expectedHealthGeneration: number;
  status: MeshCapabilityPublisherHealthStatus;
  publicationLeaseFencingToken: number;
  publicationLeaseExpiresAt: string;
  tlsFingerprint?: string;
}

export interface RefreshMeshCapabilityPublisherLeaseInput {
  workspaceId: string;
  nodeId: string;
  publisherGeneration: number;
  expectedHealthGeneration: number;
  publicationLeaseFencingToken: number;
  publicationLeaseExpiresAt: string;
}

export interface ActivateMeshCapabilityInput {
  workspaceId: string;
  activationId: string;
  activationRevision: number;
  capabilityId: string;
  nodeId: string;
  publisherGeneration: number;
  healthGeneration: number;
  publicationLeaseFencingToken: number;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  effectPosture: MeshCapabilityEffectPosture;
  permissionDiff: MeshCapabilityPermissionDiff;
  effectDiff: MeshCapabilityEffectDiff;
  approvalId: string;
  actorId: string;
  sessionId?: string;
  turnId?: string;
  idempotencyKey: string;
}

export interface RevokeMeshCapabilityActivationInput {
  workspaceId: string;
  activationId: string;
  reason: string;
  actorId: string;
  idempotencyKey: string;
}

export interface CreateMeshCapabilityInvocationIntentInput {
  workspaceId: string;
  invocationId: string;
  activationId: string;
  activationRevision: number;
  capabilityId: string;
  nodeId: string;
  publisherGeneration: number;
  healthGeneration: number;
  publicationLeaseFencingToken: number;
  manifestSha256: string;
  entrySha256: string;
  descriptorSha256: string;
  permissionEnvelopeSha256: string;
  executionProfileSha256: string;
  inputSha256: string;
  sessionId: string;
  turnId: string;
  runId?: string;
  approvalId?: string;
  deadlineAt: string;
  idempotencyKey: string;
}

export interface SettleMeshCapabilityInvocationInput {
  workspaceId: string;
  invocationId: string;
  disposition: MeshCapabilitySettlementDisposition;
  outputSha256?: string;
  errorCode?: string;
  settlementSha256: string;
  effectiveCostAttributionSha256?: string;
  publisherGeneration: number;
  publicationLeaseFencingToken: number;
  idempotencyKey: string;
}

interface PublisherRow {
  workspace_id: string;
  node_id: string;
  admission_generation: number | bigint | string;
  publisher_generation: number | bigint | string;
  mtls_required: number | bigint | string | boolean;
  tls_fingerprint: string | null;
  publication_lease_key: string;
  publication_lease_fencing_token: number | bigint | string;
  publication_lease_expires_at: string;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
}

interface HealthRow {
  workspace_id: string;
  node_id: string;
  publisher_generation: number | bigint | string;
  health_generation: number | bigint | string;
  status: string;
  publication_lease_fencing_token: number | bigint | string;
  publication_lease_expires_at: string;
  tls_fingerprint: string | null;
  updated_at: string;
}

interface ManifestRow {
  workspace_id: string;
  node_id: string;
  publisher_generation: number | bigint | string;
  publication_key: string;
  manifest_sha256: string;
  canonical_json: string;
  request_sha256: string;
}

interface ActivationRow {
  workspace_id: string;
  activation_id: string;
  activation_revision: number | bigint | string;
  capability_id: string;
  node_id: string;
  publisher_generation: number | bigint | string;
  health_generation: number | bigint | string;
  publication_lease_fencing_token: number | bigint | string;
  manifest_sha256: string;
  entry_sha256: string;
  descriptor_sha256: string;
  permission_envelope_sha256: string;
  effect_posture: string;
  permission_diff_json: string;
  effect_diff_json: string;
  approval_id: string;
  actor_id: string;
  session_id: string | null;
  turn_id: string | null;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
}

interface RevocationRow {
  workspace_id: string;
  activation_id: string;
  reason: string;
  actor_id: string;
  idempotency_key: string;
  request_sha256: string;
  revoked_at: string;
}

interface IntentRow {
  workspace_id: string;
  invocation_id: string;
  activation_id: string;
  activation_revision: number | bigint | string;
  capability_id: string;
  node_id: string;
  publisher_generation: number | bigint | string;
  health_generation: number | bigint | string;
  publication_lease_fencing_token: number | bigint | string;
  manifest_sha256: string;
  entry_sha256: string;
  descriptor_sha256: string;
  permission_envelope_sha256: string;
  execution_profile_sha256: string;
  input_sha256: string;
  session_id: string;
  turn_id: string;
  run_id: string | null;
  approval_id: string | null;
  deadline_at: string;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
}

interface SettlementRow {
  workspace_id: string;
  invocation_id: string;
  disposition: string;
  output_sha256: string | null;
  error_code: string | null;
  settlement_sha256: string;
  effective_cost_attribution_sha256: string | null;
  publisher_generation: number | bigint | string;
  publication_lease_fencing_token: number | bigint | string;
  idempotency_key: string;
  request_sha256: string;
  settled_at: string;
}

export class MeshCapabilityPublicationRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public registerPublisher(input: RegisterMeshCapabilityPublisherInput): MeshCapabilityPublisherGenerationRecord {
    const normalized = normalizePublisherInput(input);
    const requestSha256 = sha256(normalized);
    return this.db.transaction("immediate", () => {
      this.acquirePostgresAdmissionLocks(normalized.workspaceId, normalized.nodeId);
      const replay = this.findPublisherByIdempotency(normalized.workspaceId, normalized.idempotencyKey);
      if (replay) return assertReplay(replay, requestSha256, "publisher generation");
      const now = this.databaseNow();
      try {
        this.db
          .prepare(
            `
            INSERT INTO mesh_capability_publishers (
              workspace_id, node_id, admission_generation, publisher_generation, mtls_required, tls_fingerprint,
              publication_lease_key, publication_lease_fencing_token, publication_lease_expires_at,
              idempotency_key, request_sha256, created_at
            ) VALUES (
              @workspaceId, @nodeId, @admissionGeneration, @publisherGeneration, @mtlsRequired, @tlsFingerprint,
              @publicationLeaseKey, @publicationLeaseFencingToken, @publicationLeaseExpiresAt,
              @idempotencyKey, @requestSha256, @now
            )
          `,
          )
          .run({
            ...normalized,
            mtlsRequired: normalized.mtlsRequired ? 1 : 0,
            tlsFingerprint: normalized.tlsFingerprint ?? null,
            requestSha256,
            now,
          });
        this.db
          .prepare(
            `
            INSERT INTO mesh_capability_publisher_health (
              workspace_id, node_id, publisher_generation, health_generation, status,
              publication_lease_fencing_token, publication_lease_expires_at, tls_fingerprint, updated_at
            ) VALUES (
              @workspaceId, @nodeId, @publisherGeneration, 1, 'online',
              @publicationLeaseFencingToken, @publicationLeaseExpiresAt, @tlsFingerprint, @now
            )
          `,
          )
          .run({
            workspaceId: normalized.workspaceId,
            nodeId: normalized.nodeId,
            publisherGeneration: normalized.publisherGeneration,
            publicationLeaseFencingToken: normalized.publicationLeaseFencingToken,
            publicationLeaseExpiresAt: normalized.publicationLeaseExpiresAt,
            tlsFingerprint: normalized.tlsFingerprint ?? null,
            now,
          });
      } catch (error) {
        throw normalizeWriteError(error, "publisher generation");
      }
      return this.getPublisher(normalized.workspaceId, normalized.nodeId, normalized.publisherGeneration);
    });
  }

  public getPublisher(
    workspaceId: string,
    nodeId: string,
    publisherGeneration: number,
  ): MeshCapabilityPublisherGenerationRecord {
    const row = this.db
      .prepare(
        `
      SELECT * FROM mesh_capability_publishers
      WHERE workspace_id = @workspaceId AND node_id = @nodeId AND publisher_generation = @publisherGeneration
    `,
      )
      .get({ workspaceId, nodeId, publisherGeneration }) as PublisherRow | undefined;
    if (!row)
      throw new NotFoundError({
        entity: "mesh capability publisher generation",
        id: `${nodeId}:${publisherGeneration}`,
      });
    return mapPublisher(row);
  }

  /**
   * Resolves the highest committed publisher generation for one admitted node,
   * or undefined when the node has never registered a publisher generation in
   * this workspace. Storage keeps generations strictly monotonic, so MAX is the
   * current generation by construction.
   */
  public findCurrentPublisher(
    workspaceId: string,
    nodeId: string,
  ): MeshCapabilityPublisherGenerationRecord | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM mesh_capability_publishers
      WHERE workspace_id = @workspaceId AND node_id = @nodeId
        AND publisher_generation = (
          SELECT MAX(current.publisher_generation) FROM mesh_capability_publishers current
          WHERE current.workspace_id = @workspaceId AND current.node_id = @nodeId
        )
    `,
      )
      .get({ workspaceId: identifier(workspaceId, "workspaceId"), nodeId: identifier(nodeId, "nodeId") }) as
      | PublisherRow
      | undefined;
    return row ? mapPublisher(row) : undefined;
  }

  public getPublisherHealth(
    workspaceId: string,
    nodeId: string,
    publisherGeneration: number,
  ): MeshCapabilityPublisherHealthRecord {
    const row = this.db
      .prepare(
        `
      SELECT * FROM mesh_capability_publisher_health
      WHERE workspace_id = @workspaceId AND node_id = @nodeId AND publisher_generation = @publisherGeneration
    `,
      )
      .get({ workspaceId, nodeId, publisherGeneration }) as HealthRow | undefined;
    if (!row)
      throw new NotFoundError({ entity: "mesh capability publisher health", id: `${nodeId}:${publisherGeneration}` });
    return mapHealth(row);
  }

  public transitionPublisherHealth(
    input: TransitionMeshCapabilityPublisherHealthInput,
  ): MeshCapabilityPublisherHealthRecord {
    const normalized = {
      workspaceId: identifier(input.workspaceId, "workspaceId"),
      nodeId: identifier(input.nodeId, "nodeId"),
      publisherGeneration: positiveInteger(input.publisherGeneration, "publisherGeneration"),
      expectedHealthGeneration: positiveInteger(input.expectedHealthGeneration, "expectedHealthGeneration"),
      status: healthStatus(input.status),
      publicationLeaseFencingToken: positiveInteger(input.publicationLeaseFencingToken, "publicationLeaseFencingToken"),
      publicationLeaseExpiresAt: timestamp(input.publicationLeaseExpiresAt, "publicationLeaseExpiresAt"),
      tlsFingerprint: optionalIdentifier(input.tlsFingerprint, "tlsFingerprint"),
    };
    return this.db.transaction("immediate", () => {
      const now = this.databaseNow();
      let result;
      try {
        result = this.db
          .prepare(
            `
          UPDATE mesh_capability_publisher_health SET
            health_generation = health_generation + 1,
            status = @status,
            publication_lease_fencing_token = @publicationLeaseFencingToken,
            publication_lease_expires_at = @publicationLeaseExpiresAt,
            tls_fingerprint = @tlsFingerprint,
            updated_at = @now
          WHERE workspace_id = @workspaceId AND node_id = @nodeId
            AND publisher_generation = @publisherGeneration
            AND health_generation = @expectedHealthGeneration
        `,
          )
          .run({ ...normalized, tlsFingerprint: normalized.tlsFingerprint ?? null, now });
      } catch (error) {
        throw normalizeWriteError(error, "publisher health");
      }
      if (result.changes !== 1) throw conflict("Mesh capability publisher health CAS failed.");
      return this.getPublisherHealth(normalized.workspaceId, normalized.nodeId, normalized.publisherGeneration);
    });
  }

  public refreshPublisherLease(input: RefreshMeshCapabilityPublisherLeaseInput): MeshCapabilityPublisherHealthRecord {
    const normalized = {
      workspaceId: identifier(input.workspaceId, "workspaceId"),
      nodeId: identifier(input.nodeId, "nodeId"),
      publisherGeneration: positiveInteger(input.publisherGeneration, "publisherGeneration"),
      expectedHealthGeneration: positiveInteger(input.expectedHealthGeneration, "expectedHealthGeneration"),
      publicationLeaseFencingToken: positiveInteger(input.publicationLeaseFencingToken, "publicationLeaseFencingToken"),
      publicationLeaseExpiresAt: timestamp(input.publicationLeaseExpiresAt, "publicationLeaseExpiresAt"),
    };
    return this.db.transaction("immediate", () => {
      let result;
      try {
        result = this.db
          .prepare(
            `
            UPDATE mesh_capability_publisher_health SET
              publication_lease_expires_at = @publicationLeaseExpiresAt,
              updated_at = @now
            WHERE workspace_id = @workspaceId AND node_id = @nodeId
              AND publisher_generation = @publisherGeneration
              AND health_generation = @expectedHealthGeneration
              AND status = 'online'
              AND publication_lease_fencing_token = @publicationLeaseFencingToken
          `,
          )
          .run({ ...normalized, now: this.databaseNow() });
      } catch (error) {
        throw normalizeWriteError(error, "publisher lease refresh");
      }
      if (result.changes !== 1) throw conflict("Mesh capability publisher lease refresh CAS failed.");
      return this.getPublisherHealth(normalized.workspaceId, normalized.nodeId, normalized.publisherGeneration);
    });
  }

  public publishManifest(manifest: MeshCapabilityManifest): MeshCapabilityManifest {
    assertManifestDigests(manifest);
    const canonicalJson = canonicalJsonString(manifest);
    const requestSha256 = sha256(manifest);
    return this.db.transaction("immediate", () => {
      const replay = this.findManifestByPublicationKey(manifest.workspaceId, manifest.publicationKey);
      if (replay) return assertManifestReplay(replay, requestSha256);
      try {
        this.db
          .prepare(
            `
          INSERT INTO mesh_capability_manifests (
            workspace_id, node_id, admission_generation, publisher_generation, publication_key,
            publication_lease_fencing_token, manifest_sha256,
            supersedes_manifest_sha256, schema_version, entry_count, canonical_json, request_sha256, created_at
          ) VALUES (
            @workspaceId, @nodeId, @admissionGeneration, @publisherGeneration, @publicationKey,
            @publicationLeaseFencingToken, @manifestSha256,
            @supersedesManifestSha256, @schemaVersion, @entryCount, @canonicalJson, @requestSha256, @createdAt
          )
        `,
          )
          .run({
            workspaceId: manifest.workspaceId,
            nodeId: manifest.nodeId,
            admissionGeneration: manifest.admissionGeneration,
            publisherGeneration: manifest.publisherGeneration,
            publicationKey: manifest.publicationKey,
            publicationLeaseFencingToken: manifest.publicationLeaseFencingToken,
            manifestSha256: manifest.manifestSha256,
            supersedesManifestSha256: manifest.supersedesManifestSha256 ?? null,
            schemaVersion: manifest.schemaVersion,
            entryCount: manifest.entries.length,
            canonicalJson,
            requestSha256,
            createdAt: manifest.createdAt,
          });
        const insertEntry = this.db.prepare(`
          INSERT INTO mesh_capability_manifest_entries (
            workspace_id, node_id, publisher_generation, manifest_sha256, capability_id, local_id, kind,
            descriptor_sha256, permission_envelope_sha256, entry_sha256, effect_posture, canonical_json
          ) VALUES (
            @workspaceId, @nodeId, @publisherGeneration, @manifestSha256, @capabilityId, @localId, @kind,
            @descriptorSha256, @permissionEnvelopeSha256, @entrySha256, @effectPosture, @canonicalJson
          )
        `);
        for (const entry of manifest.entries) {
          insertEntry.run({
            workspaceId: manifest.workspaceId,
            nodeId: manifest.nodeId,
            publisherGeneration: manifest.publisherGeneration,
            manifestSha256: manifest.manifestSha256,
            capabilityId: entry.capabilityId,
            localId: entry.localId,
            kind: entry.kind,
            descriptorSha256: entry.descriptorSha256,
            permissionEnvelopeSha256: entry.permissionEnvelopeSha256,
            entrySha256: entry.entrySha256,
            effectPosture: entry.descriptor.effectPosture,
            canonicalJson: canonicalJsonString(entry),
          });
        }
        const countRow = this.db
          .prepare(
            `
          SELECT COUNT(*) AS count FROM mesh_capability_manifest_entries
          WHERE workspace_id = @workspaceId AND node_id = @nodeId
            AND publisher_generation = @publisherGeneration AND manifest_sha256 = @manifestSha256
        `,
          )
          .get({
            workspaceId: manifest.workspaceId,
            nodeId: manifest.nodeId,
            publisherGeneration: manifest.publisherGeneration,
            manifestSha256: manifest.manifestSha256,
          }) as { count: number | bigint | string };
        const count = Number(countRow.count);
        if (count !== manifest.entries.length)
          throw conflict("Mesh capability manifest entry set was not stored atomically.");
      } catch (error) {
        throw normalizeWriteError(error, "manifest");
      }
      return this.getManifest(
        manifest.workspaceId,
        manifest.nodeId,
        manifest.publisherGeneration,
        manifest.manifestSha256,
      );
    });
  }

  /**
   * Resolves the immutable manifest bound to one workspace-scoped publication
   * key, or undefined when the key has never been used. The stored canonical
   * bytes and digests are re-verified on read exactly like `getManifest`.
   */
  public getManifestByPublicationKey(workspaceId: string, publicationKey: string): MeshCapabilityManifest | undefined {
    return this.findManifestByPublicationKey(
      identifier(workspaceId, "workspaceId"),
      identifier(publicationKey, "publicationKey", 512),
    )?.manifest;
  }

  /**
   * Lists immutable manifests for one workspace (optionally one node), newest
   * first, annotating each with the digest of the manifest that supersedes it
   * within the same publisher generation when one exists. Read-only projection
   * input; every canonical byte and digest is re-verified on read.
   */
  public listManifestRecords(
    workspaceId: string,
    options: { nodeId?: string; limit?: number } = {},
  ): Array<{ manifest: MeshCapabilityManifest; supersededByManifestSha256?: string }> {
    const normalized = {
      workspaceId: identifier(workspaceId, "workspaceId"),
      nodeId: options.nodeId === undefined ? undefined : identifier(options.nodeId, "nodeId"),
      limit: boundedLimit(options.limit),
    };
    const rows = this.db
      .prepare(
        `
      SELECT manifest.*, (
        SELECT child.manifest_sha256 FROM mesh_capability_manifests child
        WHERE child.workspace_id = manifest.workspace_id AND child.node_id = manifest.node_id
          AND child.publisher_generation = manifest.publisher_generation
          AND child.supersedes_manifest_sha256 = manifest.manifest_sha256
      ) AS superseded_by_manifest_sha256
      FROM mesh_capability_manifests manifest
      WHERE manifest.workspace_id = @workspaceId
        AND (@nodeId IS NULL OR manifest.node_id = @nodeId)
      ORDER BY manifest.created_at DESC, manifest.manifest_sha256 DESC
      LIMIT @limit
    `,
      )
      .all({
        workspaceId: normalized.workspaceId,
        nodeId: normalized.nodeId ?? null,
        limit: normalized.limit,
      }) as Array<ManifestRow & { superseded_by_manifest_sha256: string | null }>;
    return rows.map((row) => ({
      manifest: parseManifest(row),
      ...(row.superseded_by_manifest_sha256 === null
        ? {}
        : { supersededByManifestSha256: row.superseded_by_manifest_sha256 }),
    }));
  }

  public getManifest(
    workspaceId: string,
    nodeId: string,
    publisherGeneration: number,
    manifestSha256: string,
  ): MeshCapabilityManifest {
    const row = this.db
      .prepare(
        `
      SELECT * FROM mesh_capability_manifests
      WHERE workspace_id = @workspaceId AND node_id = @nodeId
        AND publisher_generation = @publisherGeneration AND manifest_sha256 = @manifestSha256
    `,
      )
      .get({ workspaceId, nodeId, publisherGeneration, manifestSha256 }) as ManifestRow | undefined;
    if (!row) throw new NotFoundError({ entity: "mesh capability manifest", id: manifestSha256 });
    return parseManifest(row);
  }

  public activate(input: ActivateMeshCapabilityInput): MeshCapabilityActivationRecord {
    const normalized = normalizeActivationInput(input);
    const requestSha256 = computeMeshCapabilityActivationRequestSha256(normalized);
    return this.db.transaction("immediate", () => {
      const prior = assertPriorActivationDiffBinding(this, normalized);
      assertExactActivationDiffs(this, normalized, prior);
      const replay = this.findActivationByIdempotency(normalized.workspaceId, normalized.idempotencyKey);
      if (replay) return assertReplay(replay, requestSha256, "activation");
      try {
        this.db
          .prepare(
            `
          INSERT INTO mesh_capability_activations (
            workspace_id, activation_id, activation_revision, capability_id, node_id, publisher_generation, health_generation,
            publication_lease_fencing_token, manifest_sha256, entry_sha256, descriptor_sha256, permission_envelope_sha256,
            effect_posture, permission_diff_json, effect_diff_json, approval_id, actor_id, session_id, turn_id,
            idempotency_key, request_sha256, created_at
          ) VALUES (
            @workspaceId, @activationId, @activationRevision, @capabilityId, @nodeId, @publisherGeneration, @healthGeneration,
            @publicationLeaseFencingToken, @manifestSha256, @entrySha256, @descriptorSha256, @permissionEnvelopeSha256,
            @effectPosture, @permissionDiffJson, @effectDiffJson, @approvalId, @actorId, @sessionId, @turnId,
            @idempotencyKey, @requestSha256, @createdAt
          )
        `,
          )
          .run({
            workspaceId: normalized.workspaceId,
            activationId: normalized.activationId,
            activationRevision: normalized.activationRevision,
            capabilityId: normalized.capabilityId,
            nodeId: normalized.nodeId,
            publisherGeneration: normalized.publisherGeneration,
            healthGeneration: normalized.healthGeneration,
            publicationLeaseFencingToken: normalized.publicationLeaseFencingToken,
            manifestSha256: normalized.manifestSha256,
            entrySha256: normalized.entrySha256,
            descriptorSha256: normalized.descriptorSha256,
            permissionEnvelopeSha256: normalized.permissionEnvelopeSha256,
            effectPosture: normalized.effectPosture,
            permissionDiffJson: canonicalJsonString(normalized.permissionDiff),
            effectDiffJson: canonicalJsonString(normalized.effectDiff),
            approvalId: normalized.approvalId,
            actorId: normalized.actorId,
            sessionId: normalized.sessionId ?? null,
            turnId: normalized.turnId ?? null,
            idempotencyKey: normalized.idempotencyKey,
            requestSha256,
            createdAt: this.databaseNow(),
          });
      } catch (error) {
        throw normalizeWriteError(error, "activation");
      }
      return this.getActivation(normalized.workspaceId, normalized.activationId);
    });
  }

  public getActivation(workspaceId: string, activationId: string): MeshCapabilityActivationRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_activations WHERE workspace_id = @workspaceId AND activation_id = @activationId`,
      )
      .get({ workspaceId, activationId }) as ActivationRow | undefined;
    if (!row) throw new NotFoundError({ entity: "mesh capability activation", id: activationId });
    return mapActivation(row);
  }

  /** Highest-revision activation for one derived capability ID, revoked or not. */
  public findLatestActivation(workspaceId: string, capabilityId: string): MeshCapabilityActivationRecord | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM mesh_capability_activations
      WHERE workspace_id = @workspaceId AND capability_id = @capabilityId
      ORDER BY activation_revision DESC
      LIMIT 1
    `,
      )
      .get({
        workspaceId: identifier(workspaceId, "workspaceId"),
        capabilityId: identifier(capabilityId, "capabilityId", 512),
      }) as ActivationRow | undefined;
    return row ? mapActivation(row) : undefined;
  }

  /** Immutable revocation evidence for one activation, if any. */
  public findActivationRevocation(
    workspaceId: string,
    activationId: string,
  ): MeshCapabilityActivationRevocationRecord | undefined {
    return this.findRevocation(identifier(workspaceId, "workspaceId"), identifier(activationId, "activationId"));
  }

  public revoke(input: RevokeMeshCapabilityActivationInput): MeshCapabilityActivationRevocationRecord {
    const normalized = {
      workspaceId: identifier(input.workspaceId, "workspaceId"),
      activationId: identifier(input.activationId, "activationId"),
      reason: text(input.reason, "reason", 2_000),
      actorId: identifier(input.actorId, "actorId"),
      idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
    };
    const requestSha256 = sha256(normalized);
    return this.db.transaction("immediate", () => {
      const replay = this.findRevocation(normalized.workspaceId, normalized.activationId);
      if (replay) return assertReplay(replay, requestSha256, "activation revocation");
      try {
        this.db
          .prepare(
            `
          INSERT INTO mesh_capability_activation_revocations (
            workspace_id, activation_id, reason, actor_id, idempotency_key, request_sha256, revoked_at
          ) VALUES (@workspaceId, @activationId, @reason, @actorId, @idempotencyKey, @requestSha256, @revokedAt)
        `,
          )
          .run({ ...normalized, requestSha256, revokedAt: this.databaseNow() });
      } catch (error) {
        throw normalizeWriteError(error, "activation revocation");
      }
      return this.findRevocation(normalized.workspaceId, normalized.activationId)!;
    });
  }

  public createInvocationIntent(
    input: CreateMeshCapabilityInvocationIntentInput,
  ): MeshCapabilityInvocationIntentRecord {
    const normalized = normalizeIntentInput(input);
    const requestSha256 = sha256(normalized);
    return this.db.transaction("immediate", () => {
      const replay = this.findIntentByIdempotency(normalized.workspaceId, normalized.idempotencyKey);
      if (replay) return assertReplay(replay, requestSha256, "invocation intent");
      try {
        this.db
          .prepare(
            `
          INSERT INTO mesh_capability_invocation_intents (
            workspace_id, invocation_id, activation_id, activation_revision, capability_id, node_id, publisher_generation,
            health_generation, publication_lease_fencing_token, manifest_sha256, entry_sha256, descriptor_sha256,
            permission_envelope_sha256, execution_profile_sha256, input_sha256, session_id, turn_id, run_id, approval_id, deadline_at,
            idempotency_key, request_sha256, created_at
          ) VALUES (
            @workspaceId, @invocationId, @activationId, @activationRevision, @capabilityId, @nodeId, @publisherGeneration,
            @healthGeneration, @publicationLeaseFencingToken, @manifestSha256, @entrySha256, @descriptorSha256,
            @permissionEnvelopeSha256, @executionProfileSha256, @inputSha256, @sessionId, @turnId, @runId, @approvalId, @deadlineAt,
            @idempotencyKey, @requestSha256, @createdAt
          )
        `,
          )
          .run({
            ...normalized,
            runId: normalized.runId ?? null,
            approvalId: normalized.approvalId ?? null,
            requestSha256,
            createdAt: this.databaseNow(),
          });
      } catch (error) {
        throw normalizeWriteError(error, "invocation intent");
      }
      return this.getInvocationIntent(normalized.workspaceId, normalized.invocationId);
    });
  }

  public getInvocationIntent(workspaceId: string, invocationId: string): MeshCapabilityInvocationIntentRecord {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_invocation_intents WHERE workspace_id = @workspaceId AND invocation_id = @invocationId`,
      )
      .get({ workspaceId, invocationId }) as IntentRow | undefined;
    if (!row) throw new NotFoundError({ entity: "mesh capability invocation intent", id: invocationId });
    return mapIntent(row);
  }

  /** Non-throwing read of one immutable invocation intent. */
  public findInvocationIntent(
    workspaceId: string,
    invocationId: string,
  ): MeshCapabilityInvocationIntentRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_invocation_intents WHERE workspace_id = @workspaceId AND invocation_id = @invocationId`,
      )
      .get({
        workspaceId: identifier(workspaceId, "workspaceId"),
        invocationId: identifier(invocationId, "invocationId"),
      }) as IntentRow | undefined;
    return row ? mapIntent(row) : undefined;
  }

  /** Non-throwing read of the ONE immutable terminal settlement, when present. */
  public findInvocationSettlement(
    workspaceId: string,
    invocationId: string,
  ): MeshCapabilityInvocationSettlementRecord | undefined {
    return this.findSettlement(identifier(workspaceId, "workspaceId"), identifier(invocationId, "invocationId"));
  }

  /**
   * Invocation intents whose bounded deadline has passed on the database
   * clock without any terminal settlement. This is the storage-truth recovery
   * projection: a restarted Gateway (or the next dispatch) settles these to a
   * bounded terminal state instead of leaving them open forever.
   */
  public listUnsettledExpiredInvocationIntents(
    workspaceId: string,
    limit?: number,
  ): MeshCapabilityInvocationIntentRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT intent.* FROM mesh_capability_invocation_intents intent
      WHERE intent.workspace_id = @workspaceId
        AND intent.deadline_at <= @now
        AND NOT EXISTS (
          SELECT 1 FROM mesh_capability_invocation_settlements settlement
          WHERE settlement.workspace_id = intent.workspace_id AND settlement.invocation_id = intent.invocation_id
        )
      ORDER BY intent.deadline_at ASC, intent.invocation_id ASC
      LIMIT @limit
    `,
      )
      .all({
        workspaceId: identifier(workspaceId, "workspaceId"),
        now: this.databaseNow(),
        limit: boundedLimit(limit, 64, 256),
      }) as IntentRow[];
    return rows.map(mapIntent);
  }

  public settleInvocation(input: SettleMeshCapabilityInvocationInput): MeshCapabilityInvocationSettlementRecord {
    const normalized = normalizeSettlementInput(input);
    const requestSha256 = sha256(normalized);
    return this.db.transaction("immediate", () => {
      const replay = this.findSettlement(normalized.workspaceId, normalized.invocationId);
      if (replay) return assertReplay(replay, requestSha256, "invocation settlement");
      try {
        this.db
          .prepare(
            `
          INSERT INTO mesh_capability_invocation_settlements (
            workspace_id, invocation_id, disposition, output_sha256, error_code, settlement_sha256,
            effective_cost_attribution_sha256, publisher_generation, publication_lease_fencing_token,
            idempotency_key, request_sha256, settled_at
          ) VALUES (
            @workspaceId, @invocationId, @disposition, @outputSha256, @errorCode, @settlementSha256,
            @effectiveCostAttributionSha256, @publisherGeneration, @publicationLeaseFencingToken,
            @idempotencyKey, @requestSha256, @settledAt
          )
        `,
          )
          .run({
            ...normalized,
            outputSha256: normalized.outputSha256 ?? null,
            errorCode: normalized.errorCode ?? null,
            effectiveCostAttributionSha256: normalized.effectiveCostAttributionSha256 ?? null,
            requestSha256,
            settledAt: this.databaseNow(),
          });
      } catch (error) {
        throw normalizeWriteError(error, "invocation settlement");
      }
      return this.findSettlement(normalized.workspaceId, normalized.invocationId)!;
    });
  }

  public listCallableActivations(workspaceId: string): MeshCapabilityActivationRecord[] {
    const now = this.databaseNow();
    const rows = this.db
      .prepare(
        `
      SELECT activation.*
      FROM mesh_capability_activations activation
      JOIN mesh_capability_publishers publisher
        ON publisher.workspace_id = activation.workspace_id AND publisher.node_id = activation.node_id
       AND publisher.publisher_generation = activation.publisher_generation
      JOIN mesh_capability_node_admissions admission
        ON admission.workspace_id = publisher.workspace_id AND admission.node_id = publisher.node_id
       AND admission.admission_generation = publisher.admission_generation
      JOIN mesh_capability_publisher_health health
        ON health.workspace_id = activation.workspace_id AND health.node_id = activation.node_id
       AND health.publisher_generation = activation.publisher_generation
      JOIN mesh_nodes node ON node.node_id = activation.node_id
      JOIN mesh_leases lease ON lease.lease_key = publisher.publication_lease_key
      WHERE activation.workspace_id = @workspaceId
        AND activation.activation_revision = (SELECT MAX(latest.activation_revision)
          FROM mesh_capability_activations latest
          WHERE latest.workspace_id = activation.workspace_id AND latest.capability_id = activation.capability_id)
        AND NOT EXISTS (SELECT 1 FROM mesh_capability_activation_revocations revoked
                        WHERE revoked.workspace_id = activation.workspace_id AND revoked.activation_id = activation.activation_id)
        AND NOT EXISTS (SELECT 1 FROM mesh_capability_manifests child
                        WHERE child.workspace_id = activation.workspace_id AND child.node_id = activation.node_id
                          AND child.publisher_generation = activation.publisher_generation
                          AND child.supersedes_manifest_sha256 = activation.manifest_sha256)
        AND health.status = 'online' AND health.health_generation = activation.health_generation
        AND health.publication_lease_fencing_token = activation.publication_lease_fencing_token
        AND publisher.publication_lease_fencing_token = activation.publication_lease_fencing_token
        AND admission.mtls_required = publisher.mtls_required
        AND (
          admission.tls_fingerprint = publisher.tls_fingerprint
          OR (admission.tls_fingerprint IS NULL AND publisher.tls_fingerprint IS NULL)
        )
        AND admission.admission_generation = (
          SELECT MAX(current_admission.admission_generation)
          FROM mesh_capability_node_admissions current_admission
          WHERE current_admission.workspace_id = admission.workspace_id
            AND current_admission.node_id = admission.node_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM mesh_capability_node_admission_revocations admission_revocation
          WHERE admission_revocation.workspace_id = admission.workspace_id
            AND admission_revocation.node_id = admission.node_id
            AND admission_revocation.admission_generation = admission.admission_generation
        )
        AND health.publication_lease_expires_at > @now
        AND activation.publisher_generation = (SELECT MAX(current.publisher_generation)
          FROM mesh_capability_publishers current
          WHERE current.workspace_id = activation.workspace_id AND current.node_id = activation.node_id)
        AND node.status = 'online'
        AND (publisher.mtls_required = 0 OR (
          node.tls_fingerprint = health.tls_fingerprint
          AND publisher.tls_fingerprint = health.tls_fingerprint
        ))
        AND lease.holder_node_id = activation.node_id
        AND lease.fencing_token = activation.publication_lease_fencing_token AND lease.expires_at > @now
      ORDER BY activation.created_at DESC, activation.activation_id DESC
      LIMIT 256
    `,
      )
      .all({ workspaceId: identifier(workspaceId, "workspaceId"), now }) as ActivationRow[];
    return rows.map(mapActivation);
  }

  private databaseNow(): string {
    const sql =
      this.db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`;
    const row = this.db.prepare(sql).get() as { now?: string } | undefined;
    if (!row?.now) throw new Error("Database clock did not return a timestamp.");
    return row.now;
  }

  private acquirePostgresAdmissionLocks(workspaceId: string, nodeId: string): void {
    if (this.db.dialect !== "postgres") return;
    this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@workspaceId, 411)) AS locked").get({ workspaceId });
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(@workspaceId || ':' || @nodeId, 412)) AS locked")
      .get({ workspaceId, nodeId });
  }

  private findPublisherByIdempotency(workspaceId: string, idempotencyKey: string) {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_publishers WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ workspaceId, idempotencyKey }) as PublisherRow | undefined;
    return row ? mapPublisher(row) : undefined;
  }

  private findManifestByPublicationKey(
    workspaceId: string,
    publicationKey: string,
  ): { manifest: MeshCapabilityManifest; requestSha256: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_manifests WHERE workspace_id = @workspaceId AND publication_key = @publicationKey`,
      )
      .get({ workspaceId, publicationKey }) as ManifestRow | undefined;
    return row ? { manifest: parseManifest(row), requestSha256: row.request_sha256 } : undefined;
  }

  private findActivationByIdempotency(workspaceId: string, idempotencyKey: string) {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_activations WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ workspaceId, idempotencyKey }) as ActivationRow | undefined;
    return row ? mapActivation(row) : undefined;
  }

  private findRevocation(workspaceId: string, activationId: string) {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_activation_revocations WHERE workspace_id = @workspaceId AND activation_id = @activationId`,
      )
      .get({ workspaceId, activationId }) as RevocationRow | undefined;
    return row ? mapRevocation(row) : undefined;
  }

  private findIntentByIdempotency(workspaceId: string, idempotencyKey: string) {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_invocation_intents WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey`,
      )
      .get({ workspaceId, idempotencyKey }) as IntentRow | undefined;
    return row ? mapIntent(row) : undefined;
  }

  private findSettlement(workspaceId: string, invocationId: string) {
    const row = this.db
      .prepare(
        `SELECT * FROM mesh_capability_invocation_settlements WHERE workspace_id = @workspaceId AND invocation_id = @invocationId`,
      )
      .get({ workspaceId, invocationId }) as SettlementRow | undefined;
    return row ? mapSettlement(row) : undefined;
  }
}

export function computeMeshCapabilityManifestSha256(manifest: Omit<MeshCapabilityManifest, "manifestSha256">): string {
  return sha256(manifest);
}

export function computeMeshCapabilityDescriptorSha256(value: unknown): string {
  return sha256(value);
}

export function computeMeshCapabilityEntrySha256(entry: Omit<MeshCapabilityManifestEntry, "entrySha256">): string {
  return sha256(entry);
}

export function computeMeshCapabilityActivationRequestSha256(input: ActivateMeshCapabilityInput): string {
  return sha256(normalizeActivationInput(input));
}

/**
 * Builds the ONE exact permission/effect diff pair the storage activation
 * guard will accept for `currentEntry` against its optional prior activation.
 * This is the same computation `activate()` re-verifies inside its
 * transaction (`assertExactActivationDiffs`), exported so governed request
 * owners surface — never re-implement — the storage-owned diff truth.
 */
export function buildMeshCapabilityActivationDiffs(input: {
  currentEntry: MeshCapabilityManifestEntry;
  prior?: { activation: MeshCapabilityActivationRecord; entry: MeshCapabilityManifestEntry };
}): { permissionDiff: MeshCapabilityPermissionDiff; effectDiff: MeshCapabilityEffectDiff } {
  const permissionDiff = exactPermissionDiff(
    input.prior?.entry.descriptor.permissions,
    input.currentEntry.descriptor.permissions,
    input.prior?.activation,
  );
  const effectDiff = exactEffectDiff(
    input.prior?.entry.descriptor.effectPosture,
    input.currentEntry.descriptor.effectPosture,
    input.prior?.activation,
  );
  return { permissionDiff, effectDiff };
}

export function buildMeshCapabilityActivationApprovalPayload(
  input: ActivateMeshCapabilityInput,
): MeshCapabilityActivationApprovalPayload {
  const normalized = normalizeActivationInput(input);
  return {
    workspaceId: normalized.workspaceId,
    activationId: normalized.activationId,
    activationRevision: normalized.activationRevision,
    requestSha256: sha256(normalized),
    capabilityId: normalized.capabilityId,
    manifestSha256: normalized.manifestSha256,
    entrySha256: normalized.entrySha256,
    descriptorSha256: normalized.descriptorSha256,
    permissionEnvelopeSha256: normalized.permissionEnvelopeSha256,
    effectPosture: normalized.effectPosture,
  };
}

function assertManifestDigests(manifest: MeshCapabilityManifest): void {
  assertMeshCapabilityManifest(manifest);
  const { manifestSha256, ...unsigned } = manifest;
  if (computeMeshCapabilityManifestSha256(unsigned) !== manifestSha256)
    throw new TypeError("Mesh capability manifest digest does not match canonical bytes.");
  for (const entry of manifest.entries) {
    if (computeMeshCapabilityDescriptorSha256(entry.descriptor) !== entry.descriptorSha256)
      throw new TypeError(`Mesh capability descriptor digest mismatch for ${entry.capabilityId}.`);
    if (computeMeshCapabilityDescriptorSha256(entry.descriptor.permissions) !== entry.permissionEnvelopeSha256)
      throw new TypeError(`Mesh capability permission envelope digest mismatch for ${entry.capabilityId}.`);
    const { entrySha256, ...unsignedEntry } = entry;
    if (computeMeshCapabilityEntrySha256(unsignedEntry) !== entrySha256)
      throw new TypeError(`Mesh capability entry digest mismatch for ${entry.capabilityId}.`);
  }
}

function normalizePublisherInput(input: RegisterMeshCapabilityPublisherInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    nodeId: identifier(input.nodeId, "nodeId"),
    admissionGeneration: positiveInteger(input.admissionGeneration, "admissionGeneration"),
    publisherGeneration: positiveInteger(input.publisherGeneration, "publisherGeneration"),
    tlsFingerprint: optionalIdentifier(input.tlsFingerprint, "tlsFingerprint"),
    mtlsRequired: booleanValue(input.mtlsRequired, "mtlsRequired"),
    publicationLeaseKey: identifier(input.publicationLeaseKey, "publicationLeaseKey"),
    publicationLeaseFencingToken: positiveInteger(input.publicationLeaseFencingToken, "publicationLeaseFencingToken"),
    publicationLeaseExpiresAt: timestamp(input.publicationLeaseExpiresAt, "publicationLeaseExpiresAt"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function normalizeActivationInput(input: ActivateMeshCapabilityInput): ActivateMeshCapabilityInput {
  assertMeshCapabilityPermissionDiff(input.permissionDiff, input.permissionEnvelopeSha256);
  assertMeshCapabilityEffectDiff(input.effectDiff, input.effectPosture);
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    activationId: identifier(input.activationId, "activationId"),
    activationRevision: positiveInteger(input.activationRevision, "activationRevision"),
    capabilityId: identifier(input.capabilityId, "capabilityId", 512),
    nodeId: identifier(input.nodeId, "nodeId"),
    publisherGeneration: positiveInteger(input.publisherGeneration, "publisherGeneration"),
    healthGeneration: positiveInteger(input.healthGeneration, "healthGeneration"),
    publicationLeaseFencingToken: positiveInteger(input.publicationLeaseFencingToken, "publicationLeaseFencingToken"),
    manifestSha256: digest(input.manifestSha256, "manifestSha256"),
    entrySha256: digest(input.entrySha256, "entrySha256"),
    descriptorSha256: digest(input.descriptorSha256, "descriptorSha256"),
    permissionEnvelopeSha256: digest(input.permissionEnvelopeSha256, "permissionEnvelopeSha256"),
    effectPosture: effect(input.effectPosture),
    permissionDiff: input.permissionDiff,
    effectDiff: input.effectDiff,
    approvalId: identifier(input.approvalId, "approvalId"),
    actorId: identifier(input.actorId, "actorId"),
    sessionId: optionalIdentifier(input.sessionId, "sessionId"),
    turnId: optionalIdentifier(input.turnId, "turnId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function normalizeIntentInput(
  input: CreateMeshCapabilityInvocationIntentInput,
): CreateMeshCapabilityInvocationIntentInput {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    invocationId: identifier(input.invocationId, "invocationId"),
    activationId: identifier(input.activationId, "activationId"),
    activationRevision: positiveInteger(input.activationRevision, "activationRevision"),
    capabilityId: identifier(input.capabilityId, "capabilityId", 512),
    nodeId: identifier(input.nodeId, "nodeId"),
    publisherGeneration: positiveInteger(input.publisherGeneration, "publisherGeneration"),
    healthGeneration: positiveInteger(input.healthGeneration, "healthGeneration"),
    publicationLeaseFencingToken: positiveInteger(input.publicationLeaseFencingToken, "publicationLeaseFencingToken"),
    manifestSha256: digest(input.manifestSha256, "manifestSha256"),
    entrySha256: digest(input.entrySha256, "entrySha256"),
    descriptorSha256: digest(input.descriptorSha256, "descriptorSha256"),
    permissionEnvelopeSha256: digest(input.permissionEnvelopeSha256, "permissionEnvelopeSha256"),
    inputSha256: digest(input.inputSha256, "inputSha256"),
    executionProfileSha256: digest(input.executionProfileSha256, "executionProfileSha256"),
    sessionId: identifier(input.sessionId, "sessionId"),
    turnId: identifier(input.turnId, "turnId"),
    runId: optionalIdentifier(input.runId, "runId"),
    approvalId: optionalIdentifier(input.approvalId, "approvalId"),
    deadlineAt: timestamp(input.deadlineAt, "deadlineAt"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function normalizeSettlementInput(input: SettleMeshCapabilityInvocationInput): SettleMeshCapabilityInvocationInput {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    invocationId: identifier(input.invocationId, "invocationId"),
    disposition: settlementDisposition(input.disposition),
    outputSha256: input.outputSha256 === undefined ? undefined : digest(input.outputSha256, "outputSha256"),
    errorCode: input.errorCode === undefined ? undefined : identifier(input.errorCode, "errorCode"),
    settlementSha256: digest(input.settlementSha256, "settlementSha256"),
    effectiveCostAttributionSha256:
      input.effectiveCostAttributionSha256 === undefined
        ? undefined
        : digest(input.effectiveCostAttributionSha256, "effectiveCostAttributionSha256"),
    publisherGeneration: positiveInteger(input.publisherGeneration, "publisherGeneration"),
    publicationLeaseFencingToken: positiveInteger(input.publicationLeaseFencingToken, "publicationLeaseFencingToken"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey", 512),
  };
}

function mapPublisher(row: PublisherRow): MeshCapabilityPublisherGenerationRecord {
  return {
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    admissionGeneration: Number(row.admission_generation),
    publisherGeneration: Number(row.publisher_generation),
    ...(row.tls_fingerprint === null ? {} : { tlsFingerprint: row.tls_fingerprint }),
    mtlsRequired: Number(row.mtls_required) === 1,
    publicationLeaseKey: row.publication_lease_key,
    publicationLeaseFencingToken: Number(row.publication_lease_fencing_token),
    publicationLeaseExpiresAt: row.publication_lease_expires_at,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    createdAt: row.created_at,
  };
}

function mapHealth(row: HealthRow): MeshCapabilityPublisherHealthRecord {
  return {
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    publisherGeneration: Number(row.publisher_generation),
    healthGeneration: Number(row.health_generation),
    status: row.status as MeshCapabilityPublisherHealthStatus,
    publicationLeaseFencingToken: Number(row.publication_lease_fencing_token),
    publicationLeaseExpiresAt: row.publication_lease_expires_at,
    ...(row.tls_fingerprint === null ? {} : { tlsFingerprint: row.tls_fingerprint }),
    updatedAt: row.updated_at,
  };
}

function parseManifest(row: ManifestRow): MeshCapabilityManifest {
  const value = safeJsonParse<MeshCapabilityManifest | undefined>(row.canonical_json, undefined);
  if (!value || canonicalJsonString(value) !== row.canonical_json)
    throw new Error(`Mesh capability manifest ${row.manifest_sha256} contains non-canonical JSON.`);
  assertManifestDigests(value);
  return value;
}

function mapActivation(row: ActivationRow): MeshCapabilityActivationRecord {
  const permissionDiff = parseCanonicalObject(
    row.permission_diff_json,
    "permission diff",
  ) as unknown as MeshCapabilityPermissionDiff;
  const effectDiff = parseCanonicalObject(row.effect_diff_json, "effect diff") as unknown as MeshCapabilityEffectDiff;
  assertMeshCapabilityPermissionDiff(permissionDiff, row.permission_envelope_sha256);
  assertMeshCapabilityEffectDiff(effectDiff, row.effect_posture as MeshCapabilityEffectPosture);
  return {
    workspaceId: row.workspace_id,
    activationId: row.activation_id,
    activationRevision: Number(row.activation_revision),
    capabilityId: row.capability_id,
    nodeId: row.node_id,
    publisherGeneration: Number(row.publisher_generation),
    healthGeneration: Number(row.health_generation),
    publicationLeaseFencingToken: Number(row.publication_lease_fencing_token),
    manifestSha256: row.manifest_sha256,
    entrySha256: row.entry_sha256,
    descriptorSha256: row.descriptor_sha256,
    permissionEnvelopeSha256: row.permission_envelope_sha256,
    effectPosture: row.effect_posture as MeshCapabilityEffectPosture,
    permissionDiff,
    effectDiff,
    approvalId: row.approval_id,
    actorId: row.actor_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    createdAt: row.created_at,
  };
}

function mapRevocation(row: RevocationRow): MeshCapabilityActivationRevocationRecord {
  return {
    workspaceId: row.workspace_id,
    activationId: row.activation_id,
    reason: row.reason,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    revokedAt: row.revoked_at,
  };
}

function mapIntent(row: IntentRow): MeshCapabilityInvocationIntentRecord {
  return {
    workspaceId: row.workspace_id,
    invocationId: row.invocation_id,
    activationId: row.activation_id,
    activationRevision: Number(row.activation_revision),
    capabilityId: row.capability_id,
    nodeId: row.node_id,
    publisherGeneration: Number(row.publisher_generation),
    healthGeneration: Number(row.health_generation),
    publicationLeaseFencingToken: Number(row.publication_lease_fencing_token),
    manifestSha256: row.manifest_sha256,
    entrySha256: row.entry_sha256,
    descriptorSha256: row.descriptor_sha256,
    permissionEnvelopeSha256: row.permission_envelope_sha256,
    executionProfileSha256: row.execution_profile_sha256,
    inputSha256: row.input_sha256,
    sessionId: row.session_id,
    turnId: row.turn_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.approval_id === null ? {} : { approvalId: row.approval_id }),
    deadlineAt: row.deadline_at,
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    createdAt: row.created_at,
  };
}

function mapSettlement(row: SettlementRow): MeshCapabilityInvocationSettlementRecord {
  return {
    workspaceId: row.workspace_id,
    invocationId: row.invocation_id,
    disposition: row.disposition as MeshCapabilitySettlementDisposition,
    ...(row.output_sha256 === null ? {} : { outputSha256: row.output_sha256 }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    settlementSha256: row.settlement_sha256,
    ...(row.effective_cost_attribution_sha256 === null
      ? {}
      : { effectiveCostAttributionSha256: row.effective_cost_attribution_sha256 }),
    publisherGeneration: Number(row.publisher_generation),
    publicationLeaseFencingToken: Number(row.publication_lease_fencing_token),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256,
    settledAt: row.settled_at,
  };
}

function assertManifestReplay(
  replay: { manifest: MeshCapabilityManifest; requestSha256: string },
  requestSha256: string,
): MeshCapabilityManifest {
  if (replay.requestSha256 !== requestSha256)
    throw conflict("Mesh capability publication key was already used for different request bytes.");
  return replay.manifest;
}

function assertReplay<T extends { requestSha256: string }>(record: T, requestSha256: string, label: string): T {
  if (record.requestSha256 !== requestSha256)
    throw conflict(`Mesh capability ${label} idempotency key was already used for different request bytes.`);
  return record;
}

function parseCanonicalObject(value: string, label: string): Record<string, unknown> {
  const parsed = safeJsonParse<Record<string, unknown> | undefined>(value, undefined);
  if (!parsed || Array.isArray(parsed) || canonicalJsonString(parsed) !== value)
    throw new Error(`Mesh capability ${label} storage JSON is not canonical.`);
  return parsed;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}
function identifier(value: string, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  )
    throw new TypeError(`Mesh capability ${field} is not a canonical identifier.`);
  return value;
}
function optionalIdentifier(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : identifier(value, field, 512);
}
function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`Mesh capability ${field} must be a positive safe integer.`);
  return value;
}
function boundedLimit(value: number | undefined, fallback = 512, max = 2_000): number {
  if (value === undefined) return fallback;
  positiveInteger(value, "limit");
  return Math.min(value, max);
}
function digest(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new TypeError(`Mesh capability ${field} must be a lower-case SHA-256 digest.`);
  return value;
}
function timestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new TypeError(`Mesh capability ${field} must be a UTC timestamp.`);
  return value;
}
function booleanValue(value: boolean, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`Mesh capability ${field} must be a boolean.`);
  return value;
}
function text(value: string, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFKC").trim() ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  )
    throw new TypeError(`Mesh capability ${field} is invalid.`);
  return value;
}
function assertPriorActivationDiffBinding(
  repo: MeshCapabilityPublicationRepository,
  input: ActivateMeshCapabilityInput,
): MeshCapabilityActivationRecord | undefined {
  const permissionPriorId = input.permissionDiff.priorActivationId;
  const effectPriorId = input.effectDiff.priorActivationId;
  if (permissionPriorId !== effectPriorId)
    throw new TypeError("Mesh capability permission and effect diffs must bind the same prior activation.");
  if (!permissionPriorId) {
    if (input.activationRevision !== 1)
      throw new TypeError("Mesh capability initial activation must use activation revision 1.");
    return undefined;
  }
  const prior = repo.getActivation(input.workspaceId, permissionPriorId);
  if (
    prior.activationRevision + 1 !== input.activationRevision ||
    prior.capabilityId !== input.capabilityId ||
    prior.permissionEnvelopeSha256 !== input.permissionDiff.priorPermissionEnvelopeSha256 ||
    prior.effectPosture !== input.effectDiff.priorEffectPosture
  ) {
    throw conflict("Mesh capability activation diff does not match its exact prior activation binding.");
  }
  return prior;
}

function assertExactActivationDiffs(
  repo: MeshCapabilityPublicationRepository,
  input: ActivateMeshCapabilityInput,
  prior: MeshCapabilityActivationRecord | undefined,
): void {
  const currentEntry = getBoundActivationEntry(repo, input);
  assertMeshCallableKind(currentEntry.kind);
  const priorEntry = prior === undefined ? undefined : getBoundActivationEntry(repo, prior);
  const expectedPermissionDiff = exactPermissionDiff(
    priorEntry?.descriptor.permissions,
    currentEntry.descriptor.permissions,
    prior,
  );
  if (canonicalJsonString(input.permissionDiff) !== canonicalJsonString(expectedPermissionDiff)) {
    throw new TypeError("Mesh capability permission diff does not match the exact prior and current envelopes.");
  }
  const expectedEffectDiff = exactEffectDiff(
    priorEntry?.descriptor.effectPosture,
    currentEntry.descriptor.effectPosture,
    prior,
  );
  if (canonicalJsonString(input.effectDiff) !== canonicalJsonString(expectedEffectDiff)) {
    throw new TypeError("Mesh capability effect diff does not match the exact prior and current postures.");
  }
}

function getBoundActivationEntry(
  repo: MeshCapabilityPublicationRepository,
  binding: Pick<
    ActivateMeshCapabilityInput,
    | "workspaceId"
    | "nodeId"
    | "publisherGeneration"
    | "manifestSha256"
    | "capabilityId"
    | "entrySha256"
    | "descriptorSha256"
    | "permissionEnvelopeSha256"
    | "effectPosture"
  >,
): MeshCapabilityManifestEntry {
  const manifest = repo.getManifest(
    binding.workspaceId,
    binding.nodeId,
    binding.publisherGeneration,
    binding.manifestSha256,
  );
  const entry = manifest.entries.find((candidate) => candidate.capabilityId === binding.capabilityId);
  if (
    !entry ||
    entry.entrySha256 !== binding.entrySha256 ||
    entry.descriptorSha256 !== binding.descriptorSha256 ||
    entry.permissionEnvelopeSha256 !== binding.permissionEnvelopeSha256 ||
    entry.descriptor.effectPosture !== binding.effectPosture
  ) {
    throw conflict("Mesh capability activation does not bind the exact immutable manifest entry.");
  }
  return entry;
}

function exactPermissionDiff(
  prior: MeshCapabilityPermissionEnvelope | undefined,
  current: MeshCapabilityPermissionEnvelope,
  priorActivation: MeshCapabilityActivationRecord | undefined,
): MeshCapabilityPermissionDiff {
  if (!prior || !priorActivation) {
    return {
      schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentPermissionEnvelopeSha256: computeMeshCapabilityDescriptorSha256(current),
      added: [],
      removed: [],
    };
  }
  const previousGrants = new Set(permissionGrants(prior));
  const currentGrants = new Set(permissionGrants(current));
  const added = [...currentGrants].filter((grant) => !previousGrants.has(grant)).sort(compareExactStrings);
  const removed = [...previousGrants].filter((grant) => !currentGrants.has(grant)).sort(compareExactStrings);
  return {
    schemaVersion: MESH_CAPABILITY_PERMISSION_DIFF_SCHEMA_VERSION,
    disposition:
      added.length > 0 && removed.length > 0
        ? "mixed"
        : added.length > 0
          ? "widened"
          : removed.length > 0
            ? "narrowed"
            : "unchanged",
    priorActivationId: priorActivation.activationId,
    priorPermissionEnvelopeSha256: priorActivation.permissionEnvelopeSha256,
    currentPermissionEnvelopeSha256: computeMeshCapabilityDescriptorSha256(current),
    added,
    removed,
  };
}

function permissionGrants(envelope: MeshCapabilityPermissionEnvelope): string[] {
  return (
    [
      ["deviceCapabilities", envelope.deviceCapabilities],
      ["environmentNames", envelope.environmentNames],
      ["filesystemRead", envelope.filesystemRead],
      ["filesystemWrite", envelope.filesystemWrite],
      ["networkOrigins", envelope.networkOrigins],
    ] as const
  )
    .flatMap(([dimension, values]) => values.map((value) => `${dimension}:${value}`))
    .sort(compareExactStrings);
}

function exactEffectDiff(
  prior: MeshCapabilityEffectPosture | undefined,
  current: MeshCapabilityEffectPosture,
  priorActivation: MeshCapabilityActivationRecord | undefined,
): MeshCapabilityEffectDiff {
  if (prior === undefined || priorActivation === undefined) {
    return {
      schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
      disposition: "initial",
      currentEffectPosture: current,
    };
  }
  const rank = { none: 0, read_only: 1, write_local: 2, external_side_effect: 3 } as const;
  const disposition =
    prior === current
      ? "unchanged"
      : prior === "unknown" || current === "unknown"
        ? "changed"
        : rank[current] < rank[prior]
          ? "reduced"
          : "increased";
  return {
    schemaVersion: MESH_CAPABILITY_EFFECT_DIFF_SCHEMA_VERSION,
    disposition,
    priorActivationId: priorActivation.activationId,
    priorEffectPosture: prior,
    currentEffectPosture: current,
  };
}

function compareExactStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function healthStatus(value: string): MeshCapabilityPublisherHealthStatus {
  if (!["online", "suspect", "offline", "revoked"].includes(value))
    throw new TypeError("Mesh capability publisher health status is invalid.");
  return value as MeshCapabilityPublisherHealthStatus;
}
function effect(value: string): MeshCapabilityEffectPosture {
  if (!["none", "read_only", "write_local", "external_side_effect", "unknown"].includes(value))
    throw new TypeError("Mesh capability effect posture is invalid.");
  return value as MeshCapabilityEffectPosture;
}
function settlementDisposition(value: string): MeshCapabilitySettlementDisposition {
  if (!["succeeded", "failed", "cancelled", "timed_out", "unknown"].includes(value))
    throw new TypeError("Mesh capability settlement disposition is invalid.");
  return value as MeshCapabilitySettlementDisposition;
}
function conflict(message: string): ConflictError {
  return new ConflictError({ code: "STATE_CONFLICT", message });
}
function normalizeWriteError(error: unknown, label: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/mesh capability|constraint|unique|foreign key|violat/i.test(message))
    return conflict(`Mesh capability ${label} conflicts with a storage invariant.`);
  return error instanceof Error ? error : new Error(message);
}

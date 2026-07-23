import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  assertExternalSourceRecord,
  canonicalJsonString,
  type ExternalSourceRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";
import { WorkspacePathBridgeSnapshotRepository } from "./workspace-path-bridge-snapshot-repo.js";

export type ExternalSourceRecordDraft = Omit<ExternalSourceRecord, "configSha256">;

interface ExternalSourceConfigRow {
  workspace_id: string;
  source_id: string;
  schema_version: string;
  kind: string;
  label: string;
  owner_actor_id: string;
  auth_actor_id: string;
  auth_actor_source: string;
  canonical_root_path: string;
  root_identity_sha256: string;
  path_bridge_snapshot_id: string;
  path_bridge_snapshot_sha256: string;
  allowed_roots_sha256: string;
  input_flavor: string;
  target_flavor: string;
  distro: string | null;
  require_git_identity: number | boolean;
  git_identity_sha256: string | null;
  root_grant_approval_id: string | null;
  ownership_attestation_sha256: string;
  adapter_id: string;
  adapter_version: string;
  adapter_policy_json: string;
  revision: number | bigint | string;
  config_sha256: string;
  status: string;
  record_json: string;
  created_at: string;
  updated_at: string;
}

interface ExternalSourceWorkspaceStateRow {
  revision: number | bigint | string;
  lifecycle_status: string;
}

interface ExternalSourceActiveCountRow {
  active_count: number | bigint | string;
}

const IMMUTABLE_CONFIG_KEYS = [
  "schemaVersion",
  "sourceId",
  "workspaceId",
  "kind",
  "ownerActorId",
  "authActorId",
  "authActorSource",
  "canonicalRootPath",
  "rootIdentitySha256",
  "pathBridgeSnapshotId",
  "pathBridgeSnapshotSha256",
  "allowedRootsSha256",
  "inputFlavor",
  "targetFlavor",
  "distro",
  "requireGitIdentity",
  "gitIdentitySha256",
  "rootGrantApprovalId",
  "ownershipAttestationSha256",
  "adapterId",
  "createdAt",
] as const satisfies readonly (keyof ExternalSourceRecord)[];

export class ExternalSourceConfigRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listByActorStmt;
  private readonly updateStmt;
  private readonly workspaceStateStmt;
  private readonly activeCountStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO external_source_configs (
        workspace_id, source_id, schema_version, kind, label, owner_actor_id, auth_actor_id,
        auth_actor_source, canonical_root_path, root_identity_sha256, path_bridge_snapshot_id,
        path_bridge_snapshot_sha256, allowed_roots_sha256, input_flavor, target_flavor, distro,
        require_git_identity, git_identity_sha256, root_grant_approval_id, ownership_attestation_sha256,
        adapter_id, adapter_version, adapter_policy_json, revision, config_sha256, status, record_json,
        created_at, updated_at
      ) VALUES (
        @workspaceId, @sourceId, @schemaVersion, @kind, @label, @ownerActorId, @authActorId,
        @authActorSource, @canonicalRootPath, @rootIdentitySha256, @pathBridgeSnapshotId,
        @pathBridgeSnapshotSha256, @allowedRootsSha256, @inputFlavor, @targetFlavor, @distro,
        @requireGitIdentity, @gitIdentitySha256, @rootGrantApprovalId, @ownershipAttestationSha256,
        @adapterId, @adapterVersion, @adapterPolicyJson, @revision, @configSha256, @status, @recordJson,
        @createdAt, @updatedAt
      ) ON CONFLICT(workspace_id, source_id) DO NOTHING
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM external_source_configs
      WHERE workspace_id = @workspaceId AND source_id = @sourceId
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM external_source_configs
      WHERE workspace_id = @workspaceId
      ORDER BY updated_at DESC, source_id DESC
      LIMIT @limit
    `);
    this.listByActorStmt = db.prepare(`
      SELECT * FROM external_source_configs
      WHERE workspace_id = @workspaceId
        AND owner_actor_id = @ownerActorId
        AND auth_actor_id = @authActorId
        AND auth_actor_source = @authActorSource
      ORDER BY updated_at DESC, source_id DESC
      LIMIT @limit
    `);
    this.updateStmt = db.prepare(`
      UPDATE external_source_configs SET
        label = @label,
        adapter_version = @adapterVersion,
        adapter_policy_json = @adapterPolicyJson,
        revision = @revision,
        config_sha256 = @configSha256,
        status = @status,
        record_json = @recordJson,
        updated_at = @updatedAt
      WHERE workspace_id = @workspaceId
        AND source_id = @sourceId
        AND revision = @expectedRevision
    `);
    this.workspaceStateStmt = db.prepare(`
      SELECT revision, lifecycle_status
      FROM workspaces
      WHERE workspace_id = @workspaceId
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);
    this.activeCountStmt = db.prepare(`
      SELECT COUNT(*) AS active_count
      FROM external_source_configs
      WHERE workspace_id = @workspaceId AND status = 'active'
    `);
  }

  public createForActiveWorkspace(
    input: ExternalSourceRecord,
    expectedWorkspaceRevision: number,
    activeRootLimit: number,
  ): ExternalSourceRecord {
    if (!Number.isSafeInteger(expectedWorkspaceRevision) || expectedWorkspaceRevision < 1) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `External source ${input.sourceId} has an invalid expected workspace revision.`,
      });
    }
    if (!Number.isSafeInteger(activeRootLimit) || activeRootLimit < 1) {
      throw new TypeError("External source active-root limit is invalid.");
    }
    return this.db.transaction("immediate", () => {
      const workspace = this.workspaceStateStmt.get({
        workspaceId: input.workspaceId,
      }) as ExternalSourceWorkspaceStateRow | undefined;
      if (!workspace) {
        throw new NotFoundError({ entity: "workspace", id: input.workspaceId });
      }
      if (workspace.lifecycle_status !== "active" || Number(workspace.revision) !== expectedWorkspaceRevision) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `External source ${input.sourceId} workspace state changed before registration.`,
        });
      }
      const count = this.activeCountStmt.get({
        workspaceId: input.workspaceId,
      }) as ExternalSourceActiveCountRow | undefined;
      if (!count || Number(count.active_count) >= activeRootLimit) {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `External source ${input.sourceId} exceeds the active-root limit.`,
          details: { reason: "active_root_limit" },
        });
      }
      return this.create(input);
    });
  }

  public create(input: ExternalSourceRecord): ExternalSourceRecord {
    verifyExternalSourceRecord(input);
    if (input.revision !== 1 || input.createdAt !== input.updatedAt) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "A new external source must begin at revision 1 with one creation timestamp.",
      });
    }
    this.assertPathBridgeBinding(input);
    try {
      this.insertStmt.run(toBindings(input));
    } catch (error) {
      throw normalizeConfigWriteError(error, input.sourceId);
    }
    const stored = this.get(input.workspaceId, input.sourceId);
    assertExactReplay(stored, input, `External source ${input.sourceId}`);
    return stored;
  }

  public updateCas(
    input: ExternalSourceRecord,
    expectedRevision: number,
    activeRootLimit: number,
  ): ExternalSourceRecord {
    verifyExternalSourceRecord(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || input.revision !== expectedRevision + 1) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `External source ${input.sourceId} update has an invalid expected revision.`,
      });
    }
    if (!Number.isSafeInteger(activeRootLimit) || activeRootLimit < 1) {
      throw new TypeError("External source active-root limit is invalid.");
    }
    return this.db.transaction("immediate", () => {
      const workspace = this.workspaceStateStmt.get({
        workspaceId: input.workspaceId,
      }) as ExternalSourceWorkspaceStateRow | undefined;
      if (!workspace) {
        throw new NotFoundError({ entity: "workspace", id: input.workspaceId });
      }
      if (workspace.lifecycle_status !== "active") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `External source ${input.sourceId} cannot be updated outside an active workspace.`,
        });
      }
      const current = this.get(input.workspaceId, input.sourceId);
      if (current.revision !== expectedRevision) {
        throw staleRevision(input.sourceId, expectedRevision, current.revision);
      }
      if (current.status === "revoked") {
        throw new ConflictError({
          code: "STATE_CONFLICT",
          message: `External source ${input.sourceId} is revoked and cannot be changed.`,
        });
      }
      if (current.status !== "active" && input.status === "active") {
        const count = this.activeCountStmt.get({
          workspaceId: input.workspaceId,
        }) as ExternalSourceActiveCountRow | undefined;
        if (!count || Number(count.active_count) >= activeRootLimit) {
          throw new ConflictError({
            code: "STATE_CONFLICT",
            message: `External source ${input.sourceId} exceeds the active-root limit.`,
            details: { reason: "active_root_limit" },
          });
        }
      }
      assertImmutableIdentity(current, input);
      if (input.updatedAt <= current.updatedAt) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: `External source ${input.sourceId} update timestamp must advance.`,
        });
      }
      this.assertPathBridgeBinding(input);
      let result;
      try {
        result = this.updateStmt.run({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          label: input.label,
          adapterVersion: input.adapterVersion,
          adapterPolicyJson: canonicalJsonString(input.adapterPolicy),
          revision: input.revision,
          configSha256: input.configSha256,
          status: input.status,
          recordJson: canonicalJsonString(input),
          updatedAt: input.updatedAt,
          expectedRevision,
        });
      } catch (error) {
        throw normalizeConfigWriteError(error, input.sourceId);
      }
      if (result.changes !== 1) {
        const observed = this.find(input.workspaceId, input.sourceId)?.revision;
        throw staleRevision(input.sourceId, expectedRevision, observed);
      }
      const stored = this.get(input.workspaceId, input.sourceId);
      assertExactReplay(stored, input, `External source ${input.sourceId}`);
      return stored;
    });
  }

  public get(workspaceId: string, sourceId: string): ExternalSourceRecord {
    const record = this.find(workspaceId, sourceId);
    if (!record) throw new NotFoundError({ entity: "external source", id: sourceId });
    return record;
  }

  public find(workspaceId: string, sourceId: string): ExternalSourceRecord | undefined {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(sourceId, "sourceId");
    const row = this.getStmt.get({ workspaceId, sourceId }) as ExternalSourceConfigRow | undefined;
    return row ? mapAndVerifyRow(row) : undefined;
  }

  public listByWorkspace(workspaceId: string, limit = 100): ExternalSourceRecord[] {
    assertIdentifier(workspaceId, "workspaceId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("External source list limit must be an integer from 1 through 100.");
    }
    return (this.listStmt.all({ workspaceId, limit }) as ExternalSourceConfigRow[]).map(mapAndVerifyRow);
  }

  public listByWorkspaceActor(
    workspaceId: string,
    ownerActorId: string,
    authActorId: string,
    authActorSource: string,
    limit = 100,
  ): ExternalSourceRecord[] {
    assertIdentifier(workspaceId, "workspaceId");
    assertIdentifier(ownerActorId, "ownerActorId");
    assertIdentifier(authActorId, "authActorId");
    if (!["token", "basic", "loopback"].includes(authActorSource)) {
      throw new TypeError("External source authActorSource is invalid.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("External source list limit must be an integer from 1 through 100.");
    }
    return (
      this.listByActorStmt.all({
        workspaceId,
        ownerActorId,
        authActorId,
        authActorSource,
        limit,
      }) as ExternalSourceConfigRow[]
    ).map(mapAndVerifyRow);
  }

  private assertPathBridgeBinding(input: ExternalSourceRecord): void {
    const snapshot = new WorkspacePathBridgeSnapshotRepository(this.db).find(input.pathBridgeSnapshotId);
    if (!snapshot || snapshot.workspaceId !== input.workspaceId) {
      throw new NotFoundError({ entity: "workspace path bridge snapshot", id: input.pathBridgeSnapshotId });
    }
    const expectedGitIdentity =
      snapshot.gitIdentity.status === "verified" ? snapshot.gitIdentity.identitySha256 : undefined;
    if (
      snapshot.status !== "verified" ||
      snapshot.callable !== true ||
      snapshot.snapshotSha256 !== input.pathBridgeSnapshotSha256 ||
      snapshot.allowedRootsHash !== input.allowedRootsSha256 ||
      snapshot.canonicalHostPath !== input.canonicalRootPath ||
      snapshot.inputFlavor !== input.inputFlavor ||
      snapshot.targetFlavor !== input.targetFlavor ||
      snapshot.distro !== input.distro ||
      snapshot.gitIdentityRequired !== input.requireGitIdentity ||
      expectedGitIdentity !== input.gitIdentitySha256
    ) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: `External source ${input.sourceId} does not match verified workspace path identity.`,
      });
    }
  }
}

export function sealExternalSourceRecord(input: ExternalSourceRecordDraft): ExternalSourceRecord {
  const record = { ...input, configSha256: canonicalHash(input) };
  assertExternalSourceRecord(record);
  return record;
}

export function verifyExternalSourceRecord(input: ExternalSourceRecord): void {
  assertExternalSourceRecord(input);
  const { configSha256: _configSha256, ...draft } = input;
  if (canonicalHash(draft) !== input.configSha256) {
    throw new Error(`External source ${input.sourceId} failed config hash verification.`);
  }
}

function toBindings(input: ExternalSourceRecord): Record<string, unknown> {
  return {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    label: input.label,
    ownerActorId: input.ownerActorId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
    canonicalRootPath: input.canonicalRootPath,
    rootIdentitySha256: input.rootIdentitySha256,
    pathBridgeSnapshotId: input.pathBridgeSnapshotId,
    pathBridgeSnapshotSha256: input.pathBridgeSnapshotSha256,
    allowedRootsSha256: input.allowedRootsSha256,
    inputFlavor: input.inputFlavor,
    targetFlavor: input.targetFlavor,
    distro: input.distro ?? null,
    // 0/1, never a raw boolean: fresh-PostgreSQL databases type boolean-ish
    // columns BIGINT (blueprint migration 2), older databases BOOLEAN
    // (migration 108) — 0/1 binds satisfy both.
    requireGitIdentity: input.requireGitIdentity ? 1 : 0,
    gitIdentitySha256: input.gitIdentitySha256 ?? null,
    rootGrantApprovalId: input.rootGrantApprovalId ?? null,
    ownershipAttestationSha256: input.ownershipAttestationSha256,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    adapterPolicyJson: canonicalJsonString(input.adapterPolicy),
    revision: input.revision,
    configSha256: input.configSha256,
    status: input.status,
    recordJson: canonicalJsonString(input),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function mapAndVerifyRow(row: ExternalSourceConfigRow): ExternalSourceRecord {
  const record = safeJsonParse<ExternalSourceRecord | undefined>(row.record_json, undefined);
  if (!record) throw new Error(`External source ${row.source_id} contains invalid canonical JSON.`);
  verifyExternalSourceRecord(record);
  const expected: Record<string, unknown> = {
    workspace_id: record.workspaceId,
    source_id: record.sourceId,
    schema_version: record.schemaVersion,
    kind: record.kind,
    label: record.label,
    owner_actor_id: record.ownerActorId,
    auth_actor_id: record.authActorId,
    auth_actor_source: record.authActorSource,
    canonical_root_path: record.canonicalRootPath,
    root_identity_sha256: record.rootIdentitySha256,
    path_bridge_snapshot_id: record.pathBridgeSnapshotId,
    path_bridge_snapshot_sha256: record.pathBridgeSnapshotSha256,
    allowed_roots_sha256: record.allowedRootsSha256,
    input_flavor: record.inputFlavor,
    target_flavor: record.targetFlavor,
    distro: record.distro ?? null,
    git_identity_sha256: record.gitIdentitySha256 ?? null,
    root_grant_approval_id: record.rootGrantApprovalId ?? null,
    ownership_attestation_sha256: record.ownershipAttestationSha256,
    adapter_id: record.adapterId,
    adapter_version: record.adapterVersion,
    adapter_policy_json: canonicalJsonString(record.adapterPolicy),
    revision: record.revision,
    config_sha256: record.configSha256,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === "revision" ? Number(row.revision) : row[key as keyof ExternalSourceConfigRow];
    if (actual !== value) throw new Error(`External source ${row.source_id} failed indexed-column verification.`);
  }
  if (Boolean(row.require_git_identity) !== record.requireGitIdentity) {
    throw new Error(`External source ${row.source_id} failed Git posture verification.`);
  }
  if (row.record_json !== canonicalJsonString(record)) {
    throw new Error(`External source ${row.source_id} is not stored as canonical JSON.`);
  }
  return record;
}

function assertImmutableIdentity(current: ExternalSourceRecord, next: ExternalSourceRecord): void {
  for (const key of IMMUTABLE_CONFIG_KEYS) {
    if (canonicalJsonString(current[key]) !== canonicalJsonString(next[key])) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `External source ${current.sourceId} immutable identity changed at ${key}.`,
      });
    }
  }
}

function assertExactReplay(actual: ExternalSourceRecord, expected: ExternalSourceRecord, label: string): void {
  if (canonicalJsonString(actual) !== canonicalJsonString(expected)) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `${label} conflicts with an existing canonical record.`,
    });
  }
}

function staleRevision(sourceId: string, expected: number, observed?: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `External source ${sourceId} revision changed concurrently.`,
    details: { expectedRevision: expected, observedRevision: observed },
  });
}

function normalizeConfigWriteError(error: unknown, sourceId: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/unique|active-root limit|constraint/i.test(message)) {
    return new ConflictError({
      code: "STATE_CONFLICT",
      message: `External source ${sourceId} conflicts with an active root or storage invariant.`,
    });
  }
  return error instanceof Error ? error : new Error(message);
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 256) {
    throw new TypeError(`External source ${field} is invalid.`);
  }
}

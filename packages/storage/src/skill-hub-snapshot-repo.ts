import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  advanceSkillUpstreamAuditFloor,
  canonicalJsonString,
  diffSkillPermissionEnvelopes,
  isSkillPermissionEnvelopeV1,
  isSkillUpstreamAuditDetails,
  isSkillUpstreamAuditFloorV1,
} from "@goatcitadel/contracts";
import type {
  SkillPermissionDiffV1,
  SkillPermissionEnvelopeV1,
  SkillUpstreamAuditDetails,
  SkillUpstreamAuditFloorV1,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

export type SkillHubSnapshotOperation = "review" | "install" | "update_check" | "update_stage" | "rollback_check";

export type SkillHubSnapshotTrustDisposition = "review_only" | "candidate" | "blocked" | "revoked";

export interface SkillHubSnapshotRecord {
  snapshotId: string;
  workspaceId: string;
  operation: SkillHubSnapshotOperation;
  sourceProvider: string;
  sourceType: string;
  sourceRef: string;
  canonicalSourceKey: string;
  declaredVersion?: string;
  resolvedVersion?: string;
  contentTreeSha256: string;
  provenance: Record<string, unknown>;
  audit: Record<string, unknown>;
  auditSha256: string;
  auditFloor: SkillUpstreamAuditFloorV1;
  auditFloorSha256: string;
  permissionEnvelope: Record<string, unknown>;
  permissionEnvelopeSha256: string;
  permissionDiff: Record<string, unknown>;
  compatibility: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high" | "unknown";
  trustDisposition: SkillHubSnapshotTrustDisposition;
  priorSnapshotId?: string;
  blockerCodes: string[];
  createdAt: string;
}

export type SkillHubSnapshotCreateInput = Omit<SkillHubSnapshotRecord, "auditFloor" | "auditFloorSha256">;

interface SkillHubVersionClaimRow {
  workspace_id: string;
  canonical_source_key: string;
  version_kind: "declared" | "resolved";
  version_value: string;
  first_tree_sha256: string;
  first_snapshot_id: string;
  created_at: string;
}

interface SkillHubAuditFloorRow {
  workspace_id: string;
  canonical_source_key: string;
  floor_json: string;
  floor_sha256: string;
  updated_by_snapshot_id: string;
  created_at: string;
  updated_at: string;
}

interface SkillHubSnapshotRow {
  snapshot_id: string;
  workspace_id: string;
  operation: SkillHubSnapshotOperation;
  source_provider: string;
  source_type: string;
  source_ref: string;
  canonical_source_key: string;
  declared_version: string | null;
  resolved_version: string | null;
  content_tree_sha256: string;
  provenance_json: string;
  audit_json: string;
  audit_sha256: string;
  audit_floor_json: string;
  audit_floor_sha256: string;
  permission_envelope_json: string;
  permission_envelope_sha256: string;
  permission_diff_json: string;
  compatibility_json: string;
  risk_level: SkillHubSnapshotRecord["riskLevel"];
  trust_disposition: SkillHubSnapshotTrustDisposition;
  prior_snapshot_id: string | null;
  blocker_codes_json: string;
  created_at: string;
}

export class SkillHubSnapshotRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listByWorkspaceStmt;
  private readonly listBySourceStmt;
  private readonly latestBySourceStmt;
  private readonly previousBySourcePositionStmt;
  private readonly findVersionDriftStmt;
  private readonly insertVersionClaimStmt;
  private readonly getVersionClaimStmt;
  private readonly insertAuditFloorStmt;
  private readonly getAuditFloorStmt;
  private readonly updateAuditFloorStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO skill_hub_snapshots (
        snapshot_id, workspace_id, operation, source_provider, source_type, source_ref,
        canonical_source_key, declared_version, resolved_version, content_tree_sha256,
        provenance_json, audit_json, audit_sha256, permission_envelope_json,
        audit_floor_json, audit_floor_sha256, permission_envelope_sha256,
        permission_diff_json, compatibility_json, risk_level,
        trust_disposition, prior_snapshot_id, blocker_codes_json, created_at
      ) VALUES (
        @snapshotId, @workspaceId, @operation, @sourceProvider, @sourceType, @sourceRef,
        @canonicalSourceKey, @declaredVersion, @resolvedVersion, @contentTreeSha256,
        @provenanceJson, @auditJson, @auditSha256, @permissionEnvelopeJson,
        @auditFloorJson, @auditFloorSha256, @permissionEnvelopeSha256,
        @permissionDiffJson, @compatibilityJson, @riskLevel,
        @trustDisposition, @priorSnapshotId, @blockerCodesJson, @createdAt
      )
      ON CONFLICT(snapshot_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM skill_hub_snapshots WHERE snapshot_id = ?");
    this.listByWorkspaceStmt = db.prepare(`
      SELECT * FROM skill_hub_snapshots
      WHERE workspace_id = @workspaceId
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT @limit
    `);
    this.listBySourceStmt = db.prepare(`
      SELECT * FROM skill_hub_snapshots
      WHERE workspace_id = @workspaceId
        AND canonical_source_key = @canonicalSourceKey
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT @limit
    `);
    this.latestBySourceStmt = db.prepare(`
      SELECT * FROM skill_hub_snapshots
      WHERE workspace_id = @workspaceId
        AND canonical_source_key = @canonicalSourceKey
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT 1
    `);
    this.previousBySourcePositionStmt = db.prepare(`
      SELECT * FROM skill_hub_snapshots
      WHERE workspace_id = @workspaceId
        AND canonical_source_key = @canonicalSourceKey
        AND (
          created_at < @createdAt
          OR (created_at = @createdAt AND snapshot_id < @snapshotId)
        )
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT 1
    `);
    const declaredVersionPresent = optionalPresentSql(db.dialect, "@declaredVersion");
    const resolvedVersionPresent = optionalPresentSql(db.dialect, "@resolvedVersion");
    this.findVersionDriftStmt = db.prepare(`
      SELECT * FROM skill_hub_snapshots
      WHERE workspace_id = @workspaceId
        AND canonical_source_key = @canonicalSourceKey
        AND content_tree_sha256 <> @contentTreeSha256
        AND (
          (${declaredVersionPresent} AND declared_version = @declaredVersion)
          OR (${resolvedVersionPresent} AND resolved_version = @resolvedVersion)
        )
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT 1
    `);
    this.insertVersionClaimStmt = db.prepare(`
      INSERT INTO skill_hub_version_claims (
        workspace_id, canonical_source_key, version_kind, version_value,
        first_tree_sha256, first_snapshot_id, created_at
      ) VALUES (
        @workspaceId, @canonicalSourceKey, @versionKind, @versionValue,
        @firstTreeSha256, @firstSnapshotId, @createdAt
      )
      ON CONFLICT(workspace_id, canonical_source_key, version_kind, version_value) DO NOTHING
    `);
    this.getVersionClaimStmt = db.prepare(`
      SELECT * FROM skill_hub_version_claims
      WHERE workspace_id = @workspaceId
        AND canonical_source_key = @canonicalSourceKey
        AND version_kind = @versionKind
        AND version_value = @versionValue
    `);
    this.insertAuditFloorStmt = db.prepare(`
      INSERT INTO skill_hub_audit_floors (
        workspace_id, canonical_source_key, floor_json, floor_sha256,
        updated_by_snapshot_id, created_at, updated_at
      ) VALUES (
        @workspaceId, @canonicalSourceKey, @floorJson, @floorSha256,
        @updatedBySnapshotId, @createdAt, @updatedAt
      )
      ON CONFLICT(workspace_id, canonical_source_key) DO NOTHING
    `);
    this.getAuditFloorStmt = db.prepare(`
      SELECT * FROM skill_hub_audit_floors
      WHERE workspace_id = @workspaceId
        AND canonical_source_key = @canonicalSourceKey
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);
    this.updateAuditFloorStmt = db.prepare(`
      UPDATE skill_hub_audit_floors
      SET floor_json = @floorJson,
          floor_sha256 = @floorSha256,
          updated_by_snapshot_id = @updatedBySnapshotId,
          updated_at = @updatedAt
      WHERE workspace_id = @workspaceId
        AND canonical_source_key = @canonicalSourceKey
        AND floor_sha256 = @priorFloorSha256
    `);
  }

  public create(input: SkillHubSnapshotCreateInput): SkillHubSnapshotRecord {
    validateSnapshotInput(input, true);
    return this.db.transaction("immediate", () => {
      // The source-scoped audit floor is the serialization row on PostgreSQL
      // (FOR UPDATE) and the immediate transaction is the equivalent SQLite
      // fence. Resolve lineage only after this lock so concurrent writers
      // cannot both extend the same prior snapshot.
      const { floor: auditFloor, floorSha256: auditFloorSha256 } = this.advanceAuditFloor(input);
      const prior = this.resolveCreatePrior(input);
      assertExactPermissionDiff(input.permissionDiff, expectedPermissionDiff(prior, input));
      const sameVersionByteDrift = this.claimVersionIdentities(input);
      const blockerCodes = normalizeBlockerCodes([
        ...input.blockerCodes,
        ...auditFloor.effectiveBlockerCodes,
        ...permissionBlockerCodes(input.permissionDiff),
        ...(sameVersionByteDrift ? ["UPSTREAM_VERSION_BYTE_DRIFT"] : []),
      ]);
      const record: SkillHubSnapshotRecord = {
        ...input,
        auditFloor,
        auditFloorSha256,
        blockerCodes,
        trustDisposition:
          input.trustDisposition === "revoked"
            ? "revoked"
            : blockerCodes.length > 0
              ? "blocked"
              : input.trustDisposition,
      };
      validateStoredSnapshot(record);
      this.insertStmt.run(toBindings(record));
      const stored = this.get(record.snapshotId);
      assertImmutableReplay(stored, record);
      return stored;
    });
  }

  public get(snapshotId: string): SkillHubSnapshotRecord {
    assertCanonicalIdentity(snapshotId, "snapshot ID", 256);
    const row = this.getStmt.get(snapshotId) as SkillHubSnapshotRow | undefined;
    if (!row) throw new NotFoundError({ entity: "skill Hub snapshot", id: snapshotId });
    return this.mapAndValidateRow(row);
  }

  public find(snapshotId: string): SkillHubSnapshotRecord | undefined {
    assertCanonicalIdentity(snapshotId, "snapshot ID", 256);
    const row = this.getStmt.get(snapshotId) as SkillHubSnapshotRow | undefined;
    return row ? this.mapAndValidateRow(row) : undefined;
  }

  /**
   * Enumerates directly inside the workspace scope before applying the bound.
   * Callers may request limit + 1 to expose honest truncation without a global
   * pre-limit that could hide a quieter workspace's review-only snapshots.
   */
  public listByWorkspace(workspaceId: string, limit = 100): SkillHubSnapshotRecord[] {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    return (
      this.listByWorkspaceStmt.all({
        workspaceId,
        limit: normalizeQueryLimit(limit),
      }) as unknown as SkillHubSnapshotRow[]
    ).map((row) => this.mapAndValidateRow(row));
  }

  public listBySource(workspaceId: string, canonicalSourceKey: string, limit = 100): SkillHubSnapshotRecord[] {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    assertCanonicalIdentity(canonicalSourceKey, "canonical source key", 1_024);
    return (
      this.listBySourceStmt.all({
        workspaceId,
        canonicalSourceKey,
        limit: normalizeQueryLimit(limit),
      }) as unknown as SkillHubSnapshotRow[]
    ).map((row) => this.mapAndValidateRow(row));
  }

  public findSameVersionByteDrift(input: {
    workspaceId: string;
    canonicalSourceKey: string;
    declaredVersion?: string;
    resolvedVersion?: string;
    contentTreeSha256: string;
  }): SkillHubSnapshotRecord | undefined {
    if (!input.declaredVersion && !input.resolvedVersion) return undefined;
    assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
    assertCanonicalIdentity(input.canonicalSourceKey, "canonical source key", 1_024);
    validateOptional(input.declaredVersion, "declared version", 512);
    validateOptional(input.resolvedVersion, "resolved version", 512);
    assertSha256(input.contentTreeSha256, "content tree");
    const row = this.findVersionDriftStmt.get({
      workspaceId: input.workspaceId,
      canonicalSourceKey: input.canonicalSourceKey,
      declaredVersion: input.declaredVersion ?? null,
      resolvedVersion: input.resolvedVersion ?? null,
      contentTreeSha256: input.contentTreeSha256,
    }) as SkillHubSnapshotRow | undefined;
    return row ? this.mapAndValidateRow(row) : undefined;
  }

  private resolveCreatePrior(input: SkillHubSnapshotCreateInput): SkillHubSnapshotRecord | undefined {
    const existing = this.getStmt.get(input.snapshotId) as SkillHubSnapshotRow | undefined;
    const latest = this.latestBySourceStmt.get({
      workspaceId: input.workspaceId,
      canonicalSourceKey: input.canonicalSourceKey,
    }) as SkillHubSnapshotRow | undefined;
    let priorRow: SkillHubSnapshotRow | undefined;
    if (existing) {
      priorRow = this.previousBySourcePositionStmt.get({
        workspaceId: input.workspaceId,
        canonicalSourceKey: input.canonicalSourceKey,
        createdAt: input.createdAt,
        snapshotId: input.snapshotId,
      }) as SkillHubSnapshotRow | undefined;
    } else {
      priorRow = latest;
      if (latest && compareSnapshotPosition(input, latest) <= 0) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Skill Hub snapshots must extend the latest immutable source position.",
        });
      }
    }
    const prior = priorRow ? mapRow(priorRow) : undefined;
    if ((input.priorSnapshotId ?? undefined) !== prior?.snapshotId) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: prior
          ? `Skill Hub snapshot ${input.snapshotId} must name latest prior snapshot ${prior.snapshotId}.`
          : `First Skill Hub snapshot ${input.snapshotId} cannot name a prior snapshot.`,
      });
    }
    return prior;
  }

  private mapAndValidateRow(row: SkillHubSnapshotRow): SkillHubSnapshotRecord {
    const record = mapRow(row);
    const priorRow = this.previousBySourcePositionStmt.get({
      workspaceId: record.workspaceId,
      canonicalSourceKey: record.canonicalSourceKey,
      createdAt: record.createdAt,
      snapshotId: record.snapshotId,
    }) as SkillHubSnapshotRow | undefined;
    const prior = priorRow ? mapRow(priorRow) : undefined;
    if ((record.priorSnapshotId ?? undefined) !== prior?.snapshotId) {
      throw new Error("Skill Hub snapshot contains a missing, stale, or nonlinear prior-snapshot relation.");
    }
    assertExactPermissionDiff(record.permissionDiff, expectedPermissionDiff(prior, record));
    const expectedAuditFloor = advanceSkillUpstreamAuditFloor(
      record.audit as unknown as SkillUpstreamAuditDetails,
      prior?.auditFloor,
    ).floor;
    if (canonicalJsonString(record.auditFloor) !== canonicalJsonString(expectedAuditFloor)) {
      throw new Error("Skill Hub snapshot audit floor does not match its immutable source lineage.");
    }
    for (const blocker of permissionBlockerCodes(record.permissionDiff)) {
      if (!record.blockerCodes.includes(blocker)) {
        throw new Error("Skill Hub snapshot omits a required permission-diff blocker.");
      }
    }
    return record;
  }

  private claimVersionIdentities(input: SkillHubSnapshotCreateInput): boolean {
    let drift = false;
    const identities: Array<{ versionKind: "declared" | "resolved"; versionValue: string }> = [];
    if (input.declaredVersion) identities.push({ versionKind: "declared", versionValue: input.declaredVersion });
    if (input.resolvedVersion) identities.push({ versionKind: "resolved", versionValue: input.resolvedVersion });
    for (const identity of identities) {
      const bindings = {
        workspaceId: input.workspaceId,
        canonicalSourceKey: input.canonicalSourceKey,
        versionKind: identity.versionKind,
        versionValue: identity.versionValue,
        firstTreeSha256: input.contentTreeSha256,
        firstSnapshotId: input.snapshotId,
        createdAt: input.createdAt,
      };
      this.insertVersionClaimStmt.run(bindings);
      const claim = this.getVersionClaimStmt.get({
        workspaceId: bindings.workspaceId,
        canonicalSourceKey: bindings.canonicalSourceKey,
        versionKind: bindings.versionKind,
        versionValue: bindings.versionValue,
      }) as SkillHubVersionClaimRow | undefined;
      if (!claim) throw new Error("Skill Hub version identity claim was not persisted.");
      validateVersionClaim(claim);
      if (claim.first_tree_sha256 !== input.contentTreeSha256) drift = true;
    }
    return drift;
  }

  private advanceAuditFloor(input: SkillHubSnapshotCreateInput): {
    floor: SkillUpstreamAuditFloorV1;
    floorSha256: string;
  } {
    const identity = {
      workspaceId: input.workspaceId,
      canonicalSourceKey: input.canonicalSourceKey,
    };
    let storedRow = this.getAuditFloorStmt.get(identity) as SkillHubAuditFloorRow | undefined;
    let stored = storedRow ? mapAuditFloorRow(storedRow) : undefined;
    let advanced = advanceSkillUpstreamAuditFloor(input.audit as unknown as SkillUpstreamAuditDetails, stored?.floor);
    let advancedSha256 = canonicalHash(advanced.floor);

    if (!storedRow) {
      this.insertAuditFloorStmt.run({
        ...identity,
        floorJson: canonicalJsonString(advanced.floor),
        floorSha256: advancedSha256,
        updatedBySnapshotId: input.snapshotId,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      });
      storedRow = this.getAuditFloorStmt.get(identity) as SkillHubAuditFloorRow | undefined;
      if (!storedRow) throw new Error("Skill Hub audit floor was not persisted.");
      stored = mapAuditFloorRow(storedRow);
      if (stored.floorSha256 === advancedSha256) return { floor: stored.floor, floorSha256: stored.floorSha256 };
      advanced = advanceSkillUpstreamAuditFloor(input.audit as unknown as SkillUpstreamAuditDetails, stored.floor);
      advancedSha256 = canonicalHash(advanced.floor);
    }

    if (!stored) throw new Error("Skill Hub audit floor could not be loaded.");
    if (stored.floorSha256 === advancedSha256) return { floor: stored.floor, floorSha256: stored.floorSha256 };
    const updatedAt = input.createdAt > stored.updatedAt ? input.createdAt : stored.updatedAt;
    const result = this.updateAuditFloorStmt.run({
      ...identity,
      floorJson: canonicalJsonString(advanced.floor),
      floorSha256: advancedSha256,
      updatedBySnapshotId: input.snapshotId,
      updatedAt,
      priorFloorSha256: stored.floorSha256,
    });
    if (result.changes !== 1) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Skill Hub audit floor for ${input.canonicalSourceKey} changed concurrently.`,
      });
    }
    const updated = this.getAuditFloorStmt.get(identity) as SkillHubAuditFloorRow | undefined;
    if (!updated) throw new Error("Updated Skill Hub audit floor could not be loaded.");
    const mapped = mapAuditFloorRow(updated);
    if (mapped.floorSha256 !== advancedSha256) {
      throw new Error("Updated Skill Hub audit floor does not match the requested monotonic state.");
    }
    return { floor: mapped.floor, floorSha256: mapped.floorSha256 };
  }
}

function toBindings(input: SkillHubSnapshotRecord): Record<string, unknown> {
  return {
    snapshotId: input.snapshotId,
    workspaceId: input.workspaceId,
    operation: input.operation,
    sourceProvider: input.sourceProvider,
    sourceType: input.sourceType,
    sourceRef: input.sourceRef,
    canonicalSourceKey: input.canonicalSourceKey,
    declaredVersion: input.declaredVersion ?? null,
    resolvedVersion: input.resolvedVersion ?? null,
    contentTreeSha256: input.contentTreeSha256,
    provenanceJson: canonicalJsonString(input.provenance),
    auditJson: canonicalJsonString(input.audit),
    auditSha256: input.auditSha256,
    auditFloorJson: canonicalJsonString(input.auditFloor),
    auditFloorSha256: input.auditFloorSha256,
    permissionEnvelopeJson: canonicalJsonString(input.permissionEnvelope),
    permissionEnvelopeSha256: input.permissionEnvelopeSha256,
    permissionDiffJson: canonicalJsonString(input.permissionDiff),
    compatibilityJson: canonicalJsonString(input.compatibility),
    riskLevel: input.riskLevel,
    trustDisposition: input.trustDisposition,
    priorSnapshotId: input.priorSnapshotId ?? null,
    blockerCodesJson: canonicalJsonString(normalizeBlockerCodes(input.blockerCodes)),
    createdAt: input.createdAt,
  };
}

function mapRow(row: SkillHubSnapshotRow): SkillHubSnapshotRecord {
  const record: SkillHubSnapshotRecord = {
    snapshotId: row.snapshot_id,
    workspaceId: row.workspace_id,
    operation: row.operation,
    sourceProvider: row.source_provider,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    canonicalSourceKey: row.canonical_source_key,
    declaredVersion: row.declared_version ?? undefined,
    resolvedVersion: row.resolved_version ?? undefined,
    contentTreeSha256: row.content_tree_sha256,
    provenance: parseObject(row.provenance_json, "provenance"),
    audit: parseObject(row.audit_json, "audit"),
    auditSha256: row.audit_sha256,
    auditFloor: parseAuditFloor(row.audit_floor_json),
    auditFloorSha256: row.audit_floor_sha256,
    permissionEnvelope: parseObject(row.permission_envelope_json, "permission envelope"),
    permissionEnvelopeSha256: row.permission_envelope_sha256,
    permissionDiff: parseObject(row.permission_diff_json, "permission diff"),
    compatibility: parseObject(row.compatibility_json, "compatibility"),
    riskLevel: row.risk_level,
    trustDisposition: row.trust_disposition,
    priorSnapshotId: row.prior_snapshot_id ?? undefined,
    blockerCodes: parseStringArray(row.blocker_codes_json, "blocker codes"),
    createdAt: row.created_at,
  };
  validateStoredSnapshot(record);
  return record;
}

function mapAuditFloorRow(row: SkillHubAuditFloorRow): {
  floor: SkillUpstreamAuditFloorV1;
  floorSha256: string;
  updatedAt: string;
} {
  assertBounded(row.workspace_id, "audit floor workspace ID", 256);
  assertBounded(row.canonical_source_key, "audit floor source key", 1_024);
  assertBounded(row.updated_by_snapshot_id, "audit floor snapshot ID", 256);
  validateTimestamp(row.created_at, "audit floor created-at");
  validateTimestamp(row.updated_at, "audit floor updated-at");
  const floor = parseAuditFloor(row.floor_json);
  assertCanonicalHash(floor, row.floor_sha256, "audit floor");
  return { floor, floorSha256: row.floor_sha256, updatedAt: row.updated_at };
}

function assertImmutableReplay(stored: SkillHubSnapshotRecord, attempted: SkillHubSnapshotRecord): void {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Skill Hub snapshot ${attempted.snapshotId} conflicts with an existing immutable record.`,
    });
  }
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Skill Hub snapshot contains malformed ${label} JSON.`);
  }
  return parsed as Record<string, unknown>;
}

function parseAuditFloor(value: string): SkillUpstreamAuditFloorV1 {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!isSkillUpstreamAuditFloorV1(parsed)) {
    throw new Error("Skill Hub snapshot contains malformed audit floor JSON.");
  }
  return parsed;
}

function parseStringArray(value: string, label: string): string[] {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`Skill Hub snapshot contains malformed ${label} JSON.`);
  }
  return parsed;
}

function normalizeBlockerCodes(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 64) {
    throw new TypeError("Skill Hub blocker codes are bounded to 64 entries.");
  }
  return [
    ...new Set(
      values.map((value) => {
        if (typeof value !== "string") throw new TypeError("Skill Hub blocker codes must be strings.");
        const normalized = value.trim();
        if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) {
          throw new TypeError("Skill Hub blocker code is missing, oversized, or invalid.");
        }
        return normalized;
      }),
    ),
  ].sort(compareStrings);
}

function expectedPermissionDiff(
  prior: SkillHubSnapshotRecord | undefined,
  current: Pick<SkillHubSnapshotRecord, "permissionEnvelope">,
): SkillPermissionDiffV1 {
  if (!prior) return emptyPermissionDiff();
  return diffSkillPermissionEnvelopes(
    prior.permissionEnvelope as unknown as SkillPermissionEnvelopeV1,
    current.permissionEnvelope as unknown as SkillPermissionEnvelopeV1,
  );
}

function emptyPermissionDiff(): SkillPermissionDiffV1 {
  const dimension = () => ({ added: [] as string[], removed: [] as string[] });
  return {
    version: "goatcitadel.skill-permission-diff.v1",
    disposition: "none",
    dimensions: {
      toolIds: dimension(),
      environmentVariableNames: dimension(),
      networkOrigins: dimension(),
      filesystemReadScopes: dimension(),
      filesystemWriteScopes: dimension(),
      scripts: dimension(),
      packages: dimension(),
      nativeRequirements: dimension(),
    },
  };
}

function assertExactPermissionDiff(actual: Record<string, unknown>, expected: SkillPermissionDiffV1): void {
  if (canonicalJsonString(actual) !== canonicalJsonString(expected)) {
    throw new TypeError("Skill Hub permission diff does not match the canonical prior and current envelopes.");
  }
}

function permissionBlockerCodes(diff: Record<string, unknown>): string[] {
  const disposition = diff.disposition;
  if (disposition === "widened" || disposition === "mixed") return ["PERMISSION_WIDENED"];
  if (disposition === "unknown") return ["PERMISSION_UNKNOWN"];
  return [];
}

function compareSnapshotPosition(
  input: Pick<SkillHubSnapshotCreateInput, "createdAt" | "snapshotId">,
  row: Pick<SkillHubSnapshotRow, "created_at" | "snapshot_id">,
): number {
  const created = compareStrings(input.createdAt, row.created_at);
  return created === 0 ? compareStrings(input.snapshotId, row.snapshot_id) : created;
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`Skill Hub ${label} hash must be a SHA-256 hex digest.`);
}

function optionalPresentSql(dialect: DatabaseClient["dialect"], parameter: string): string {
  return dialect === "postgres" ? `${parameter}::text IS NOT NULL` : `${parameter} IS NOT NULL`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeQueryLimit(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError("Skill Hub query limit must be a finite integer.");
  }
  return Math.max(1, Math.min(value, 500));
}

function validateSnapshotInput(input: SkillHubSnapshotCreateInput, allowBlockerDispositionNormalization = false): void {
  assertCanonicalIdentity(input.snapshotId, "snapshot ID", 256);
  assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  if (!new Set(["review", "install", "update_check", "update_stage", "rollback_check"]).has(input.operation)) {
    throw new TypeError("Unsupported Skill Hub snapshot operation.");
  }
  assertCanonicalIdentity(input.sourceProvider, "source provider", 128);
  assertCanonicalIdentity(input.sourceType, "source type", 128);
  assertBounded(input.sourceRef, "source reference", 2_048);
  assertCanonicalIdentity(input.canonicalSourceKey, "canonical source key", 1_024);
  validateOptionalCanonical(input.declaredVersion, "declared version", 512);
  validateOptionalCanonical(input.resolvedVersion, "resolved version", 512);
  if (!input.declaredVersion && !input.resolvedVersion) {
    throw new TypeError("Skill Hub snapshots require a declared or resolved version identity.");
  }
  assertSha256(input.contentTreeSha256, "content tree");
  assertBoundedContentFreeMetadata(input.provenance, "provenance");
  validateAudit(input.audit);
  assertCanonicalHash(input.audit, input.auditSha256, "audit");
  validatePermissionEnvelope(input.permissionEnvelope);
  assertCanonicalHash(input.permissionEnvelope, input.permissionEnvelopeSha256, "permission envelope");
  validatePermissionDiff(input.permissionDiff);
  assertBoundedContentFreeMetadata(input.compatibility, "compatibility");
  if (!new Set(["low", "medium", "high", "unknown"]).has(input.riskLevel)) {
    throw new TypeError("Unsupported Skill Hub risk level.");
  }
  if (!new Set(["review_only", "candidate", "blocked", "revoked"]).has(input.trustDisposition)) {
    throw new TypeError("Unsupported Skill Hub trust disposition.");
  }
  validateOptionalCanonical(input.priorSnapshotId, "prior snapshot ID", 256);
  const blockers = normalizeBlockerCodes(input.blockerCodes);
  if (
    !allowBlockerDispositionNormalization &&
    blockers.length > 0 &&
    input.trustDisposition !== "blocked" &&
    input.trustDisposition !== "revoked"
  ) {
    throw new TypeError("Skill Hub snapshots with blockers must remain blocked or revoked.");
  }
  validateTimestamp(input.createdAt, "created-at");
}

function validateStoredSnapshot(input: SkillHubSnapshotRecord): void {
  validateSnapshotInput(input);
  if (!isSkillUpstreamAuditFloorV1(input.auditFloor)) {
    throw new TypeError("Skill Hub audit floor is malformed.");
  }
  assertCanonicalHash(input.auditFloor, input.auditFloorSha256, "audit floor");
  for (const blocker of input.auditFloor.effectiveBlockerCodes) {
    if (!input.blockerCodes.includes(blocker)) {
      throw new TypeError("Skill Hub snapshot omits an effective audit-floor blocker.");
    }
  }
}

function validateAudit(value: Record<string, unknown>): void {
  assertBoundedContentFreeMetadata(value, "audit");
  if (!isSkillUpstreamAuditDetails(value)) throw new TypeError("Skill Hub audit details are malformed.");
}

function validatePermissionEnvelope(value: Record<string, unknown>): void {
  assertBoundedContentFreeMetadata(value, "permission envelope");
  if (!isSkillPermissionEnvelopeV1(value)) throw new TypeError("Skill Hub permission envelope is malformed.");
}

function validatePermissionDiff(value: Record<string, unknown>): void {
  assertBoundedContentFreeMetadata(value, "permission diff");
  assertExactKeys(value, ["version", "disposition", "dimensions"], "permission diff");
  if (value.version !== "goatcitadel.skill-permission-diff.v1") {
    throw new TypeError("Unsupported Skill Hub permission diff version.");
  }
  if (!new Set(["none", "narrowed", "widened", "mixed", "unknown"]).has(String(value.disposition))) {
    throw new TypeError("Unsupported Skill Hub permission diff disposition.");
  }
  assertRecord(value.dimensions, "permission diff dimensions");
  const dimensionNames = [
    "toolIds",
    "environmentVariableNames",
    "networkOrigins",
    "filesystemReadScopes",
    "filesystemWriteScopes",
    "scripts",
    "packages",
    "nativeRequirements",
  ];
  assertExactKeys(value.dimensions, dimensionNames, "permission diff dimensions");
  for (const name of dimensionNames) {
    const dimension = value.dimensions[name];
    assertRecord(dimension, `permission diff ${name}`);
    assertExactKeys(dimension, ["added", "removed"], `permission diff ${name}`);
    validateBoundedStringArray(dimension.added, `permission diff ${name} additions`, 256, 2_048);
    validateBoundedStringArray(dimension.removed, `permission diff ${name} removals`, 256, 2_048);
  }
}

function validateVersionClaim(row: SkillHubVersionClaimRow): void {
  assertCanonicalIdentity(row.workspace_id, "version claim workspace ID", 256);
  assertCanonicalIdentity(row.canonical_source_key, "version claim source key", 1_024);
  if (row.version_kind !== "declared" && row.version_kind !== "resolved") {
    throw new Error("Skill Hub version claim contains an invalid version kind.");
  }
  assertCanonicalIdentity(row.version_value, "version claim value", 512);
  assertSha256(row.first_tree_sha256, "version claim tree");
  assertCanonicalIdentity(row.first_snapshot_id, "version claim snapshot ID", 256);
  validateTimestamp(row.created_at, "version claim created-at");
}

function assertCanonicalHash(value: unknown, claimed: string, label: string): void {
  assertSha256(claimed, label);
  const actual = canonicalHash(value);
  if (actual !== claimed) throw new TypeError(`Skill Hub ${label} hash does not match canonical JSON.`);
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

function validateBoundedStringArray(value: unknown, label: string, maxItems: number, maxLength: number): void {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new TypeError(`Skill Hub ${label} is missing or oversized.`);
  for (const item of value) assertBounded(item as string | undefined, label, maxLength);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Skill Hub ${label} must be an object.`);
}

function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new TypeError(`Skill Hub ${label} contains unknown or missing keys.`);
  }
}

function validateOptional(value: string | undefined, label: string, maxLength: number): void {
  if (value !== undefined) assertBounded(value, label, maxLength);
}

function validateOptionalCanonical(value: string | undefined, label: string, maxLength: number): void {
  if (value !== undefined) assertCanonicalIdentity(value, label, maxLength);
}

function assertBounded(value: string | undefined, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`Skill Hub ${label} is missing or too long.`);
  }
}

function assertCanonicalIdentity(value: string | undefined, label: string, maxLength: number): asserts value is string {
  assertBounded(value, label, maxLength);
  if (value !== value.normalize("NFKC").trim()) {
    throw new TypeError(`Skill Hub ${label} must use its canonical identity form.`);
  }
}

function validateTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Skill Hub ${label} must be a canonical ISO timestamp.`);
  }
}

function assertBoundedContentFreeMetadata(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Skill Hub ${label} must be an object.`);
  }
  const counter = { entries: 0 };
  inspectMetadata(value, 0, counter, label);
  if (Buffer.byteLength(canonicalJsonString(value), "utf8") > 16_384) {
    throw new TypeError(`Skill Hub ${label} exceeds the canonical byte limit.`);
  }
}

function inspectMetadata(value: unknown, depth: number, counter: { entries: number }, label: string): void {
  if (depth > 6) throw new TypeError(`Skill Hub ${label} exceeds the nesting depth limit.`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Skill Hub ${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 2_048) throw new TypeError(`Skill Hub ${label} contains an oversized string.`);
    return;
  }
  if (Array.isArray(value)) {
    counter.entries += value.length;
    assertEntryBudget(counter, label);
    for (const item of value) inspectMetadata(item, depth + 1, counter, label);
    return;
  }
  if (!value || typeof value !== "object") throw new TypeError(`Skill Hub ${label} contains an unsupported value.`);
  const entries = Object.entries(value);
  counter.entries += entries.length;
  assertEntryBudget(counter, label);
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || isForbiddenMetadataKey(key)) {
      throw new TypeError(`Skill Hub ${label} contains forbidden or invalid key '${key}'.`);
    }
    inspectMetadata(item, depth + 1, counter, label);
  }
}

function assertEntryBudget(counter: { entries: number }, label: string): void {
  if (counter.entries > 128) throw new TypeError(`Skill Hub ${label} exceeds the entry limit.`);
}

function isForbiddenMetadataKey(key: string): boolean {
  return FORBIDDEN_METADATA_KEYS.has(
    key
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]/gu, ""),
  );
}

const FORBIDDEN_METADATA_KEYS = new Set([
  "apikey",
  "authorization",
  "body",
  "content",
  "cookie",
  "cookies",
  "correctedbehavior",
  "credential",
  "credentials",
  "message",
  "messages",
  "password",
  "plaintext",
  "privatekey",
  "prompt",
  "raw",
  "rawcontent",
  "rawtext",
  "response",
  "secret",
  "secrets",
  "sourcetext",
  "text",
  "token",
  "tokens",
]);

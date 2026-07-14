import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  assertSkillHubArtifactManifest,
  assertSkillHubSha256,
  canonicalJsonString,
  skillHubArtifactBundleRelPath,
  type SkillHubSnapshotArtifactRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface SkillHubSnapshotArtifactRow {
  artifact_id: string;
  workspace_id: string;
  snapshot_id: string;
  content_tree_sha256: string;
  bundle_rel_path: string;
  manifest_version: "goatcitadel.skill-tree.v1";
  manifest_json: string;
  manifest_sha256: string;
  file_count: number | string;
  total_bytes: number | string;
  created_at: string;
}

export class SkillHubArtifactRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly findBySnapshotStmt;
  private readonly listByTreeStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO skill_hub_snapshot_artifacts (
        artifact_id, workspace_id, snapshot_id, content_tree_sha256, bundle_rel_path,
        manifest_version, manifest_json, manifest_sha256, file_count, total_bytes, created_at
      ) VALUES (
        @artifactId, @workspaceId, @snapshotId, @contentTreeSha256, @bundleRelPath,
        @manifestVersion, @manifestJson, @manifestSha256, @fileCount, @totalBytes, @createdAt
      )
      ON CONFLICT(artifact_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM skill_hub_snapshot_artifacts WHERE artifact_id = ?");
    this.findBySnapshotStmt = db.prepare(`
      SELECT * FROM skill_hub_snapshot_artifacts
      WHERE workspace_id = @workspaceId AND snapshot_id = @snapshotId
    `);
    this.listByTreeStmt = db.prepare(`
      SELECT * FROM skill_hub_snapshot_artifacts
      WHERE workspace_id = @workspaceId AND content_tree_sha256 = @contentTreeSha256
      ORDER BY created_at DESC, artifact_id DESC
      LIMIT @limit
    `);
  }

  public create(input: SkillHubSnapshotArtifactRecord): SkillHubSnapshotArtifactRecord {
    validateArtifact(input);
    const existingById = this.find(input.artifactId);
    if (existingById) return assertArtifactReplay(existingById, input);
    const existingBySnapshot = this.findBySnapshot(input.workspaceId, input.snapshotId);
    if (existingBySnapshot) return assertArtifactReplay(existingBySnapshot, input);

    try {
      this.insertStmt.run({
        artifactId: input.artifactId,
        workspaceId: input.workspaceId,
        snapshotId: input.snapshotId,
        contentTreeSha256: input.contentTreeSha256,
        bundleRelPath: input.bundleRelPath,
        manifestVersion: input.manifest.manifestVersion,
        manifestJson: canonicalJsonString(input.manifest),
        manifestSha256: input.manifestSha256,
        fileCount: input.fileCount,
        totalBytes: input.totalBytes,
        createdAt: input.createdAt,
      });
    } catch (error) {
      const raced = this.find(input.artifactId) ?? this.findBySnapshot(input.workspaceId, input.snapshotId);
      if (raced) return assertArtifactReplay(raced, input);
      throw error;
    }
    return assertArtifactReplay(this.get(input.artifactId), input);
  }

  public get(artifactId: string): SkillHubSnapshotArtifactRecord {
    assertCanonicalIdentity(artifactId, "artifact ID", 256);
    const row = this.getStmt.get(artifactId) as SkillHubSnapshotArtifactRow | undefined;
    if (!row) throw new NotFoundError({ entity: "Skill Hub snapshot artifact", id: artifactId });
    return mapAndValidateArtifact(row);
  }

  public find(artifactId: string): SkillHubSnapshotArtifactRecord | undefined {
    assertCanonicalIdentity(artifactId, "artifact ID", 256);
    const row = this.getStmt.get(artifactId) as SkillHubSnapshotArtifactRow | undefined;
    return row ? mapAndValidateArtifact(row) : undefined;
  }

  public findBySnapshot(workspaceId: string, snapshotId: string): SkillHubSnapshotArtifactRecord | undefined {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    assertCanonicalIdentity(snapshotId, "snapshot ID", 256);
    const row = this.findBySnapshotStmt.get({ workspaceId, snapshotId }) as SkillHubSnapshotArtifactRow | undefined;
    return row ? mapAndValidateArtifact(row) : undefined;
  }

  public listByTree(workspaceId: string, contentTreeSha256: string, limit = 100): SkillHubSnapshotArtifactRecord[] {
    assertCanonicalIdentity(workspaceId, "workspace ID", 256);
    assertSkillHubSha256(contentTreeSha256, "content tree");
    return (
      (
        this.listByTreeStmt.all({ workspaceId, contentTreeSha256, limit: normalizeLimit(limit) }) as
          | SkillHubSnapshotArtifactRow[]
          | undefined
      )?.map(mapAndValidateArtifact) ?? []
    );
  }
}

export function computeSkillHubManifestSha256(manifest: SkillHubSnapshotArtifactRecord["manifest"]): string {
  assertSkillHubArtifactManifest(manifest);
  return createHash("sha256").update(canonicalJsonString(manifest), "utf8").digest("hex");
}

export function computeSkillHubTreeSha256(manifest: SkillHubSnapshotArtifactRecord["manifest"]): string {
  assertSkillHubArtifactManifest(manifest);
  const hash = createHash("sha256");
  hash.update(`${manifest.manifestVersion}\0`, "utf8");
  for (const file of manifest.files) {
    const pathBytes = Buffer.byteLength(file.path, "utf8");
    hash.update(`${pathBytes}:${file.path}\0${file.bytes}:${file.sha256}\0`, "utf8");
  }
  return hash.digest("hex");
}

function mapAndValidateArtifact(row: SkillHubSnapshotArtifactRow): SkillHubSnapshotArtifactRecord {
  const record: SkillHubSnapshotArtifactRecord = {
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    snapshotId: row.snapshot_id,
    contentTreeSha256: row.content_tree_sha256,
    bundleRelPath: row.bundle_rel_path,
    manifest: safeJsonParse<SkillHubSnapshotArtifactRecord["manifest"]>(row.manifest_json, undefined as never),
    manifestSha256: row.manifest_sha256,
    fileCount: Number(row.file_count),
    totalBytes: Number(row.total_bytes),
    createdAt: row.created_at,
  };
  validateArtifact(record);
  return record;
}

function validateArtifact(input: SkillHubSnapshotArtifactRecord): void {
  assertCanonicalIdentity(input.artifactId, "artifact ID", 256);
  assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
  assertCanonicalIdentity(input.snapshotId, "snapshot ID", 256);
  assertSkillHubSha256(input.contentTreeSha256, "content tree");
  if (input.bundleRelPath !== skillHubArtifactBundleRelPath(input.contentTreeSha256)) {
    throw new TypeError("Skill Hub artifact bundle path is not the canonical content-addressed path.");
  }
  assertSkillHubArtifactManifest(input.manifest);
  if (input.manifest.treeSha256 !== input.contentTreeSha256) {
    throw new TypeError("Skill Hub artifact manifest tree does not match its snapshot linkage.");
  }
  if (computeSkillHubTreeSha256(input.manifest) !== input.contentTreeSha256) {
    throw new TypeError("Skill Hub artifact manifest tree digest does not match its file entries.");
  }
  assertSkillHubSha256(input.manifestSha256, "manifest");
  if (computeSkillHubManifestSha256(input.manifest) !== input.manifestSha256) {
    throw new TypeError("Skill Hub artifact manifest digest does not match canonical JSON.");
  }
  if (input.fileCount !== input.manifest.fileCount || input.totalBytes !== input.manifest.totalBytes) {
    throw new TypeError("Skill Hub artifact counters do not match its manifest.");
  }
  assertCanonicalTimestamp(input.createdAt, "artifact created-at");
}

function assertArtifactReplay(
  stored: SkillHubSnapshotArtifactRecord,
  attempted: SkillHubSnapshotArtifactRecord,
): SkillHubSnapshotArtifactRecord {
  if (canonicalJsonString(stored) !== canonicalJsonString(attempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Skill Hub snapshot artifact ${attempted.artifactId} conflicts with an immutable record.`,
    });
  }
  return stored;
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value)) throw new TypeError("Skill Hub artifact list limit must be an integer.");
  return Math.max(1, Math.min(value, 500));
}

function assertCanonicalIdentity(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || !value || value.length > maxLength || value !== value.normalize("NFKC").trim()) {
    throw new TypeError(`Skill Hub ${label} must use its bounded canonical identity form.`);
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Skill Hub ${label} must be a canonical ISO timestamp.`);
  }
}

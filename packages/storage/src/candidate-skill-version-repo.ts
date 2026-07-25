import {
  ConflictError,
  NotFoundError,
  canonicalJsonString,
  type CandidateSkillVersionRecord,
  type CapabilityArtifactRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface CandidateSkillVersionRow {
  candidate_id: string;
  version_id: string;
  source_kind: CandidateSkillVersionRecord["sourceKind"];
  workspace_id: string | null;
  source_fingerprint: string | null;
  upstream_snapshot_id: string | null;
  supersedes_version_id: string | null;
  created_by_actor_id: string | null;
  title: string;
  summary: string | null;
  bundle_root: string;
  originating_run_id: string | null;
  wrapper_manifest_hash: string | null;
  lifecycle_state: CandidateSkillVersionRecord["lifecycleState"];
  manifest_artifact_json: string;
  instruction_artifact_json: string;
  proof_artifact_json: string;
  program_artifact_json: string | null;
  schema_artifact_json: string | null;
  created_at: string;
  updated_at: string;
  last_successful_execution_at: string | null;
}

export class CandidateSkillVersionRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listByCandidateIdStmt;
  private readonly findLatestByCandidateIdStmt;
  private readonly updateLifecycleStateStmt;
  private readonly getUpstreamSnapshotWorkspaceStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO candidate_skill_versions (
        candidate_id, version_id, source_kind, workspace_id, source_fingerprint, upstream_snapshot_id,
        supersedes_version_id, created_by_actor_id, title, summary, bundle_root, originating_run_id, wrapper_manifest_hash,
        lifecycle_state, manifest_artifact_json, instruction_artifact_json, proof_artifact_json, program_artifact_json,
        schema_artifact_json, created_at, updated_at, last_successful_execution_at
      ) VALUES (
        @candidateId, @versionId, @sourceKind, @workspaceId, @sourceFingerprint, @upstreamSnapshotId,
        @supersedesVersionId, @createdByActorId, @title, @summary, @bundleRoot, @originatingRunId, @wrapperManifestHash,
        @lifecycleState, @manifestArtifactJson, @instructionArtifactJson, @proofArtifactJson, @programArtifactJson,
        @schemaArtifactJson, @createdAt, @updatedAt, @lastSuccessfulExecutionAt
      )
      ON CONFLICT(version_id) DO NOTHING
    `);
    this.getStmt = db.prepare("SELECT * FROM candidate_skill_versions WHERE version_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM candidate_skill_versions
      ORDER BY updated_at DESC, version_id DESC
      LIMIT @limit
    `);
    this.listByCandidateIdStmt = db.prepare(`
      SELECT * FROM candidate_skill_versions
      WHERE candidate_id = @candidateId
      ORDER BY updated_at DESC, version_id DESC
      LIMIT @limit
    `);
    this.findLatestByCandidateIdStmt = db.prepare(`
      SELECT * FROM candidate_skill_versions
      WHERE candidate_id = @candidateId
      ORDER BY created_at DESC, version_id DESC
      LIMIT 1
    `);
    this.updateLifecycleStateStmt = db.prepare(`
      UPDATE candidate_skill_versions
      SET lifecycle_state = @lifecycleState,
          updated_at = @updatedAt
      WHERE version_id = @versionId
    `);
    this.getUpstreamSnapshotWorkspaceStmt = db.prepare(
      "SELECT workspace_id, content_tree_sha256 FROM skill_hub_snapshots WHERE snapshot_id = ?",
    );
  }

  public upsert(input: CandidateSkillVersionRecord): CandidateSkillVersionRecord {
    const normalized = this.normalizeAndValidateLineage(input);
    validateCandidateRecord(normalized);
    if (normalized.lifecycleState !== "draft" && normalized.lifecycleState !== "candidate") {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Candidate skill version ${normalized.versionId} must be inserted or replayed inactive.`,
      });
    }
    const existing = this.find(normalized.versionId);
    if (existing) {
      assertImmutableReplay(existing, normalized);
      return existing;
    }
    this.insertStmt.run({
      candidateId: normalized.candidateId,
      versionId: normalized.versionId,
      sourceKind: normalized.sourceKind,
      workspaceId: normalized.workspaceId ?? null,
      sourceFingerprint: normalized.sourceFingerprint ?? null,
      upstreamSnapshotId: normalized.upstreamSnapshotId ?? null,
      supersedesVersionId: normalized.supersedesVersionId ?? null,
      createdByActorId: normalized.createdByActorId ?? null,
      title: normalized.title,
      summary: normalized.summary ?? null,
      bundleRoot: normalized.bundleRoot,
      originatingRunId: normalized.originatingRunId ?? null,
      wrapperManifestHash: normalized.wrapperManifestHash ?? null,
      lifecycleState: normalized.lifecycleState,
      manifestArtifactJson: canonicalJsonString(normalized.manifestArtifact),
      instructionArtifactJson: canonicalJsonString(normalized.instructionArtifact),
      proofArtifactJson: canonicalJsonString(normalized.proofArtifact),
      programArtifactJson: normalized.programArtifact ? canonicalJsonString(normalized.programArtifact) : null,
      schemaArtifactJson: normalized.schemaArtifact ? canonicalJsonString(normalized.schemaArtifact) : null,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      lastSuccessfulExecutionAt: normalized.lastSuccessfulExecutionAt ?? null,
    });
    const stored = this.get(normalized.versionId);
    assertImmutableReplay(stored, normalized);
    return stored;
  }

  public get(versionId: string): CandidateSkillVersionRecord {
    assertCanonicalIdentity(versionId, "version ID", 256);
    const row = this.getStmt.get(versionId) as CandidateSkillVersionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "candidate skill version", id: versionId });
    }
    return this.mapAndValidateRow(row);
  }

  public find(versionId: string): CandidateSkillVersionRecord | undefined {
    assertCanonicalIdentity(versionId, "version ID", 256);
    const row = this.getStmt.get(versionId) as CandidateSkillVersionRow | undefined;
    return row ? this.mapAndValidateRow(row) : undefined;
  }

  public list(limit = 100): CandidateSkillVersionRecord[] {
    return (this.listStmt.all({ limit: normalizeLimit(limit) }) as unknown as CandidateSkillVersionRow[]).map((row) =>
      this.mapAndValidateRow(row),
    );
  }

  public listByCandidateId(candidateId: string, limit = 100): CandidateSkillVersionRecord[] {
    assertCanonicalIdentity(candidateId, "candidate ID", 256);
    return (
      this.listByCandidateIdStmt.all({
        candidateId,
        limit: normalizeLimit(limit),
      }) as unknown as CandidateSkillVersionRow[]
    ).map((row) => this.mapAndValidateRow(row));
  }

  public findLatestByCandidateId(candidateId: string): CandidateSkillVersionRecord | undefined {
    assertCanonicalIdentity(candidateId, "candidate ID", 256);
    const row = this.findLatestByCandidateIdStmt.get({ candidateId }) as CandidateSkillVersionRow | undefined;
    return row ? this.mapAndValidateRow(row) : undefined;
  }

  public updateLifecycleState(
    versionId: string,
    lifecycleState: CandidateSkillVersionRecord["lifecycleState"],
    updatedAt = new Date().toISOString(),
  ): CandidateSkillVersionRecord {
    assertCanonicalTimestamp(updatedAt, "updated-at");
    this.get(versionId);
    this.updateLifecycleStateStmt.run({
      versionId,
      lifecycleState,
      updatedAt,
    });
    return this.get(versionId);
  }

  private mapAndValidateRow(row: CandidateSkillVersionRow): CandidateSkillVersionRecord {
    const record = mapCandidateSkillVersionRow(row);
    const normalized = this.normalizeAndValidateLineage(record);
    validateCandidateRecord(normalized);
    return normalized;
  }

  private normalizeAndValidateLineage(input: CandidateSkillVersionRecord): CandidateSkillVersionRecord {
    const lineageValues = [
      input.workspaceId,
      input.sourceFingerprint,
      input.upstreamSnapshotId,
      input.supersedesVersionId,
      input.createdByActorId,
    ];
    const hasLineage = lineageValues.some((value) => value !== undefined);
    if (!hasLineage) {
      if (input.lineageStatus !== undefined && input.lineageStatus !== "legacy_missing") {
        throw new TypeError("Candidate skill version cannot claim governed lineage without lineage fields.");
      }
      return { ...input, lineageStatus: "legacy_missing" };
    }
    if (!input.workspaceId || !input.sourceFingerprint || !input.createdByActorId) {
      throw new TypeError(
        "Governed candidate skill versions require workspace, source fingerprint, and creating actor lineage.",
      );
    }
    if (input.lineageStatus !== undefined && input.lineageStatus !== "governed") {
      throw new TypeError("Candidate skill version lineage fields conflict with legacy lineage status.");
    }
    assertCanonicalIdentity(input.workspaceId, "workspace ID", 256);
    assertSha256(input.sourceFingerprint, "source fingerprint");
    assertCanonicalIdentity(input.createdByActorId, "creating actor ID", 256);
    if (input.upstreamSnapshotId) {
      assertCanonicalIdentity(input.upstreamSnapshotId, "upstream snapshot ID", 256);
      const upstream = this.getUpstreamSnapshotWorkspaceStmt.get(input.upstreamSnapshotId) as
        | { workspace_id?: string; content_tree_sha256?: string }
        | undefined;
      if (
        !upstream ||
        upstream.workspace_id !== input.workspaceId ||
        upstream.content_tree_sha256 !== input.sourceFingerprint
      ) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Candidate skill version references a missing, foreign-scope, or different-byte upstream snapshot.",
        });
      }
    }
    if (input.sourceKind === "upstream_hub" && !input.upstreamSnapshotId) {
      throw new TypeError("Upstream Hub candidate skill versions require an upstream snapshot lineage reference.");
    }
    if (input.supersedesVersionId) {
      assertCanonicalIdentity(input.supersedesVersionId, "superseded version ID", 256);
      if (input.supersedesVersionId === input.versionId) {
        throw new TypeError("Candidate skill version cannot supersede itself.");
      }
      const supersededRow = this.getStmt.get(input.supersedesVersionId) as CandidateSkillVersionRow | undefined;
      if (
        !supersededRow ||
        supersededRow.candidate_id !== input.candidateId ||
        (supersededRow.workspace_id !== null && supersededRow.workspace_id !== input.workspaceId)
      ) {
        throw new ConflictError({
          code: "WRITE_CONFLICT",
          message: "Candidate skill version references a missing or foreign candidate lineage predecessor.",
        });
      }
    }
    return { ...input, lineageStatus: "governed" };
  }
}

function assertImmutableReplay(stored: CandidateSkillVersionRecord, attempted: CandidateSkillVersionRecord): void {
  const immutableStored = immutableCandidateSkillVersionFields(stored);
  const immutableAttempted = immutableCandidateSkillVersionFields(attempted);
  if (canonicalJsonString(immutableStored) !== canonicalJsonString(immutableAttempted)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `Candidate skill version ${attempted.versionId} conflicts with an existing immutable record.`,
    });
  }
}

function immutableCandidateSkillVersionFields(input: CandidateSkillVersionRecord): Record<string, unknown> {
  return {
    candidateId: input.candidateId,
    versionId: input.versionId,
    sourceKind: input.sourceKind,
    lineageStatus: input.lineageStatus,
    workspaceId: input.workspaceId,
    sourceFingerprint: input.sourceFingerprint,
    upstreamSnapshotId: input.upstreamSnapshotId,
    supersedesVersionId: input.supersedesVersionId,
    createdByActorId: input.createdByActorId,
    title: input.title,
    summary: input.summary,
    bundleRoot: input.bundleRoot,
    originatingRunId: input.originatingRunId,
    wrapperManifestHash: input.wrapperManifestHash,
    manifestArtifact: input.manifestArtifact,
    instructionArtifact: input.instructionArtifact,
    proofArtifact: input.proofArtifact,
    programArtifact: input.programArtifact,
    schemaArtifact: input.schemaArtifact,
    createdAt: input.createdAt,
  };
}

function mapCandidateSkillVersionRow(row: CandidateSkillVersionRow): CandidateSkillVersionRecord {
  return {
    candidateId: row.candidate_id,
    versionId: row.version_id,
    sourceKind: row.source_kind,
    lineageStatus:
      row.workspace_id ||
      row.source_fingerprint ||
      row.upstream_snapshot_id ||
      row.supersedes_version_id ||
      row.created_by_actor_id
        ? "governed"
        : "legacy_missing",
    workspaceId: row.workspace_id ?? undefined,
    sourceFingerprint: row.source_fingerprint ?? undefined,
    upstreamSnapshotId: row.upstream_snapshot_id ?? undefined,
    supersedesVersionId: row.supersedes_version_id ?? undefined,
    createdByActorId: row.created_by_actor_id ?? undefined,
    title: row.title,
    summary: row.summary ?? undefined,
    bundleRoot: row.bundle_root,
    originatingRunId: row.originating_run_id ?? undefined,
    wrapperManifestHash: row.wrapper_manifest_hash ?? undefined,
    lifecycleState: row.lifecycle_state,
    manifestArtifact: parseArtifact(row.manifest_artifact_json, "manifest"),
    instructionArtifact: parseArtifact(row.instruction_artifact_json, "instruction"),
    proofArtifact: parseArtifact(row.proof_artifact_json, "proof"),
    programArtifact: row.program_artifact_json ? parseArtifact(row.program_artifact_json, "program") : undefined,
    schemaArtifact: row.schema_artifact_json ? parseArtifact(row.schema_artifact_json, "schema") : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessfulExecutionAt: row.last_successful_execution_at ?? undefined,
  } as CandidateSkillVersionRecord;
}

function validateCandidateRecord(input: CandidateSkillVersionRecord): void {
  if (!CANDIDATE_SKILL_SOURCE_KINDS.has(input.sourceKind)) {
    throw new TypeError("Candidate skill source kind is unsupported.");
  }
  if (GOVERNED_CANDIDATE_SKILL_SOURCE_KINDS.has(input.sourceKind) && input.lineageStatus !== "governed") {
    throw new TypeError(`Candidate skill source kind ${input.sourceKind} requires governed lineage.`);
  }
  if (!new Set(["draft", "candidate", "approved", "trusted", "deprecated", "revoked"]).has(input.lifecycleState)) {
    throw new TypeError("Candidate skill lifecycle state is unsupported.");
  }
  assertCanonicalIdentity(input.candidateId, "candidate ID", 256);
  assertCanonicalIdentity(input.versionId, "version ID", 256);
  assertCanonicalIdentity(input.title, "title", 512);
  assertCanonicalIdentity(input.bundleRoot, "bundle root", 2_048);
  if (input.summary !== undefined && input.summary.length > 4_096)
    throw new TypeError("Candidate skill summary is too long.");
  if (input.originatingRunId !== undefined) assertCanonicalIdentity(input.originatingRunId, "originating run ID", 256);
  if (input.wrapperManifestHash !== undefined) assertCanonicalIdentity(input.wrapperManifestHash, "wrapper hash", 512);
  validateArtifact(input.manifestArtifact, "manifest");
  validateArtifact(input.instructionArtifact, "instruction");
  validateArtifact(input.proofArtifact, "proof");
  if (input.programArtifact) validateArtifact(input.programArtifact, "program");
  if (input.schemaArtifact) validateArtifact(input.schemaArtifact, "schema");
  assertCanonicalTimestamp(input.createdAt, "created-at");
  assertCanonicalTimestamp(input.updatedAt, "updated-at");
  if (input.lastSuccessfulExecutionAt) assertCanonicalTimestamp(input.lastSuccessfulExecutionAt, "last execution");
}

const CANDIDATE_SKILL_SOURCE_KINDS = new Set<CandidateSkillVersionRecord["sourceKind"]>([
  "code_mode_generated",
  "manual",
  "learned_correction",
  "history_workshop",
  "upstream_hub",
]);

const GOVERNED_CANDIDATE_SKILL_SOURCE_KINDS = new Set<CandidateSkillVersionRecord["sourceKind"]>([
  "learned_correction",
  "history_workshop",
  "upstream_hub",
]);

function parseArtifact(value: string, label: string): CapabilityArtifactRecord {
  const parsed = safeJsonParse<unknown>(value, undefined);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Candidate skill version contains malformed ${label} artifact JSON.`);
  }
  validateArtifact(parsed as CapabilityArtifactRecord, label);
  return parsed as CapabilityArtifactRecord;
}

function validateArtifact(input: CapabilityArtifactRecord, label: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`Candidate skill ${label} artifact must be an object.`);
  }
  const allowed = new Set(["artifactId", "relPath", "sha256", "bytes", "mimeType", "createdAt"]);
  const keys = Object.keys(input);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new TypeError(`Candidate skill ${label} artifact contains unknown or missing fields.`);
  }
  assertCanonicalIdentity(input.artifactId, `${label} artifact ID`, 256);
  assertCanonicalIdentity(input.relPath, `${label} artifact path`, 2_048);
  const pathSegments = input.relPath.replaceAll("\\", "/").split("/");
  if (
    input.relPath.startsWith("/") ||
    input.relPath.startsWith("\\") ||
    /^[A-Za-z]:/u.test(input.relPath) ||
    pathSegments.includes("..") ||
    containsAsciiControlCharacter(input.relPath)
  ) {
    throw new TypeError(`Candidate skill ${label} artifact path must stay relative and traversal-free.`);
  }
  assertSha256(input.sha256, `${label} artifact`);
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > 536_870_912) {
    throw new TypeError(`Candidate skill ${label} artifact byte count is invalid.`);
  }
  assertCanonicalIdentity(input.mimeType, `${label} artifact MIME type`, 256);
  assertCanonicalTimestamp(input.createdAt, `${label} artifact created-at`);
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError("Candidate skill version list limit must be a finite integer.");
  }
  return Math.max(1, Math.min(value, 500));
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertCanonicalIdentity(value: string, label: string, maxLength: number): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    value !== value.normalize("NFKC").trim()
  ) {
    throw new TypeError(`Candidate skill ${label} is missing, oversized, or noncanonical.`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`Candidate skill ${label} must be a SHA-256 digest.`);
}

function assertCanonicalTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`Candidate skill ${label} must be a canonical ISO timestamp.`);
  }
}

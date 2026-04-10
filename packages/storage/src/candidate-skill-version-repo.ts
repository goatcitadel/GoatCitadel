import type { CandidateSkillVersionRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { CapabilityArtifactRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface CandidateSkillVersionRow {
  candidate_id: string;
  version_id: string;
  source_kind: CandidateSkillVersionRecord["sourceKind"];
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
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listByCandidateIdStmt;
  private readonly updateLifecycleStateStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO candidate_skill_versions (
        candidate_id, version_id, source_kind, title, summary, bundle_root, originating_run_id, wrapper_manifest_hash,
        lifecycle_state, manifest_artifact_json, instruction_artifact_json, proof_artifact_json, program_artifact_json,
        schema_artifact_json, created_at, updated_at, last_successful_execution_at
      ) VALUES (
        @candidateId, @versionId, @sourceKind, @title, @summary, @bundleRoot, @originatingRunId, @wrapperManifestHash,
        @lifecycleState, @manifestArtifactJson, @instructionArtifactJson, @proofArtifactJson, @programArtifactJson,
        @schemaArtifactJson, @createdAt, @updatedAt, @lastSuccessfulExecutionAt
      )
      ON CONFLICT(version_id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        bundle_root = excluded.bundle_root,
        wrapper_manifest_hash = excluded.wrapper_manifest_hash,
        lifecycle_state = excluded.lifecycle_state,
        manifest_artifact_json = excluded.manifest_artifact_json,
        instruction_artifact_json = excluded.instruction_artifact_json,
        proof_artifact_json = excluded.proof_artifact_json,
        program_artifact_json = excluded.program_artifact_json,
        schema_artifact_json = excluded.schema_artifact_json,
        updated_at = excluded.updated_at,
        last_successful_execution_at = excluded.last_successful_execution_at
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
    this.updateLifecycleStateStmt = db.prepare(`
      UPDATE candidate_skill_versions
      SET lifecycle_state = @lifecycleState,
          updated_at = @updatedAt
      WHERE version_id = @versionId
    `);
  }

  public upsert(input: CandidateSkillVersionRecord): CandidateSkillVersionRecord {
    this.upsertStmt.run({
      candidateId: input.candidateId,
      versionId: input.versionId,
      sourceKind: input.sourceKind,
      title: input.title,
      summary: input.summary ?? null,
      bundleRoot: input.bundleRoot,
      originatingRunId: input.originatingRunId ?? null,
      wrapperManifestHash: input.wrapperManifestHash ?? null,
      lifecycleState: input.lifecycleState,
      manifestArtifactJson: JSON.stringify(input.manifestArtifact),
      instructionArtifactJson: JSON.stringify(input.instructionArtifact),
      proofArtifactJson: JSON.stringify(input.proofArtifact),
      programArtifactJson: input.programArtifact ? JSON.stringify(input.programArtifact) : null,
      schemaArtifactJson: input.schemaArtifact ? JSON.stringify(input.schemaArtifact) : null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      lastSuccessfulExecutionAt: input.lastSuccessfulExecutionAt ?? null,
    });
    return this.get(input.versionId);
  }

  public get(versionId: string): CandidateSkillVersionRecord {
    const row = this.getStmt.get(versionId) as CandidateSkillVersionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "candidate skill version", id: versionId });
    }
    return mapCandidateSkillVersionRow(row);
  }

  public find(versionId: string): CandidateSkillVersionRecord | undefined {
    const row = this.getStmt.get(versionId) as CandidateSkillVersionRow | undefined;
    return row ? mapCandidateSkillVersionRow(row) : undefined;
  }

  public list(limit = 100): CandidateSkillVersionRecord[] {
    return (this.listStmt.all({ limit }) as unknown as CandidateSkillVersionRow[]).map(mapCandidateSkillVersionRow);
  }

  public listByCandidateId(candidateId: string, limit = 100): CandidateSkillVersionRecord[] {
    return (
      this.listByCandidateIdStmt.all({
        candidateId,
        limit,
      }) as unknown as CandidateSkillVersionRow[]
    ).map(mapCandidateSkillVersionRow);
  }

  public findLatestByCandidateId(candidateId: string): CandidateSkillVersionRecord | undefined {
    return this.listByCandidateId(candidateId, 1)[0];
  }

  public updateLifecycleState(
    versionId: string,
    lifecycleState: CandidateSkillVersionRecord["lifecycleState"],
    updatedAt = new Date().toISOString(),
  ): CandidateSkillVersionRecord {
    this.get(versionId);
    this.updateLifecycleStateStmt.run({
      versionId,
      lifecycleState,
      updatedAt,
    });
    return this.get(versionId);
  }
}

function mapCandidateSkillVersionRow(row: CandidateSkillVersionRow): CandidateSkillVersionRecord {
  return {
    candidateId: row.candidate_id,
    versionId: row.version_id,
    sourceKind: row.source_kind,
    title: row.title,
    summary: row.summary ?? undefined,
    bundleRoot: row.bundle_root,
    originatingRunId: row.originating_run_id ?? undefined,
    wrapperManifestHash: row.wrapper_manifest_hash ?? undefined,
    lifecycleState: row.lifecycle_state,
    manifestArtifact: safeJsonParse<CapabilityArtifactRecord>(
      row.manifest_artifact_json,
      {} as CapabilityArtifactRecord,
    ),
    instructionArtifact: safeJsonParse<CapabilityArtifactRecord>(
      row.instruction_artifact_json,
      {} as CapabilityArtifactRecord,
    ),
    proofArtifact: safeJsonParse<CapabilityArtifactRecord>(row.proof_artifact_json, {} as CapabilityArtifactRecord),
    programArtifact: row.program_artifact_json ? safeJsonParse(row.program_artifact_json, undefined) : undefined,
    schemaArtifact: row.schema_artifact_json ? safeJsonParse(row.schema_artifact_json, undefined) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessfulExecutionAt: row.last_successful_execution_at ?? undefined,
  } as CandidateSkillVersionRecord;
}

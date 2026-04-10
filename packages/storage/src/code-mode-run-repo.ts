import type { CodeModeRunRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { CapabilityArtifactRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface CodeModeRunRow {
  run_id: string;
  status: CodeModeRunRecord["status"];
  language: CodeModeRunRecord["language"];
  requested_output_intent: string | null;
  save_candidate_on_success: number;
  capability_snapshot_id: string;
  wrapper_manifest_hash: string;
  policy_snapshot_hash: string;
  code_hash: string;
  approval_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  code_artifact_json: string;
  wrapper_manifest_artifact_json: string;
  policy_snapshot_artifact_json: string;
  stdout_artifact_json: string | null;
  stderr_artifact_json: string | null;
  stdout_preview: string | null;
  stderr_preview: string | null;
  stdout_truncated: number;
  stderr_truncated: number;
  result_json: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class CodeModeRunRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO code_mode_runs (
        run_id, status, language, requested_output_intent, save_candidate_on_success, capability_snapshot_id,
        wrapper_manifest_hash, policy_snapshot_hash, code_hash, approval_id, session_id, turn_id, code_artifact_json,
        wrapper_manifest_artifact_json, policy_snapshot_artifact_json, stdout_artifact_json, stderr_artifact_json,
        stdout_preview, stderr_preview, stdout_truncated, stderr_truncated, result_json, error_text, created_at,
        started_at, finished_at
      ) VALUES (
        @runId, @status, @language, @requestedOutputIntent, @saveCandidateOnSuccess, @capabilitySnapshotId,
        @wrapperManifestHash, @policySnapshotHash, @codeHash, @approvalId, @sessionId, @turnId, @codeArtifactJson,
        @wrapperManifestArtifactJson, @policySnapshotArtifactJson, @stdoutArtifactJson, @stderrArtifactJson,
        @stdoutPreview, @stderrPreview, @stdoutTruncated, @stderrTruncated, @resultJson, @errorText, @createdAt,
        @startedAt, @finishedAt
      )
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        requested_output_intent = excluded.requested_output_intent,
        approval_id = excluded.approval_id,
        stdout_artifact_json = excluded.stdout_artifact_json,
        stderr_artifact_json = excluded.stderr_artifact_json,
        stdout_preview = excluded.stdout_preview,
        stderr_preview = excluded.stderr_preview,
        stdout_truncated = excluded.stdout_truncated,
        stderr_truncated = excluded.stderr_truncated,
        result_json = excluded.result_json,
        error_text = excluded.error_text,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at
    `);
    this.getStmt = db.prepare("SELECT * FROM code_mode_runs WHERE run_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
  }

  public upsert(input: CodeModeRunRecord): CodeModeRunRecord {
    this.upsertStmt.run({
      runId: input.runId,
      status: input.status,
      language: input.language,
      requestedOutputIntent: input.requestedOutputIntent ?? null,
      saveCandidateOnSuccess: input.saveCandidateOnSuccess ? 1 : 0,
      capabilitySnapshotId: input.capabilitySnapshotId,
      wrapperManifestHash: input.wrapperManifestHash,
      policySnapshotHash: input.policySnapshotHash,
      codeHash: input.codeHash,
      approvalId: input.approvalId ?? null,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      codeArtifactJson: JSON.stringify(input.codeArtifact),
      wrapperManifestArtifactJson: JSON.stringify(input.wrapperManifestArtifact),
      policySnapshotArtifactJson: JSON.stringify(input.policySnapshotArtifact),
      stdoutArtifactJson: input.stdoutArtifact ? JSON.stringify(input.stdoutArtifact) : null,
      stderrArtifactJson: input.stderrArtifact ? JSON.stringify(input.stderrArtifact) : null,
      stdoutPreview: input.stdoutPreview ?? null,
      stderrPreview: input.stderrPreview ?? null,
      stdoutTruncated: input.stdoutTruncated ? 1 : 0,
      stderrTruncated: input.stderrTruncated ? 1 : 0,
      resultJson: input.result ? JSON.stringify(input.result) : null,
      errorText: input.error ?? null,
      createdAt: input.createdAt,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
    });
    return this.get(input.runId);
  }

  public get(runId: string): CodeModeRunRecord {
    const row = this.getStmt.get(runId) as CodeModeRunRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "code mode run", id: runId });
    }
    return mapCodeModeRunRow(row);
  }

  public find(runId: string): CodeModeRunRecord | undefined {
    const row = this.getStmt.get(runId) as CodeModeRunRow | undefined;
    return row ? mapCodeModeRunRow(row) : undefined;
  }

  public list(limit = 100): CodeModeRunRecord[] {
    return (this.listStmt.all({ limit }) as unknown as CodeModeRunRow[]).map(mapCodeModeRunRow);
  }
}

function mapCodeModeRunRow(row: CodeModeRunRow): CodeModeRunRecord {
  return {
    runId: row.run_id,
    status: row.status,
    language: row.language,
    requestedOutputIntent: row.requested_output_intent ?? undefined,
    saveCandidateOnSuccess: row.save_candidate_on_success === 1,
    capabilitySnapshotId: row.capability_snapshot_id,
    wrapperManifestHash: row.wrapper_manifest_hash,
    policySnapshotHash: row.policy_snapshot_hash,
    codeHash: row.code_hash,
    approvalId: row.approval_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    codeArtifact: safeJsonParse<CapabilityArtifactRecord>(row.code_artifact_json, {} as CapabilityArtifactRecord),
    wrapperManifestArtifact: safeJsonParse<CapabilityArtifactRecord>(
      row.wrapper_manifest_artifact_json,
      {} as CapabilityArtifactRecord,
    ),
    policySnapshotArtifact: safeJsonParse<CapabilityArtifactRecord>(
      row.policy_snapshot_artifact_json,
      {} as CapabilityArtifactRecord,
    ),
    stdoutArtifact: row.stdout_artifact_json ? safeJsonParse(row.stdout_artifact_json, undefined) : undefined,
    stderrArtifact: row.stderr_artifact_json ? safeJsonParse(row.stderr_artifact_json, undefined) : undefined,
    stdoutPreview: row.stdout_preview ?? undefined,
    stderrPreview: row.stderr_preview ?? undefined,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    result: row.result_json ? safeJsonParse(row.result_json, {}) : undefined,
    error: row.error_text ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}



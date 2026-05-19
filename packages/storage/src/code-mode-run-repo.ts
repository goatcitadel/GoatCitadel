import type { CodeModeRunRecord } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { CapabilityArtifactRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface CodeModeRunRow {
  run_id: string;
  status: CodeModeRunRecord["status"];
  language: CodeModeRunRecord["language"];
  origin_surface: CodeModeRunRecord["originSurface"] | null;
  workspace_id: string | null;
  operator_id: string | null;
  permission_profile_id: string | null;
  permission_profile_label: string | null;
  local_operator_override_id: string | null;
  requested_output_intent: string | null;
  save_candidate_on_success: number;
  capability_snapshot_id: string;
  code_mode_input_hash: string | null;
  wrapper_manifest_hash: string;
  policy_snapshot_hash: string;
  code_hash: string;
  approval_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  sandbox_json: string | null;
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
  error_code: string | null;
  error_details_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class CodeModeRunRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listFilteredStmt;
  private readonly listFilteredForStatusHydrationStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO code_mode_runs (
        run_id, status, language, origin_surface, workspace_id, operator_id, permission_profile_id, permission_profile_label,
        local_operator_override_id, requested_output_intent, save_candidate_on_success, capability_snapshot_id,
        code_mode_input_hash, wrapper_manifest_hash, policy_snapshot_hash, code_hash, approval_id, session_id, turn_id, sandbox_json, code_artifact_json,
        wrapper_manifest_artifact_json, policy_snapshot_artifact_json, stdout_artifact_json, stderr_artifact_json,
        stdout_preview, stderr_preview, stdout_truncated, stderr_truncated, result_json, error_text, error_code,
        error_details_json, created_at, started_at, finished_at
      ) VALUES (
        @runId, @status, @language, @originSurface, @workspaceId, @operatorId, @permissionProfileId, @permissionProfileLabel,
        @localOperatorOverrideId, @requestedOutputIntent, @saveCandidateOnSuccess, @capabilitySnapshotId,
        @codeModeInputHash, @wrapperManifestHash, @policySnapshotHash, @codeHash, @approvalId, @sessionId, @turnId, @sandboxJson, @codeArtifactJson,
        @wrapperManifestArtifactJson, @policySnapshotArtifactJson, @stdoutArtifactJson, @stderrArtifactJson,
        @stdoutPreview, @stderrPreview, @stdoutTruncated, @stderrTruncated, @resultJson, @errorText, @errorCode,
        @errorDetailsJson, @createdAt, @startedAt, @finishedAt
      )
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        sandbox_json = excluded.sandbox_json,
        stdout_artifact_json = excluded.stdout_artifact_json,
        stderr_artifact_json = excluded.stderr_artifact_json,
        stdout_preview = excluded.stdout_preview,
        stderr_preview = excluded.stderr_preview,
        stdout_truncated = excluded.stdout_truncated,
        stderr_truncated = excluded.stderr_truncated,
        result_json = excluded.result_json,
        error_text = excluded.error_text,
        error_code = excluded.error_code,
        error_details_json = excluded.error_details_json,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at
    `);
    this.getStmt = db.prepare("SELECT * FROM code_mode_runs WHERE run_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.listFilteredStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      WHERE (@workspaceId IS NULL OR workspace_id = @workspaceId)
        AND (@sessionId IS NULL OR session_id = @sessionId)
        AND (@turnId IS NULL OR turn_id = @turnId)
        AND (@status IS NULL OR status = @status)
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.listFilteredForStatusHydrationStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      WHERE (@workspaceId IS NULL OR workspace_id = @workspaceId)
        AND (@sessionId IS NULL OR session_id = @sessionId)
        AND (@turnId IS NULL OR turn_id = @turnId)
        AND (status = @status OR (@includeApprovalPending = 1 AND status = 'approval_pending'))
      ORDER BY created_at DESC, run_id DESC
    `);
  }

  public upsert(input: CodeModeRunRecord): CodeModeRunRecord {
    this.upsertStmt.run({
      runId: input.runId,
      status: input.status,
      language: input.language,
      originSurface: input.originSurface ?? null,
      workspaceId: input.workspaceId ?? null,
      operatorId: input.operatorId ?? null,
      permissionProfileId: input.permissionProfileId ?? null,
      permissionProfileLabel: input.permissionProfileLabel ?? null,
      localOperatorOverrideId: input.localOperatorOverrideId ?? null,
      requestedOutputIntent: input.requestedOutputIntent ?? null,
      saveCandidateOnSuccess: input.saveCandidateOnSuccess ? 1 : 0,
      capabilitySnapshotId: input.capabilitySnapshotId,
      codeModeInputHash: input.codeModeInputHash,
      wrapperManifestHash: input.wrapperManifestHash,
      policySnapshotHash: input.policySnapshotHash,
      codeHash: input.codeHash,
      approvalId: input.approvalId ?? null,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      sandboxJson: input.sandbox ? JSON.stringify(input.sandbox) : null,
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
      errorCode: input.errorCode ?? null,
      errorDetailsJson: input.errorDetails ? JSON.stringify(input.errorDetails) : null,
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

  public listFiltered(options: {
    limit?: number;
    workspaceId?: string;
    sessionId?: string;
    turnId?: string;
    status?: CodeModeRunRecord["status"];
  }): CodeModeRunRecord[] {
    return (
      this.listFilteredStmt.all({
        limit: normalizeCodeModeRunLimit(options.limit),
        workspaceId: options.workspaceId ?? null,
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
        status: options.status ?? null,
      }) as unknown as CodeModeRunRow[]
    ).map(mapCodeModeRunRow);
  }

  public listFilteredForStatusHydration(options: {
    workspaceId?: string;
    sessionId?: string;
    turnId?: string;
    status: CodeModeRunRecord["status"];
  }): CodeModeRunRecord[] {
    const includeApprovalPending = options.status === "expired" || options.status === "approval_pending";
    return (
      this.listFilteredForStatusHydrationStmt.all({
        workspaceId: options.workspaceId ?? null,
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
        status: options.status,
        includeApprovalPending: includeApprovalPending ? 1 : 0,
      }) as unknown as CodeModeRunRow[]
    ).map(mapCodeModeRunRow);
  }
}

function normalizeCodeModeRunLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 100;
}

function mapCodeModeRunRow(row: CodeModeRunRow): CodeModeRunRecord {
  return {
    runId: row.run_id,
    status: row.status,
    language: row.language,
    originSurface: row.origin_surface ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    operatorId: row.operator_id ?? undefined,
    permissionProfileId: row.permission_profile_id ?? undefined,
    permissionProfileLabel: row.permission_profile_label ?? undefined,
    localOperatorOverrideId: row.local_operator_override_id ?? undefined,
    requestedOutputIntent: row.requested_output_intent ?? undefined,
    saveCandidateOnSuccess: row.save_candidate_on_success === 1,
    capabilitySnapshotId: row.capability_snapshot_id,
    codeModeInputHash: row.code_mode_input_hash ?? "",
    wrapperManifestHash: row.wrapper_manifest_hash,
    policySnapshotHash: row.policy_snapshot_hash,
    codeHash: row.code_hash,
    approvalId: row.approval_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    sandbox: row.sandbox_json
      ? parseCodeModeJson<CodeModeRunRecord["sandbox"]>(row, "sandbox_json", row.sandbox_json)
      : undefined,
    codeArtifact: parseRequiredCodeModeJson<CapabilityArtifactRecord>(
      row,
      "code_artifact_json",
      row.code_artifact_json,
    ),
    wrapperManifestArtifact: parseRequiredCodeModeJson<CapabilityArtifactRecord>(
      row,
      "wrapper_manifest_artifact_json",
      row.wrapper_manifest_artifact_json,
    ),
    policySnapshotArtifact: parseRequiredCodeModeJson<CapabilityArtifactRecord>(
      row,
      "policy_snapshot_artifact_json",
      row.policy_snapshot_artifact_json,
    ),
    stdoutArtifact: row.stdout_artifact_json
      ? parseCodeModeJson<CapabilityArtifactRecord>(row, "stdout_artifact_json", row.stdout_artifact_json)
      : undefined,
    stderrArtifact: row.stderr_artifact_json
      ? parseCodeModeJson<CapabilityArtifactRecord>(row, "stderr_artifact_json", row.stderr_artifact_json)
      : undefined,
    stdoutPreview: row.stdout_preview ?? undefined,
    stderrPreview: row.stderr_preview ?? undefined,
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    result: row.result_json
      ? parseCodeModeJson<Record<string, unknown>>(row, "result_json", row.result_json)
      : undefined,
    error: row.error_text ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorDetails: row.error_details_json
      ? parseCodeModeJson<Record<string, unknown>>(row, "error_details_json", row.error_details_json)
      : undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

function parseRequiredCodeModeJson<T>(row: CodeModeRunRow, fieldName: string, raw: string | null | undefined): T {
  if (!raw) {
    throw new Error(`Code Mode run ${row.run_id} is missing required ${fieldName} metadata.`);
  }
  return parseCodeModeJson<T>(row, fieldName, raw);
}

function parseCodeModeJson<T>(row: CodeModeRunRow, fieldName: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Code Mode run ${row.run_id} has corrupt ${fieldName} metadata: ${detail}`, {
      cause: error,
    });
  }
}

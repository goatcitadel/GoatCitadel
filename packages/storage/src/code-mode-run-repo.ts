/* eslint-disable max-lines -- This established owner exceeds the line limit; decomposition belongs in a separate behavior-preserving tranche. */
import { createHash } from "node:crypto";
import type {
  CodeModeRunRecord,
  CodeModeRunVerificationState,
  CodeModeVerificationEvidenceRecord,
} from "@goatcitadel/contracts";
import { NotFoundError, redactStructuredSecrets } from "@goatcitadel/contracts";
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
  execution_backend_json: string | null;
  code_artifact_json: string;
  wrapper_manifest_artifact_json: string;
  policy_snapshot_artifact_json: string;
  stdout_artifact_json: string | null;
  stderr_artifact_json: string | null;
  stdout_preview: string | null;
  stderr_preview: string | null;
  stdout_truncated: number;
  stderr_truncated: number;
  trusted_code_write_verification_json: string | null;
  verification_status: CodeModeRunVerificationState["status"] | null;
  verification_evidence_id: string | null;
  verification_subject_hash: string | null;
  verification_reason: string | null;
  verification_updated_at: string | null;
  execution_generation: number | string;
  execution_phase: CodeModeRunRecord["executionRecovery"]["phase"];
  recovery_disposition: CodeModeRunRecord["executionRecovery"]["disposition"];
  execution_boundary_crossed_at: string | null;
  interrupted_at: string | null;
  interruption_reason: string | null;
  final_transcript_event_id: string | null;
  final_transcript_enqueued_at: string | null;
  result_json: string | null;
  error_text: string | null;
  error_code: string | null;
  error_details_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface CodeModeVerificationEvidenceRow {
  sequence: number;
  evidence_id: string;
  run_id: string;
  status: CodeModeVerificationEvidenceRecord["status"];
  subject_hash: string;
  command_name: CodeModeVerificationEvidenceRecord["commandName"];
  command_label: string;
  scope: CodeModeVerificationEvidenceRecord["scope"];
  evidence_json: string;
  created_at: string;
}

const MAX_CODE_MODE_VERIFICATION_EVIDENCE_BYTES = 64 * 1024;
const MAX_CODE_MODE_RECOVERY_REASON_BYTES = 1_024;
const MAX_CODE_MODE_ERROR_TEXT_BYTES = 4 * 1_024;
const MAX_CODE_MODE_ERROR_DETAILS_BYTES = 16 * 1_024;
const MAX_CODE_MODE_ERROR_DETAIL_DEPTH = 6;
const MAX_CODE_MODE_ERROR_DETAIL_NODES = 256;

export class CodeModeRunRepository {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listFilteredStmt;
  private readonly listFilteredForFailedHydrationStmt;
  private readonly listFilteredForStatusHydrationStmt;
  private readonly claimForExecutionStmt;
  private readonly releaseExecutionClaimStmt;
  private readonly markExecutionBoundaryCrossedStmt;
  private readonly resetExecutionBoundaryBeforeDispatchStmt;
  private readonly recordExecutionOutputStmt;
  private readonly markExecutionInterruptedStmt;
  private readonly failExecutionClaimBeforeDispatchStmt;
  private readonly finishExecutionClaimStmt;
  private readonly listPendingFinalTranscriptStmt;
  private readonly listPendingFinalTranscriptPageStmt;
  private readonly markFinalTranscriptEnqueuedStmt;
  private readonly appendVerificationEvidenceStmt;
  private readonly updateVerificationStateStmt;
  private readonly listVerificationEvidenceStmt;

  public constructor(private readonly db: DatabaseClient) {
    const optionalTextFilter = (column: string, param: string) =>
      buildOptionalCodeModeTextFilterSql(this.db.dialect, column, param);
    this.upsertStmt = db.prepare(`
      INSERT INTO code_mode_runs (
        run_id, status, language, origin_surface, workspace_id, operator_id, permission_profile_id, permission_profile_label,
        local_operator_override_id, requested_output_intent, save_candidate_on_success, capability_snapshot_id,
        code_mode_input_hash, wrapper_manifest_hash, policy_snapshot_hash, code_hash, approval_id, session_id, turn_id, sandbox_json, execution_backend_json, code_artifact_json,
        wrapper_manifest_artifact_json, policy_snapshot_artifact_json, stdout_artifact_json, stderr_artifact_json,
        stdout_preview, stderr_preview, stdout_truncated, stderr_truncated, trusted_code_write_verification_json,
        verification_status, verification_evidence_id, verification_subject_hash, verification_reason,
        verification_updated_at, execution_generation, execution_phase, recovery_disposition,
        execution_boundary_crossed_at, interrupted_at, interruption_reason, final_transcript_event_id,
        final_transcript_enqueued_at, result_json, error_text, error_code, error_details_json, created_at, started_at, finished_at
      ) VALUES (
        @runId, @status, @language, @originSurface, @workspaceId, @operatorId, @permissionProfileId, @permissionProfileLabel,
        @localOperatorOverrideId, @requestedOutputIntent, @saveCandidateOnSuccess, @capabilitySnapshotId,
        @codeModeInputHash, @wrapperManifestHash, @policySnapshotHash, @codeHash, @approvalId, @sessionId, @turnId, @sandboxJson, @executionBackendJson, @codeArtifactJson,
        @wrapperManifestArtifactJson, @policySnapshotArtifactJson, @stdoutArtifactJson, @stderrArtifactJson,
        @stdoutPreview, @stderrPreview, @stdoutTruncated, @stderrTruncated, @trustedCodeWriteVerificationJson,
        @verificationStatus, @verificationEvidenceId, @verificationSubjectHash, @verificationReason,
        @verificationUpdatedAt, @executionGeneration, @executionPhase, @recoveryDisposition,
        @executionBoundaryCrossedAt, @interruptedAt, @interruptionReason, @finalTranscriptEventId,
        @finalTranscriptEnqueuedAt, @resultJson, @errorText, @errorCode, @errorDetailsJson, @createdAt, @startedAt, @finishedAt
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
        trusted_code_write_verification_json = excluded.trusted_code_write_verification_json,
        verification_status = excluded.verification_status,
        verification_evidence_id = excluded.verification_evidence_id,
        verification_subject_hash = excluded.verification_subject_hash,
        verification_reason = excluded.verification_reason,
        verification_updated_at = excluded.verification_updated_at,
        execution_generation = code_mode_runs.execution_generation,
        execution_phase = excluded.execution_phase,
        recovery_disposition = excluded.recovery_disposition,
        execution_boundary_crossed_at = COALESCE(code_mode_runs.execution_boundary_crossed_at, excluded.execution_boundary_crossed_at),
        interrupted_at = COALESCE(code_mode_runs.interrupted_at, excluded.interrupted_at),
        interruption_reason = COALESCE(code_mode_runs.interruption_reason, excluded.interruption_reason),
        final_transcript_event_id = COALESCE(code_mode_runs.final_transcript_event_id, excluded.final_transcript_event_id),
        final_transcript_enqueued_at = COALESCE(code_mode_runs.final_transcript_enqueued_at, excluded.final_transcript_enqueued_at),
        result_json = excluded.result_json,
        error_text = excluded.error_text,
        error_code = excluded.error_code,
        error_details_json = excluded.error_details_json,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at
      WHERE code_mode_runs.execution_generation = excluded.execution_generation
        AND code_mode_runs.status <> 'running'
        AND code_mode_runs.recovery_disposition <> 'manual_reconciliation'
        AND (
          code_mode_runs.status = excluded.status
          OR (
            code_mode_runs.status IN ('queued', 'approval_pending')
            AND excluded.status IN ('failed', 'rejected', 'expired')
          )
          OR (
            code_mode_runs.status = 'completed'
            AND excluded.status = 'failed'
            AND excluded.error_code = 'candidate_stage_failed'
          )
        )
    `);
    this.getStmt = db.prepare("SELECT * FROM code_mode_runs WHERE run_id = ?");
    this.listStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.listFilteredStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      WHERE ${optionalTextFilter("workspace_id", "@workspaceId")}
        AND ${optionalTextFilter("session_id", "@sessionId")}
        AND ${optionalTextFilter("turn_id", "@turnId")}
        AND ${optionalTextFilter("status", "@status")}
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.listFilteredForFailedHydrationStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      WHERE ${optionalTextFilter("workspace_id", "@workspaceId")}
        AND ${optionalTextFilter("session_id", "@sessionId")}
        AND ${optionalTextFilter("turn_id", "@turnId")}
      ORDER BY created_at DESC, run_id DESC
      LIMIT @scanLimit
    `);
    this.listFilteredForStatusHydrationStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      WHERE ${optionalTextFilter("workspace_id", "@workspaceId")}
        AND ${optionalTextFilter("session_id", "@sessionId")}
        AND ${optionalTextFilter("turn_id", "@turnId")}
        AND (status = @status OR (@includeApprovalPending = 1 AND status = 'approval_pending'))
      ORDER BY created_at DESC, run_id DESC
      LIMIT @scanLimit
    `);
    this.listPendingFinalTranscriptStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      WHERE session_id IS NOT NULL
        AND status IN ('completed', 'failed')
        AND final_transcript_event_id IS NOT NULL
        AND final_transcript_enqueued_at IS NULL
      ORDER BY COALESCE(finished_at, created_at) ASC, run_id ASC
      LIMIT @limit
    `);
    this.listPendingFinalTranscriptPageStmt = db.prepare(`
      SELECT * FROM code_mode_runs
      WHERE session_id IS NOT NULL
        AND status IN ('completed', 'failed')
        AND final_transcript_event_id IS NOT NULL
        AND final_transcript_enqueued_at IS NULL
        AND (
          COALESCE(finished_at, created_at) > @afterFinishedAt
          OR (COALESCE(finished_at, created_at) = @afterFinishedAt AND run_id > @afterRunId)
        )
      ORDER BY COALESCE(finished_at, created_at) ASC, run_id ASC
      LIMIT @limit
    `);
    this.claimForExecutionStmt = db.prepare(`
      UPDATE code_mode_runs
      SET
        status = 'running',
        sandbox_json = @sandboxJson,
        execution_generation = execution_generation + 1,
        execution_phase = 'claimed',
        recovery_disposition = 'none',
        execution_boundary_crossed_at = NULL,
        interrupted_at = NULL,
        interruption_reason = NULL,
        started_at = @startedAt,
        finished_at = NULL,
        error_text = NULL,
        error_code = NULL,
        error_details_json = NULL,
        verification_status = 'not_applicable',
        verification_evidence_id = NULL,
        verification_subject_hash = NULL,
        verification_reason = NULL,
        verification_updated_at = @startedAt
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'approval_pending'
        AND execution_phase = 'not_started'
    `);
    this.releaseExecutionClaimStmt = db.prepare(`
      UPDATE code_mode_runs
      SET
        status = 'approval_pending',
        sandbox_json = @sandboxJson,
        started_at = NULL,
        finished_at = NULL,
        error_text = NULL,
        error_code = NULL,
        error_details_json = NULL,
        execution_phase = 'not_started',
        recovery_disposition = 'retryable',
        interrupted_at = @interruptedAt,
        interruption_reason = @interruptionReason
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'running'
        AND started_at = @startedAt
        AND execution_generation = @executionGeneration
        AND execution_phase = 'claimed'
    `);
    this.markExecutionBoundaryCrossedStmt = db.prepare(`
      UPDATE code_mode_runs
      SET execution_phase = 'boundary_crossed',
          execution_boundary_crossed_at = @boundaryCrossedAt
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'running'
        AND started_at = @startedAt
        AND execution_generation = @executionGeneration
        AND execution_phase = 'claimed'
    `);
    this.resetExecutionBoundaryBeforeDispatchStmt = db.prepare(`
      UPDATE code_mode_runs
      SET execution_phase = 'claimed',
          execution_boundary_crossed_at = NULL
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'running'
        AND started_at = @startedAt
        AND execution_generation = @executionGeneration
        AND execution_phase = 'boundary_crossed'
    `);
    this.recordExecutionOutputStmt = db.prepare(`
      UPDATE code_mode_runs
      SET sandbox_json = @sandboxJson,
          stdout_artifact_json = @stdoutArtifactJson,
          stderr_artifact_json = @stderrArtifactJson,
          stdout_preview = @stdoutPreview,
          stderr_preview = @stderrPreview,
          stdout_truncated = @stdoutTruncated,
          stderr_truncated = @stderrTruncated,
          trusted_code_write_verification_json = @trustedCodeWriteVerificationJson,
          result_json = @resultJson,
          error_text = @errorText,
          error_code = @errorCode,
          error_details_json = @errorDetailsJson,
          execution_phase = @executionPhase
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'running'
        AND started_at = @startedAt
        AND execution_generation = @executionGeneration
        AND execution_phase = 'boundary_crossed'
    `);
    this.markExecutionInterruptedStmt = db.prepare(`
      UPDATE code_mode_runs
      SET status = 'failed',
          execution_phase = 'terminal',
          recovery_disposition = 'manual_reconciliation',
          interrupted_at = @interruptedAt,
          interruption_reason = @interruptionReason,
          error_text = @errorText,
          error_code = 'execution_interrupted_after_boundary',
          error_details_json = @errorDetailsJson,
          verification_status = 'not_applicable',
          verification_evidence_id = NULL,
          verification_subject_hash = NULL,
          verification_reason = NULL,
          verification_updated_at = @interruptedAt,
          finished_at = @interruptedAt
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'running'
        AND ${optionalTextFilter("started_at", "@startedAt")}
        AND execution_generation = @executionGeneration
        AND execution_phase IN ('boundary_crossed', 'output_captured_completed', 'output_captured_failed', 'legacy_unknown')
    `);
    this.failExecutionClaimBeforeDispatchStmt = db.prepare(`
      UPDATE code_mode_runs
      SET status = 'failed',
          execution_phase = 'terminal',
          recovery_disposition = 'terminal',
          interrupted_at = NULL,
          interruption_reason = NULL,
          error_text = @errorText,
          error_code = @errorCode,
          error_details_json = @errorDetailsJson,
          verification_status = 'not_applicable',
          verification_evidence_id = NULL,
          verification_subject_hash = NULL,
          verification_reason = NULL,
          verification_updated_at = @finishedAt,
          finished_at = @finishedAt
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'running'
        AND started_at = @startedAt
        AND execution_generation = @executionGeneration
        AND execution_phase = 'claimed'
    `);
    this.finishExecutionClaimStmt = db.prepare(`
      UPDATE code_mode_runs
      SET
        status = @status,
        sandbox_json = @sandboxJson,
        stdout_artifact_json = @stdoutArtifactJson,
        stderr_artifact_json = @stderrArtifactJson,
        stdout_preview = @stdoutPreview,
        stderr_preview = @stderrPreview,
        stdout_truncated = @stdoutTruncated,
        stderr_truncated = @stderrTruncated,
        trusted_code_write_verification_json = @trustedCodeWriteVerificationJson,
        verification_status = @verificationStatus,
        verification_evidence_id = @verificationEvidenceId,
        verification_subject_hash = @verificationSubjectHash,
        verification_reason = @verificationReason,
        verification_updated_at = @verificationUpdatedAt,
        result_json = @resultJson,
        error_text = @errorText,
        error_code = @errorCode,
        error_details_json = @errorDetailsJson,
        execution_phase = 'terminal',
        recovery_disposition = @recoveryDisposition,
        interrupted_at = @interruptedAt,
        interruption_reason = @interruptionReason,
        finished_at = @finishedAt
      WHERE run_id = @runId
        AND approval_id = @approvalId
        AND status = 'running'
        AND started_at = @startedAt
        AND execution_generation = @executionGeneration
        AND (
          (@status = 'completed' AND execution_phase = 'output_captured_completed')
          OR (@status = 'failed' AND execution_phase = 'output_captured_failed')
        )
    `);
    this.markFinalTranscriptEnqueuedStmt = db.prepare(`
      UPDATE code_mode_runs
      SET final_transcript_enqueued_at = @enqueuedAt
      WHERE run_id = @runId
        AND status IN ('completed', 'failed')
        AND execution_generation = @executionGeneration
        AND final_transcript_event_id = @eventId
        AND final_transcript_enqueued_at IS NULL
    `);
    this.appendVerificationEvidenceStmt = db.prepare(`
      INSERT INTO code_mode_verification_evidence (
        evidence_id, run_id, status, subject_hash, command_name, command_label, scope, evidence_json, created_at
      ) VALUES (
        @evidenceId, @runId, @status, @subjectHash, @commandName, @commandLabel, @scope, @evidenceJson, @createdAt
      )
    `);
    this.updateVerificationStateStmt = db.prepare(`
      UPDATE code_mode_runs
      SET verification_status = @verificationStatus,
          verification_evidence_id = @verificationEvidenceId,
          verification_subject_hash = @verificationSubjectHash,
          verification_reason = @verificationReason,
          verification_updated_at = @verificationUpdatedAt
      WHERE run_id = @runId
    `);
    this.listVerificationEvidenceStmt = db.prepare(`
      SELECT * FROM code_mode_verification_evidence
      WHERE run_id = @runId
      ORDER BY sequence DESC
      LIMIT @limit
    `);
  }

  public upsert(input: CodeModeRunRecord): CodeModeRunRecord {
    const verification = normalizeCodeModeRunVerification(input);
    const recovery = normalizeCodeModeExecutionRecovery(input);
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
      executionBackendJson: input.executionBackend ? JSON.stringify(input.executionBackend) : null,
      codeArtifactJson: JSON.stringify(input.codeArtifact),
      wrapperManifestArtifactJson: JSON.stringify(input.wrapperManifestArtifact),
      policySnapshotArtifactJson: JSON.stringify(input.policySnapshotArtifact),
      stdoutArtifactJson: input.stdoutArtifact ? JSON.stringify(input.stdoutArtifact) : null,
      stderrArtifactJson: input.stderrArtifact ? JSON.stringify(input.stderrArtifact) : null,
      stdoutPreview: input.stdoutPreview ?? null,
      stderrPreview: input.stderrPreview ?? null,
      stdoutTruncated: input.stdoutTruncated ? 1 : 0,
      stderrTruncated: input.stderrTruncated ? 1 : 0,
      trustedCodeWriteVerificationJson: input.trustedCodeWriteVerification
        ? JSON.stringify(input.trustedCodeWriteVerification)
        : null,
      verificationStatus: verification.status,
      verificationEvidenceId: verification.evidenceId ?? null,
      verificationSubjectHash: verification.subjectHash ?? null,
      verificationReason: verification.reason ?? null,
      verificationUpdatedAt: verification.updatedAt,
      executionGeneration: recovery.generation,
      executionPhase: recovery.phase,
      recoveryDisposition: recovery.disposition,
      executionBoundaryCrossedAt: recovery.boundaryCrossedAt ?? null,
      interruptedAt: recovery.interruptedAt ?? null,
      interruptionReason: sanitizeCodeModeText(recovery.interruptionReason, MAX_CODE_MODE_RECOVERY_REASON_BYTES),
      finalTranscriptEventId: recovery.finalTranscriptEventId ?? null,
      finalTranscriptEnqueuedAt: recovery.finalTranscriptEnqueuedAt ?? null,
      resultJson: input.result ? JSON.stringify(input.result) : null,
      errorText: sanitizeCodeModeText(input.error, MAX_CODE_MODE_ERROR_TEXT_BYTES),
      errorCode: input.errorCode ?? null,
      errorDetailsJson: serializeCodeModeErrorDetails(input.errorDetails),
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
    return mapCodeModeRunRowForRead(row);
  }

  public find(runId: string): CodeModeRunRecord | undefined {
    const row = this.getStmt.get(runId) as CodeModeRunRow | undefined;
    return row ? mapCodeModeRunRowForRead(row) : undefined;
  }

  public list(limit = 100): CodeModeRunRecord[] {
    return (this.listStmt.all({ limit }) as unknown as CodeModeRunRow[]).map(mapCodeModeRunRowForRead);
  }

  public listFiltered(options: {
    limit?: number;
    workspaceId?: string;
    sessionId?: string;
    turnId?: string;
    status?: CodeModeRunRecord["status"];
  }): CodeModeRunRecord[] {
    const limit = normalizeCodeModeRunLimit(options.limit);
    if (options.status === "failed") {
      const scanLimit = normalizeCodeModeRunHydrationScanLimit(limit);
      const statusRows = (
        this.listFilteredStmt.all({
          limit,
          workspaceId: options.workspaceId ?? null,
          sessionId: options.sessionId ?? null,
          turnId: options.turnId ?? null,
          status: "failed",
        }) as unknown as CodeModeRunRow[]
      ).map(mapCodeModeRunRowForRead);
      const hydratedRows = (
        this.listFilteredForFailedHydrationStmt.all({
          workspaceId: options.workspaceId ?? null,
          sessionId: options.sessionId ?? null,
          turnId: options.turnId ?? null,
          scanLimit,
        }) as unknown as CodeModeRunRow[]
      ).map(mapCodeModeRunRowForRead);
      return uniqueCodeModeRunsByRunId([...statusRows, ...hydratedRows])
        .filter((row) => row.status === "failed")
        .slice(0, limit);
    }
    const rows = (
      this.listFilteredStmt.all({
        limit,
        workspaceId: options.workspaceId ?? null,
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
        status: options.status ?? null,
      }) as unknown as CodeModeRunRow[]
    ).map(mapCodeModeRunRowForRead);
    return options.status ? rows.filter((row) => row.status === options.status).slice(0, limit) : rows;
  }

  public listFilteredForStatusHydration(options: {
    workspaceId?: string;
    sessionId?: string;
    turnId?: string;
    status: CodeModeRunRecord["status"];
    limit?: number;
  }): CodeModeRunRecord[] {
    const limit = normalizeCodeModeRunLimit(options.limit);
    const scanLimit = normalizeCodeModeRunHydrationScanLimit(limit);
    if (options.status === "failed") {
      const statusRows = (
        this.listFilteredStmt.all({
          limit: scanLimit,
          workspaceId: options.workspaceId ?? null,
          sessionId: options.sessionId ?? null,
          turnId: options.turnId ?? null,
          status: "failed",
        }) as unknown as CodeModeRunRow[]
      ).map(mapCodeModeRunRowForRead);
      const hydratedRows = (
        this.listFilteredForFailedHydrationStmt.all({
          workspaceId: options.workspaceId ?? null,
          sessionId: options.sessionId ?? null,
          turnId: options.turnId ?? null,
          scanLimit,
        }) as unknown as CodeModeRunRow[]
      ).map(mapCodeModeRunRowForRead);
      return uniqueCodeModeRunsByRunId([...statusRows, ...hydratedRows]);
    }
    const includeApprovalPending =
      options.status === "expired" || options.status === "approval_pending" || options.status === "rejected";
    return (
      this.listFilteredForStatusHydrationStmt.all({
        workspaceId: options.workspaceId ?? null,
        sessionId: options.sessionId ?? null,
        turnId: options.turnId ?? null,
        status: options.status,
        includeApprovalPending: includeApprovalPending ? 1 : 0,
        scanLimit,
      }) as unknown as CodeModeRunRow[]
    ).map(mapCodeModeRunRowForRead);
  }

  public claimForExecution(input: {
    runId: string;
    approvalId: string;
    sandbox?: CodeModeRunRecord["sandbox"];
    startedAt: string;
  }): CodeModeRunRecord | undefined {
    const result = this.claimForExecutionStmt.run({
      runId: input.runId,
      approvalId: input.approvalId,
      sandboxJson: input.sandbox ? JSON.stringify(input.sandbox) : null,
      startedAt: input.startedAt,
    }) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public releaseExecutionClaim(input: {
    runId: string;
    approvalId: string;
    startedAt: string;
    executionGeneration: number;
    interruptedAt: string;
    interruptionReason: string;
    sandbox?: CodeModeRunRecord["sandbox"];
  }): CodeModeRunRecord | undefined {
    const result = this.releaseExecutionClaimStmt.run({
      runId: input.runId,
      approvalId: input.approvalId,
      startedAt: input.startedAt,
      executionGeneration: input.executionGeneration,
      interruptedAt: input.interruptedAt,
      interruptionReason:
        sanitizeCodeModeText(input.interruptionReason, MAX_CODE_MODE_RECOVERY_REASON_BYTES) ??
        "Code Mode execution interruption reason unavailable.",
      sandboxJson: input.sandbox ? JSON.stringify(input.sandbox) : null,
    }) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public markExecutionBoundaryCrossed(input: {
    runId: string;
    approvalId: string;
    startedAt: string;
    executionGeneration: number;
    boundaryCrossedAt: string;
  }): CodeModeRunRecord | undefined {
    const result = this.markExecutionBoundaryCrossedStmt.run(input) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public resetExecutionBoundaryBeforeDispatch(input: {
    runId: string;
    approvalId: string;
    startedAt: string;
    executionGeneration: number;
  }): CodeModeRunRecord | undefined {
    const result = this.resetExecutionBoundaryBeforeDispatchStmt.run(input) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public recordExecutionOutput(
    input: CodeModeRunRecord & {
      approvalId: string;
      startedAt: string;
      executionGeneration: number;
      executionPhase: "output_captured_completed" | "output_captured_failed";
    },
  ): CodeModeRunRecord | undefined {
    const result = this.recordExecutionOutputStmt.run({
      runId: input.runId,
      approvalId: input.approvalId,
      startedAt: input.startedAt,
      executionGeneration: input.executionGeneration,
      executionPhase: input.executionPhase,
      sandboxJson: input.sandbox ? JSON.stringify(input.sandbox) : null,
      stdoutArtifactJson: input.stdoutArtifact ? JSON.stringify(input.stdoutArtifact) : null,
      stderrArtifactJson: input.stderrArtifact ? JSON.stringify(input.stderrArtifact) : null,
      stdoutPreview: input.stdoutPreview ?? null,
      stderrPreview: input.stderrPreview ?? null,
      stdoutTruncated: input.stdoutTruncated ? 1 : 0,
      stderrTruncated: input.stderrTruncated ? 1 : 0,
      trustedCodeWriteVerificationJson: input.trustedCodeWriteVerification
        ? JSON.stringify(input.trustedCodeWriteVerification)
        : null,
      resultJson: input.result ? JSON.stringify(input.result) : null,
      errorText: sanitizeCodeModeText(input.error, MAX_CODE_MODE_ERROR_TEXT_BYTES),
      errorCode: input.errorCode ?? null,
      errorDetailsJson: serializeCodeModeErrorDetails(input.errorDetails),
    }) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public markExecutionInterrupted(input: {
    runId: string;
    approvalId: string;
    startedAt?: string;
    executionGeneration: number;
    interruptedAt: string;
    interruptionReason: string;
    error?: string;
    errorDetails?: Record<string, unknown>;
  }): CodeModeRunRecord | undefined {
    const reason =
      sanitizeCodeModeText(input.interruptionReason, MAX_CODE_MODE_RECOVERY_REASON_BYTES) ??
      "Code Mode execution interruption reason unavailable.";
    const result = this.markExecutionInterruptedStmt.run({
      runId: input.runId,
      approvalId: input.approvalId,
      startedAt: input.startedAt ?? null,
      executionGeneration: input.executionGeneration,
      interruptedAt: input.interruptedAt,
      interruptionReason: reason,
      errorText: sanitizeCodeModeText(
        input.error ?? `Code Mode execution was interrupted after its mutation boundary: ${reason}`,
        MAX_CODE_MODE_ERROR_TEXT_BYTES,
      ),
      errorDetailsJson: serializeCodeModeErrorDetails({
        manualReconciliationRequired: true,
        interruptionReason: reason,
        ...(input.errorDetails ?? {}),
      }),
    }) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public failExecutionClaimBeforeDispatch(input: {
    runId: string;
    approvalId: string;
    startedAt: string;
    executionGeneration: number;
    finishedAt: string;
    error: string;
    errorCode?: string;
    errorDetails?: Record<string, unknown>;
  }): CodeModeRunRecord | undefined {
    const result = this.failExecutionClaimBeforeDispatchStmt.run({
      runId: input.runId,
      approvalId: input.approvalId,
      startedAt: input.startedAt,
      executionGeneration: input.executionGeneration,
      finishedAt: input.finishedAt,
      errorText: sanitizeCodeModeText(input.error, MAX_CODE_MODE_ERROR_TEXT_BYTES),
      errorCode: input.errorCode ?? null,
      errorDetailsJson: serializeCodeModeErrorDetails(input.errorDetails),
    }) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public finishExecutionClaim(
    input: CodeModeRunRecord & {
      approvalId: string;
      status: "completed" | "failed";
      startedAt: string;
      finishedAt: string;
    },
  ): CodeModeRunRecord | undefined {
    const verification = normalizeCodeModeRunVerification(input);
    const result = this.finishExecutionClaimStmt.run({
      runId: input.runId,
      approvalId: input.approvalId,
      status: input.status,
      sandboxJson: input.sandbox ? JSON.stringify(input.sandbox) : null,
      stdoutArtifactJson: input.stdoutArtifact ? JSON.stringify(input.stdoutArtifact) : null,
      stderrArtifactJson: input.stderrArtifact ? JSON.stringify(input.stderrArtifact) : null,
      stdoutPreview: input.stdoutPreview ?? null,
      stderrPreview: input.stderrPreview ?? null,
      stdoutTruncated: input.stdoutTruncated ? 1 : 0,
      stderrTruncated: input.stderrTruncated ? 1 : 0,
      trustedCodeWriteVerificationJson: input.trustedCodeWriteVerification
        ? JSON.stringify(input.trustedCodeWriteVerification)
        : null,
      verificationStatus: verification.status,
      verificationEvidenceId: verification.evidenceId ?? null,
      verificationSubjectHash: verification.subjectHash ?? null,
      verificationReason: verification.reason ?? null,
      verificationUpdatedAt: verification.updatedAt,
      resultJson: input.result ? JSON.stringify(input.result) : null,
      errorText: sanitizeCodeModeText(input.error, MAX_CODE_MODE_ERROR_TEXT_BYTES),
      errorCode: input.errorCode ?? null,
      errorDetailsJson: serializeCodeModeErrorDetails(input.errorDetails),
      startedAt: input.startedAt,
      executionGeneration: input.executionRecovery.generation,
      recoveryDisposition:
        input.executionRecovery.disposition === "manual_reconciliation" ? "manual_reconciliation" : "terminal",
      interruptedAt: input.executionRecovery.interruptedAt ?? null,
      interruptionReason: sanitizeCodeModeText(
        input.executionRecovery.interruptionReason,
        MAX_CODE_MODE_RECOVERY_REASON_BYTES,
      ),
      finishedAt: input.finishedAt,
    }) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public listPendingFinalTranscriptDelivery(limit = 100): CodeModeRunRecord[] {
    return (
      this.listPendingFinalTranscriptStmt.all({
        limit: normalizeCodeModeRunLimit(limit),
      }) as unknown as CodeModeRunRow[]
    ).map(mapCodeModeRunRowForRead);
  }

  public listPendingFinalTranscriptDeliveryPage(
    input: {
      afterFinishedAt?: string;
      afterRunId?: string;
      limit?: number;
    } = {},
  ): CodeModeRunRecord[] {
    if (!input.afterFinishedAt || !input.afterRunId) {
      return this.listPendingFinalTranscriptDelivery(input.limit);
    }
    return (
      this.listPendingFinalTranscriptPageStmt.all({
        afterFinishedAt: input.afterFinishedAt,
        afterRunId: input.afterRunId,
        limit: normalizeCodeModeRunLimit(input.limit),
      }) as unknown as CodeModeRunRow[]
    ).map(mapCodeModeRunRowForRead);
  }

  public markFinalTranscriptEnqueued(input: {
    runId: string;
    executionGeneration: number;
    eventId: string;
    enqueuedAt: string;
  }): CodeModeRunRecord | undefined {
    const result = this.markFinalTranscriptEnqueuedStmt.run(input) as { changes?: number };
    return result.changes && result.changes > 0 ? this.get(input.runId) : undefined;
  }

  public recordVerificationEvidence(input: CodeModeVerificationEvidenceRecord): {
    run: CodeModeRunRecord;
    evidence: CodeModeVerificationEvidenceRecord;
  } {
    const evidence = normalizeCodeModeVerificationEvidence(input);
    const evidenceJson = JSON.stringify(evidence);
    if (Buffer.byteLength(evidenceJson, "utf8") > MAX_CODE_MODE_VERIFICATION_EVIDENCE_BYTES) {
      throw new Error(`Code Mode verification evidence exceeds ${MAX_CODE_MODE_VERIFICATION_EVIDENCE_BYTES} bytes.`);
    }
    return this.db.transaction("immediate", () => {
      const run = this.get(evidence.runId);
      if (run.status !== "completed") {
        throw new Error(`Code Mode run ${evidence.runId} is not eligible for verification.`);
      }
      assertCodeModeVerificationEvidenceMatchesRun(run, evidence);
      this.appendVerificationEvidenceStmt.run({
        evidenceId: evidence.evidenceId,
        runId: evidence.runId,
        status: evidence.status,
        subjectHash: evidence.subject.subjectHash,
        commandName: evidence.commandName,
        commandLabel: evidence.commandLabel,
        scope: evidence.scope,
        evidenceJson,
        createdAt: evidence.createdAt,
      });
      const update = this.updateVerificationStateStmt.run({
        runId: evidence.runId,
        verificationStatus: evidence.status,
        verificationEvidenceId: evidence.evidenceId,
        verificationSubjectHash: evidence.subject.subjectHash,
        verificationReason: evidence.reason ?? null,
        verificationUpdatedAt: evidence.createdAt,
      });
      if (update.changes !== 1) {
        throw new Error(`Code Mode run ${evidence.runId} disappeared while verification evidence was recorded.`);
      }
      return {
        run: this.get(evidence.runId),
        evidence,
      };
    });
  }

  public listVerificationEvidence(runId: string, limit = 50): CodeModeVerificationEvidenceRecord[] {
    this.get(runId);
    const normalizedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.listVerificationEvidenceStmt
      .all({ runId, limit: normalizedLimit })
      .map((row) => mapCodeModeVerificationEvidenceRow(row as CodeModeVerificationEvidenceRow));
  }
}

function normalizeCodeModeRunLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 100;
}

function buildOptionalCodeModeTextFilterSql(dialect: DatabaseClient["dialect"], column: string, param: string): string {
  if (dialect === "postgres") {
    return `(${param}::text IS NULL OR ${column} = ${param}::text)`;
  }
  return `(${param} IS NULL OR ${column} = ${param})`;
}

function normalizeCodeModeRunHydrationScanLimit(limit: number): number {
  return Math.min(limit * 4, 1000);
}

function uniqueCodeModeRunsByRunId(runs: CodeModeRunRecord[]): CodeModeRunRecord[] {
  const seen = new Set<string>();
  const out: CodeModeRunRecord[] = [];
  for (const run of runs) {
    if (seen.has(run.runId)) {
      continue;
    }
    seen.add(run.runId);
    out.push(run);
  }
  return out;
}

function normalizeCodeModeExecutionRecovery(input: CodeModeRunRecord): CodeModeRunRecord["executionRecovery"] {
  const supplied = input.executionRecovery;
  if (supplied) {
    if (!Number.isSafeInteger(supplied.generation) || supplied.generation < 0) {
      throw new TypeError(`Code Mode execution generation must be a non-negative safe integer.`);
    }
    const terminal =
      input.status === "completed" ||
      input.status === "failed" ||
      input.status === "rejected" ||
      input.status === "expired";
    return {
      ...supplied,
      phase: terminal ? "terminal" : supplied.phase,
      disposition: terminal && supplied.disposition !== "manual_reconciliation" ? "terminal" : supplied.disposition,
      interruptionReason:
        sanitizeCodeModeText(supplied.interruptionReason, MAX_CODE_MODE_RECOVERY_REASON_BYTES) ?? undefined,
      finalTranscriptEventId:
        supplied.finalTranscriptEventId ?? (input.sessionId ? `code-mode-final:${input.runId}` : undefined),
    };
  }
  const terminal =
    input.status === "completed" ||
    input.status === "failed" ||
    input.status === "rejected" ||
    input.status === "expired";
  return {
    generation: 0,
    phase: terminal ? "terminal" : input.status === "running" ? "legacy_unknown" : "not_started",
    disposition: terminal ? "terminal" : input.status === "running" ? "manual_reconciliation" : "none",
    finalTranscriptEventId: input.sessionId ? `code-mode-final:${input.runId}` : undefined,
  };
}

function normalizeStoredCodeModeExecutionRecovery(row: CodeModeRunRow): CodeModeRunRecord["executionRecovery"] {
  const generation = Number(row.execution_generation);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`Code Mode run ${row.run_id} has invalid execution_generation.`);
  }
  const phases: CodeModeRunRecord["executionRecovery"]["phase"][] = [
    "not_started",
    "claimed",
    "boundary_crossed",
    "output_captured_completed",
    "output_captured_failed",
    "terminal",
    "legacy_unknown",
  ];
  const dispositions: CodeModeRunRecord["executionRecovery"]["disposition"][] = [
    "none",
    "retryable",
    "manual_reconciliation",
    "terminal",
  ];
  if (!phases.includes(row.execution_phase)) {
    throw new Error(`Code Mode run ${row.run_id} has invalid execution_phase.`);
  }
  if (!dispositions.includes(row.recovery_disposition)) {
    throw new Error(`Code Mode run ${row.run_id} has invalid recovery_disposition.`);
  }
  return {
    generation,
    phase: row.execution_phase,
    disposition: row.recovery_disposition,
    boundaryCrossedAt: row.execution_boundary_crossed_at ?? undefined,
    interruptedAt: row.interrupted_at ?? undefined,
    interruptionReason:
      sanitizeCodeModeText(row.interruption_reason ?? undefined, MAX_CODE_MODE_RECOVERY_REASON_BYTES) ?? undefined,
    finalTranscriptEventId: row.final_transcript_event_id ?? undefined,
    finalTranscriptEnqueuedAt: row.final_transcript_enqueued_at ?? undefined,
  };
}

function normalizeCodeModeRunVerification(input: CodeModeRunRecord): CodeModeRunVerificationState {
  const fallbackUpdatedAt = input.finishedAt ?? input.startedAt ?? input.createdAt;
  if (input.status !== "completed") {
    return {
      status: "not_applicable",
      updatedAt: input.verification?.updatedAt ?? fallbackUpdatedAt,
    };
  }
  const verification = input.verification;
  if (!verification) {
    return {
      status: "completed_unverified",
      reason: "No semantic verification evidence has been recorded.",
      updatedAt: fallbackUpdatedAt,
    };
  }
  if (
    (verification.status === "verified" ||
      verification.status === "verification_failed" ||
      verification.status === "stale") &&
    (!verification.evidenceId || !verification.subjectHash)
  ) {
    return {
      status: "completed_unverified",
      reason: "Legacy or incomplete verification state is not trusted as proof.",
      updatedAt: verification.updatedAt || fallbackUpdatedAt,
    };
  }
  return {
    status: verification.status === "not_applicable" ? "completed_unverified" : verification.status,
    evidenceId: verification.evidenceId,
    subjectHash: verification.subjectHash,
    reason: verification.reason,
    updatedAt: verification.updatedAt || fallbackUpdatedAt,
  };
}

function normalizeStoredCodeModeRunVerification(row: CodeModeRunRow): CodeModeRunVerificationState {
  const fallbackUpdatedAt = row.finished_at ?? row.started_at ?? row.created_at;
  if (row.status !== "completed") {
    return {
      status: "not_applicable",
      updatedAt: row.verification_updated_at || fallbackUpdatedAt,
    };
  }
  const status = row.verification_status;
  if (!status || status === "not_applicable") {
    return {
      status: "completed_unverified",
      reason: row.verification_reason ?? "No semantic verification evidence has been recorded.",
      updatedAt: row.verification_updated_at || fallbackUpdatedAt,
    };
  }
  if (
    (status === "verified" || status === "verification_failed" || status === "stale") &&
    (!row.verification_evidence_id || !row.verification_subject_hash)
  ) {
    return {
      status: "completed_unverified",
      reason: "Legacy or incomplete verification state is not trusted as proof.",
      updatedAt: row.verification_updated_at || fallbackUpdatedAt,
    };
  }
  return {
    status,
    evidenceId: row.verification_evidence_id ?? undefined,
    subjectHash: row.verification_subject_hash ?? undefined,
    reason: row.verification_reason ?? undefined,
    updatedAt: row.verification_updated_at || fallbackUpdatedAt,
  };
}

function normalizeCodeModeVerificationEvidence(
  input: CodeModeVerificationEvidenceRecord,
): CodeModeVerificationEvidenceRecord {
  if (!input.evidenceId || !input.runId || !input.subject.subjectHash) {
    throw new Error("Code Mode verification evidence identity and subject hash are required.");
  }
  if (input.subject.artifacts.length > 10) {
    throw new Error("Code Mode verification evidence cannot bind more than 10 artifacts.");
  }
  const normalized: CodeModeVerificationEvidenceRecord = {
    ...input,
    reason: boundedOptionalText(input.reason, 512),
    commandLabel: boundedText(input.commandLabel, 256),
    command: boundedText(input.command, 128),
    args: input.args.slice(0, 32).map((arg) => boundedText(arg, 512)),
    stdoutPreview: boundedOptionalText(input.stdoutPreview, 4_096),
    stderrPreview: boundedOptionalText(input.stderrPreview, 4_096),
    outputArtifactRefs: input.outputArtifactRefs.slice(0, 10).map((ref) => boundedText(ref, 512)),
    subject: {
      ...input.subject,
      changedFiles: input.subject.changedFiles.slice(0, 200).map((file) => boundedText(file, 1_024)),
      changedFilesTruncated: input.subject.changedFilesTruncated || input.subject.changedFiles.length > 200,
      artifacts: input.subject.artifacts.map((artifact) => ({
        ...artifact,
        relPath: boundedText(artifact.relPath, 2_048),
      })),
    },
  };
  return JSON.parse(JSON.stringify(normalized)) as CodeModeVerificationEvidenceRecord;
}

function assertCodeModeVerificationEvidenceMatchesRun(
  run: CodeModeRunRecord,
  evidence: CodeModeVerificationEvidenceRecord,
): void {
  if (
    evidence.workspaceId !== run.workspaceId ||
    evidence.sessionId !== run.sessionId ||
    evidence.turnId !== run.turnId ||
    evidence.subject.codeModeInputHash !== run.codeModeInputHash ||
    evidence.subject.codeHash !== run.codeHash ||
    evidence.subject.wrapperManifestHash !== run.wrapperManifestHash ||
    evidence.subject.policySnapshotHash !== run.policySnapshotHash
  ) {
    throw new Error(`Code Mode verification evidence ${evidence.evidenceId} does not bind the stored run identity.`);
  }
  if (
    evidence.status === "verified" &&
    (evidence.commandName === "passive_freshness_check" ||
      evidence.commandStatus !== "passed" ||
      evidence.exitCode !== 0 ||
      evidence.subject.artifacts.length === 0 ||
      evidence.subject.artifacts.some((artifact) => !artifact.verified))
  ) {
    throw new Error(`Code Mode verification evidence ${evidence.evidenceId} cannot support a verified claim.`);
  }
}

function mapCodeModeVerificationEvidenceRow(row: CodeModeVerificationEvidenceRow): CodeModeVerificationEvidenceRecord {
  let parsed: CodeModeVerificationEvidenceRecord;
  try {
    parsed = JSON.parse(row.evidence_json) as CodeModeVerificationEvidenceRecord;
  } catch (error) {
    throw new Error(
      `Code Mode verification evidence ${row.evidence_id} has corrupt JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    parsed.evidenceId !== row.evidence_id ||
    parsed.runId !== row.run_id ||
    parsed.status !== row.status ||
    parsed.subject.subjectHash !== row.subject_hash ||
    parsed.commandName !== row.command_name ||
    parsed.commandLabel !== row.command_label ||
    parsed.scope !== row.scope ||
    parsed.createdAt !== row.created_at
  ) {
    throw new Error(`Code Mode verification evidence ${row.evidence_id} does not match its immutable index fields.`);
  }
  return parsed;
}

function boundedOptionalText(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, maxChars);
}

function boundedText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sanitizeCodeModeText(value: string | undefined, maxBytes: number): string | null {
  if (value === undefined) {
    return null;
  }
  const redacted = redactStructuredSecrets(value).value;
  return boundCodeModeUtf8Text(redacted, maxBytes, "…[truncated]");
}

function serializeCodeModeErrorDetails(value: Record<string, unknown> | undefined): string | null {
  if (!value) {
    return null;
  }
  const state = {
    nodes: 0,
    truncated: false,
    ancestors: new WeakSet<object>(),
  };
  const bounded = projectBoundedCodeModeDetail(value, 0, state);
  const redacted = redactStructuredSecrets(bounded).value;
  const serialized = JSON.stringify(redacted);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (!state.truncated && serializedBytes <= MAX_CODE_MODE_ERROR_DETAILS_BYTES) {
    return serialized;
  }
  return JSON.stringify({
    detailsTruncated: true,
    reason: state.truncated
      ? "Code Mode error details exceeded the durable recovery ledger shape limit."
      : "Code Mode error details exceeded the durable recovery ledger byte limit.",
    redactedSha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    redactedBytes: serializedBytes,
    ...(value.manualReconciliationRequired === true ? { manualReconciliationRequired: true } : {}),
  });
}

function projectBoundedCodeModeDetail(
  value: unknown,
  depth: number,
  state: { nodes: number; truncated: boolean; ancestors: WeakSet<object> },
): unknown {
  if (state.nodes >= MAX_CODE_MODE_ERROR_DETAIL_NODES) {
    state.truncated = true;
    return "[detail node limit]";
  }
  state.nodes += 1;
  if (typeof value === "string") {
    return boundCodeModeUtf8Text(value, 2 * 1_024, "…[value truncated]");
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined) {
    return null;
  }
  if (depth >= MAX_CODE_MODE_ERROR_DETAIL_DEPTH) {
    state.truncated = true;
    return "[detail depth limit]";
  }
  if (typeof value !== "object") {
    return `[${typeof value}]`;
  }
  if (state.ancestors.has(value)) {
    state.truncated = true;
    return "[Circular]";
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const retained = value.slice(0, 32).map((entry) => projectBoundedCodeModeDetail(entry, depth + 1, state));
      if (value.length > retained.length) {
        state.truncated = true;
        retained.push(`[${value.length - retained.length} array entries omitted]`);
      }
      return retained;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const retained = entries
      .slice(0, 32)
      .map(([key, entry]) => [
        boundCodeModeUtf8Text(key, 256, "…"),
        projectBoundedCodeModeDetail(entry, depth + 1, state),
      ]);
    if (entries.length > retained.length) {
      state.truncated = true;
      retained.push(["detailsTruncated", true]);
    }
    return Object.fromEntries(retained);
  } finally {
    state.ancestors.delete(value);
  }
}

function boundCodeModeUtf8Text(value: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  let retainedBytes = 0;
  let retainedCodeUnits = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + bytes > budget) {
      break;
    }
    retainedBytes += bytes;
    retainedCodeUnits += character.length;
  }
  return `${value.slice(0, retainedCodeUnits)}${marker}`;
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
    executionBackend: row.execution_backend_json
      ? parseCodeModeJson<CodeModeRunRecord["executionBackend"]>(
          row,
          "execution_backend_json",
          row.execution_backend_json,
        )
      : undefined,
    executionRecovery: normalizeStoredCodeModeExecutionRecovery(row),
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
    trustedCodeWriteVerification: row.trusted_code_write_verification_json
      ? parseCodeModeJson<CodeModeRunRecord["trustedCodeWriteVerification"]>(
          row,
          "trusted_code_write_verification_json",
          row.trusted_code_write_verification_json,
        )
      : undefined,
    verification: normalizeStoredCodeModeRunVerification(row),
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

function mapCodeModeRunRowForRead(row: CodeModeRunRow): CodeModeRunRecord {
  try {
    return mapCodeModeRunRow(row);
  } catch (error) {
    return buildCorruptCodeModeRunRecord(row, error);
  }
}

function buildCorruptCodeModeRunRecord(row: CodeModeRunRow, error: unknown): CodeModeRunRecord {
  const detail =
    sanitizeCodeModeText(error instanceof Error ? error.message : String(error), MAX_CODE_MODE_ERROR_TEXT_BYTES) ??
    "Stored Code Mode ledger detail unavailable.";
  const errorText =
    sanitizeCodeModeText(`Code Mode run ledger is corrupt: ${detail}`, MAX_CODE_MODE_ERROR_TEXT_BYTES) ??
    "Code Mode run ledger is corrupt.";
  return {
    runId: row.run_id,
    status: "failed",
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
    codeArtifact: unavailableArtifact(row, "code_artifact_json"),
    wrapperManifestArtifact: unavailableArtifact(row, "wrapper_manifest_artifact_json"),
    policySnapshotArtifact: unavailableArtifact(row, "policy_snapshot_artifact_json"),
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    executionRecovery: {
      generation: Number.isSafeInteger(Number(row.execution_generation)) ? Number(row.execution_generation) : 0,
      phase: "terminal",
      disposition: "manual_reconciliation",
      interruptedAt: row.finished_at ?? row.started_at ?? row.created_at,
      interruptionReason: "Code Mode run recovery ledger is corrupt.",
      finalTranscriptEventId: row.final_transcript_event_id ?? undefined,
      finalTranscriptEnqueuedAt: row.final_transcript_enqueued_at ?? undefined,
    },
    verification: {
      status: "not_applicable",
      reason: "Code Mode run ledger is corrupt; verification cannot be trusted.",
      updatedAt: row.finished_at ?? row.started_at ?? row.created_at,
    },
    error: errorText,
    errorCode: "CORRUPT_CODE_MODE_RUN_LEDGER",
    errorDetails: {
      corruptLedger: true,
      detail,
    },
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? row.started_at ?? row.created_at,
  };
}

function unavailableArtifact(row: CodeModeRunRow, fieldName: string): CapabilityArtifactRecord {
  return {
    artifactId: `${row.run_id}-${fieldName}-unavailable`,
    relPath: `code-mode/${row.run_id}/${fieldName}.unavailable`,
    sha256: "unavailable",
    bytes: 0,
    mimeType: "application/octet-stream",
    createdAt: row.created_at,
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
    const detail =
      sanitizeCodeModeText(error instanceof Error ? error.message : String(error), MAX_CODE_MODE_ERROR_TEXT_BYTES) ??
      "JSON parse detail unavailable.";
    throw new Error(`Code Mode run ${row.run_id} has corrupt ${fieldName} metadata: ${detail}`, {
      cause: error,
    });
  }
}

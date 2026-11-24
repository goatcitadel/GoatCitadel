import { randomUUID } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  ValidationError,
  isCronRunTerminalStatus,
  type CronJobAction,
  type CronRunActiveStatus,
  type CronRunBeginInput,
  type CronRunBeginResult,
  type CronRunExecutionToken,
  type CronRunLinkage,
  type CronRunPhase,
  type CronRunRecord,
  type CronRunStatus,
  type CronRunTerminalStatus,
  type CronRunTrigger,
} from "@goatcitadel/contracts";
import {
  isPlainRecord,
  normalizeAction,
  normalizeActiveStatus,
  normalizeBoundedJson,
  normalizeCronEventSource,
  normalizeInteger,
  normalizeLimit,
  normalizeOptional,
  normalizePhase,
  normalizeReconciliationStatus,
  normalizeRequired,
  normalizeStatus,
  normalizeTerminalStatus,
  normalizeTimestamp,
  normalizeTrigger,
  parseActionConfig,
  parseStoredObject,
} from "./cron-run-validation.js";
import type { DatabaseClient } from "./db.js";

const ACTIVE_STATUSES = "'admitting', 'admitted', 'running', 'waiting'";

interface CronRunRow {
  run_id: string;
  job_id: string;
  admission_key: string;
  execution_generation: number | string;
  trigger_kind: CronRunTrigger;
  job_revision: number | string;
  action: CronJobAction;
  action_snapshot_json: string;
  scheduled_for: string;
  status: CronRunStatus;
  phase: CronRunPhase;
  child_session_id: string | null;
  child_message_id: string | null;
  child_turn_id: string | null;
  child_assistant_message_id: string | null;
  child_durable_run_id: string | null;
  delivery_run_id: string | null;
  external_side_effect_run_id: string | null;
  evidence_envelope_id: string | null;
  outcome_json: string | null;
  failure_json: string | null;
  reconciliation_reason: string | null;
  reconciliation_resolution: string | null;
  created_at: string;
  updated_at: string;
  admitted_at: string | null;
  started_at: string | null;
  settled_at: string | null;
  reconciled_at: string | null;
  reconciled_by: string | null;
}

interface CronJobExecutionRow {
  job_id: string;
  revision: number | string;
  action: CronJobAction;
  action_config_json: string | null;
  execution_generation: number | string;
  active_run_id: string | null;
  citadel_id?: string | null;
}

export class CronRunRepository {
  private readonly databaseNowStmt;
  private readonly getStmt;
  private readonly getByAdmissionStmt;
  private readonly getByGenerationStmt;
  private readonly listByJobStmt;
  private readonly listPendingSettlementStmt;
  private readonly listUnresolvedReconciliationStmt;
  private readonly getJobStmt;
  private readonly getJobForUpdateStmt;
  private readonly maxGenerationStmt;
  private readonly reserveJobGenerationStmt;
  private readonly insertStmt;
  private readonly attachStmt;
  private readonly admitInlineStmt;
  private readonly advanceStmt;
  private readonly terminalStmt;
  private readonly clearActiveJobStmt;
  private readonly reconcileStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.databaseNowStmt = db.prepare(
      db.dialect === "postgres"
        ? `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now_iso`
        : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now_iso`,
    );
    this.getStmt = db.prepare("SELECT * FROM cron_runs WHERE run_id = ? LIMIT 1");
    this.getByAdmissionStmt = db.prepare(`
      SELECT * FROM cron_runs
      WHERE job_id = @jobId AND admission_key = @admissionKey
      LIMIT 1
    `);
    this.getByGenerationStmt = db.prepare(`
      SELECT * FROM cron_runs
      WHERE job_id = @jobId AND execution_generation = @executionGeneration
      LIMIT 1
    `);
    this.listByJobStmt = db.prepare(`
      SELECT * FROM cron_runs
      WHERE job_id = @jobId
      ORDER BY execution_generation DESC, run_id DESC
      LIMIT @limit
    `);
    this.listPendingSettlementStmt = db.prepare(`
      SELECT cron_runs.* FROM cron_runs
      WHERE status IN (${ACTIVE_STATUSES})
        AND EXISTS (
          SELECT 1 FROM cron_jobs
          WHERE cron_jobs.job_id = cron_runs.job_id
            AND cron_jobs.active_run_id = cron_runs.run_id
            AND cron_jobs.execution_generation = cron_runs.execution_generation
        )
      ORDER BY cron_runs.updated_at ASC, cron_runs.run_id ASC
      LIMIT @limit
    `);
    this.listUnresolvedReconciliationStmt = db.prepare(`
      SELECT * FROM cron_runs
      WHERE status = 'manual_reconciliation_required'
        AND reconciled_at IS NULL
      ORDER BY updated_at ASC, run_id ASC
      LIMIT @limit
    `);
    const selectJob = `
      SELECT job_id, revision, action, action_config_json, execution_generation, active_run_id, citadel_id
      FROM cron_jobs
      WHERE job_id = ?
      LIMIT 1
    `;
    this.getJobStmt = db.prepare(selectJob);
    this.getJobForUpdateStmt = db.dialect === "postgres" ? db.prepare(`${selectJob} FOR UPDATE`) : this.getJobStmt;
    this.maxGenerationStmt = db.prepare(`
      SELECT MAX(execution_generation) AS max_generation
      FROM cron_runs
      WHERE job_id = ?
    `);
    this.reserveJobGenerationStmt = db.prepare(`
      UPDATE cron_jobs
      SET execution_generation = @executionGeneration,
          active_run_id = @runId,
          updated_at = @now
      WHERE job_id = @jobId
        AND execution_generation = @expectedGeneration
        AND revision = @expectedRevision
        AND active_run_id IS NULL
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO cron_runs (
        run_id, job_id, admission_key, execution_generation, trigger_kind,
        job_revision, action, action_snapshot_json, scheduled_for,
        status, phase, created_at, updated_at
      ) VALUES (
        @runId, @jobId, @admissionKey, @executionGeneration, @trigger,
        @jobRevision, @action, @actionSnapshotJson, @scheduledFor,
        'admitting', 'child_admission', @now, @now
      )
    `);
    this.attachStmt = db.prepare(`
      UPDATE cron_runs
      SET child_session_id = COALESCE(@childSessionId, child_session_id),
          child_message_id = COALESCE(@childMessageId, child_message_id),
          child_turn_id = COALESCE(@childTurnId, child_turn_id),
          child_assistant_message_id = COALESCE(@childAssistantMessageId, child_assistant_message_id),
          child_durable_run_id = COALESCE(@childDurableRunId, child_durable_run_id),
          delivery_run_id = COALESCE(@deliveryRunId, delivery_run_id),
          external_side_effect_run_id = COALESCE(@externalSideEffectRunId, external_side_effect_run_id),
          evidence_envelope_id = COALESCE(@evidenceEnvelopeId, evidence_envelope_id),
          status = 'admitted',
          phase = 'chat_execution',
          admitted_at = COALESCE(admitted_at, @now),
          started_at = COALESCE(started_at, @now),
          updated_at = @now
      WHERE run_id = @runId
        AND job_id = @jobId
        AND execution_generation = @executionGeneration
        AND status = @expectedStatus
        AND EXISTS (
          SELECT 1 FROM cron_jobs
          WHERE cron_jobs.job_id = cron_runs.job_id
            AND cron_jobs.active_run_id = cron_runs.run_id
            AND cron_jobs.execution_generation = cron_runs.execution_generation
        )
    `);
    this.admitInlineStmt = db.prepare(`
      UPDATE cron_runs
      SET status = 'running',
          phase = 'chat_execution',
          admitted_at = COALESCE(admitted_at, @now),
          started_at = COALESCE(started_at, @now),
          updated_at = @now
      WHERE run_id = @runId
        AND job_id = @jobId
        AND execution_generation = @executionGeneration
        AND status = 'admitting'
        AND phase = 'child_admission'
        AND EXISTS (
          SELECT 1 FROM cron_jobs
          WHERE cron_jobs.job_id = cron_runs.job_id
            AND cron_jobs.active_run_id = cron_runs.run_id
            AND cron_jobs.execution_generation = cron_runs.execution_generation
        )
    `);
    this.advanceStmt = db.prepare(`
      UPDATE cron_runs
      SET status = @targetStatus,
          phase = @targetPhase,
          child_session_id = COALESCE(@childSessionId, child_session_id),
          child_message_id = COALESCE(@childMessageId, child_message_id),
          child_turn_id = COALESCE(@childTurnId, child_turn_id),
          child_assistant_message_id = COALESCE(@childAssistantMessageId, child_assistant_message_id),
          child_durable_run_id = COALESCE(@childDurableRunId, child_durable_run_id),
          delivery_run_id = COALESCE(@deliveryRunId, delivery_run_id),
          external_side_effect_run_id = COALESCE(@externalSideEffectRunId, external_side_effect_run_id),
          evidence_envelope_id = COALESCE(@evidenceEnvelopeId, evidence_envelope_id),
          started_at = COALESCE(started_at, @now),
          updated_at = @now
      WHERE run_id = @runId
        AND job_id = @jobId
        AND execution_generation = @executionGeneration
        AND status = @expectedStatus
        AND phase = @expectedPhase
        AND EXISTS (
          SELECT 1 FROM cron_jobs
          WHERE cron_jobs.job_id = cron_runs.job_id
            AND cron_jobs.active_run_id = cron_runs.run_id
            AND cron_jobs.execution_generation = cron_runs.execution_generation
        )
    `);
    this.terminalStmt = db.prepare(`
      UPDATE cron_runs
      SET status = @status,
          phase = 'settlement',
          outcome_json = @outcomeJson,
          failure_json = @failureJson,
          reconciliation_reason = @reconciliationReason,
          evidence_envelope_id = COALESCE(@evidenceEnvelopeId, evidence_envelope_id),
          updated_at = @now,
          settled_at = @now
      WHERE run_id = @runId
        AND job_id = @jobId
        AND execution_generation = @executionGeneration
        AND status = @expectedStatus
        AND phase = @expectedPhase
    `);
    this.clearActiveJobStmt = db.prepare(`
      UPDATE cron_jobs
      SET active_run_id = NULL,
          updated_at = @now
      WHERE job_id = @jobId
        AND active_run_id = @runId
        AND execution_generation = @executionGeneration
    `);
    this.reconcileStmt = db.prepare(`
      UPDATE cron_runs
      SET status = @status,
          outcome_json = COALESCE(@outcomeJson, outcome_json),
          failure_json = @failureJson,
          evidence_envelope_id = COALESCE(@evidenceEnvelopeId, evidence_envelope_id),
          reconciliation_resolution = @resolution,
          reconciled_at = @now,
          reconciled_by = @reconciledBy,
          updated_at = @now
      WHERE run_id = @runId
        AND job_id = @jobId
        AND execution_generation = @executionGeneration
        AND status = 'manual_reconciliation_required'
        AND reconciled_at IS NULL
    `);
  }

  public get(runId: string): CronRunRecord | undefined {
    const row = this.getStmt.get(normalizeRequired(runId, "runId")) as CronRunRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public getByAdmission(jobId: string, admissionKey: string): CronRunRecord | undefined {
    const row = this.getByAdmissionStmt.get({
      jobId: normalizeRequired(jobId, "jobId"),
      admissionKey: normalizeRequired(admissionKey, "admissionKey"),
    }) as CronRunRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public getByGeneration(jobId: string, executionGeneration: number): CronRunRecord | undefined {
    const row = this.getByGenerationStmt.get<CronRunRow>({
      jobId: normalizeRequired(jobId, "jobId"),
      executionGeneration: normalizeInteger(executionGeneration, "executionGeneration", 1),
    });
    return row ? mapRow(row) : undefined;
  }

  public listByJob(jobId: string, limit = 100): CronRunRecord[] {
    return (
      this.listByJobStmt.all({ jobId: normalizeRequired(jobId, "jobId"), limit: normalizeLimit(limit) }) as CronRunRow[]
    ).map(mapRow);
  }

  public listPendingSettlement(limit = 100): CronRunRecord[] {
    return (this.listPendingSettlementStmt.all({ limit: normalizeLimit(limit) }) as CronRunRow[]).map(mapRow);
  }

  public listUnresolvedReconciliation(limit = 100): CronRunRecord[] {
    return (this.listUnresolvedReconciliationStmt.all({ limit: normalizeLimit(limit) }) as CronRunRow[]).map(mapRow);
  }

  public beginAdmission(input: CronRunBeginInput, now?: string): CronRunBeginResult {
    const jobId = normalizeRequired(input.jobId, "jobId");
    const admissionKey = normalizeRequired(input.admissionKey, "admissionKey");
    const scheduledFor = normalizeTimestamp(input.scheduledFor, "scheduledFor");
    const trigger = normalizeTrigger(input.trigger ?? "scheduled_due");
    const runId = normalizeOptional(input.runId, "runId") ?? randomUUID();
    const normalizedNow = normalizeTimestamp(now ?? this.readDatabaseNow(), "now");
    const eventSource = normalizeCronEventSource(input.eventSource);
    const operatorAction = input.operatorAction;
    if (
      operatorAction &&
      (!operatorAction.actorId?.trim() ||
        operatorAction.actorId.length > 256 ||
        !/^[A-Za-z0-9_-]{16,100}$/u.test(operatorAction.operationId) ||
        !Number.isSafeInteger(operatorAction.expectedExecutionGeneration) ||
        operatorAction.expectedExecutionGeneration < 0 ||
        operatorAction.expectedExecutionGeneration !== input.expectedExecutionGeneration ||
        input.expectedJobRevision === undefined ||
        trigger !== "manual" ||
        eventSource)
    )
      throw new ConflictError({ message: "Invalid reviewed operator occurrence identity." });
    const replay = (duplicate: CronRunRecord): CronRunBeginResult => {
      if (
        canonicalJsonString(duplicate.actionSnapshot.operatorAction ?? null) !==
          canonicalJsonString(operatorAction ?? null) ||
        (operatorAction && duplicate.jobRevision !== input.expectedJobRevision) ||
        (input.expectedExecutionGeneration !== undefined &&
          duplicate.executionGeneration !== input.expectedExecutionGeneration + 1)
      )
        throw new ConflictError({ message: "This run identity belongs to a different reviewed execution." });
      if (
        canonicalJsonString(duplicate.actionSnapshot.eventSource ?? null) !==
          canonicalJsonString(eventSource ?? null) ||
        (eventSource && duplicate.jobRevision !== input.expectedJobRevision)
      )
        throw new ConflictError({
          message: "This event identity was already admitted with different bytes or a different reviewed job.",
        });
      if (duplicate.scheduledFor !== scheduledFor || duplicate.trigger !== trigger) {
        throw new ConflictError({
          message: "Cron admission key was reused for a different scheduled occurrence.",
          details: { jobId, admissionKey, runId: duplicate.runId },
        });
      }
      return { outcome: "duplicate", run: duplicate };
    };
    return this.db.transaction("immediate", () => {
      const duplicate = this.getByAdmission(jobId, admissionKey);
      if (duplicate) return replay(duplicate);
      const runIdCollision = this.get(runId);
      if (runIdCollision) {
        throw new ConflictError({
          code: "ALREADY_EXISTS",
          message: `Cron run id ${runId} is already owned by a different admission.`,
          details: { runId, jobId, admissionKey },
        });
      }

      const job = this.readJob(jobId, true);
      // Another PostgreSQL transaction may have committed this exact occurrence
      // while this worker waited for the job lock. Re-read its idempotency owner
      // before interpreting the newly populated active-run pointer as overlap.
      const raced = this.getByAdmission(jobId, admissionKey);
      if (raced) return replay(raced);
      const conflictCode = operatorAction ? "FOLLOW_THROUGH_RUN_NOT_ADMITTED" : "STATE_CONFLICT";
      const revision = normalizeInteger(job.revision, "revision", 1);
      if (
        input.expectedJobRevision !== undefined &&
        normalizeInteger(input.expectedJobRevision, "expectedJobRevision", 1) !== revision
      )
        throw new ConflictError({
          code: conflictCode,
          message: "This schedule changed after review. Refresh before running it.",
        });
      const expectedGeneration = normalizeInteger(job.execution_generation, "execution_generation", 0);
      if (
        input.expectedExecutionGeneration !== undefined &&
        normalizeInteger(input.expectedExecutionGeneration, "expectedExecutionGeneration", 0) !== expectedGeneration
      )
        throw new ConflictError({
          code: conflictCode,
          message:
            "Another occurrence was admitted after this execution was reviewed. Refresh before requesting new work.",
        });
      const actionConfig = parseActionConfig(job.action_config_json);
      if (eventSource) {
        const agentTurn = isPlainRecord(actionConfig?.agentTurn) ? actionConfig.agentTurn : undefined;
        const config = isPlainRecord(agentTurn?.eventWake) ? agentTurn.eventWake : undefined;
        if (
          job.action !== "agent_turn" ||
          input.expectedJobRevision === undefined ||
          !config ||
          config.eventType !== eventSource.eventType ||
          config.workspaceId !== eventSource.workspaceId ||
          config.hookId !== eventSource.sourceConnectionId ||
          admissionKey !== `event:${eventSource.eventId}`
        )
          throw new ConflictError({ message: "The event no longer matches this reviewed job's trigger." });
      }
      if (job.active_run_id) {
        const activeRun = this.get(job.active_run_id);
        if (!activeRun) {
          throw new ConflictError({
            message: `Cron job ${jobId} references missing active run ${job.active_run_id}.`,
            details: { jobId, activeRunId: job.active_run_id },
          });
        }
        return { outcome: "blocked", activeRun };
      }

      const historicalGeneration = this.readHistoricalMaxGeneration(jobId);
      if (input.expectedExecutionGeneration !== undefined && historicalGeneration > expectedGeneration)
        throw new ConflictError({ message: "This schedule's execution history requires reconciliation." });
      const executionGeneration = Math.max(expectedGeneration, historicalGeneration) + 1;
      const reserved = this.reserveJobGenerationStmt.run({
        jobId,
        runId,
        expectedGeneration,
        expectedRevision: revision,
        executionGeneration,
        now: normalizedNow,
      });
      if (reserved.changes === 0) {
        const currentJob = this.readJob(jobId);
        if (currentJob.active_run_id) {
          const activeRun = this.get(currentJob.active_run_id);
          if (activeRun) {
            return { outcome: "blocked", activeRun };
          }
        }
        throw staleGenerationError({ runId, jobId, executionGeneration });
      }

      const jobRevision = normalizeInteger(job.revision, "revision", 1);
      const actionSnapshotJson = normalizeBoundedJson(
        {
          action: job.action,
          actionConfig,
          ...(operatorAction ? { operatorAction: { ...operatorAction } } : {}),
          ...(eventSource ? { eventSource } : {}),
          // Admission-time scope; omitted for global jobs so their snapshots are unchanged.
          ...(typeof job.citadel_id === "string" && job.citadel_id ? { citadelId: job.citadel_id } : {}),
        },
        "actionSnapshot",
      );
      this.insertStmt.run({
        runId,
        jobId,
        admissionKey,
        executionGeneration,
        trigger,
        jobRevision,
        action: job.action,
        actionSnapshotJson,
        scheduledFor,
        now: normalizedNow,
      });
      const run = this.get(runId);
      if (!run) {
        throw new Error(`Cron run ${runId} disappeared after admission.`);
      }
      return { outcome: "begun", run };
    });
  }

  public begin(input: CronRunBeginInput, now?: string): CronRunBeginResult {
    return this.beginAdmission(input, now);
  }

  public attachDeterministicChild(
    token: CronRunExecutionToken,
    linkage: CronRunLinkage,
    now?: string,
  ): CronRunRecord | undefined {
    const normalizedToken = normalizeToken(token);
    const normalizedLinkage = normalizeLinkage(linkage);
    if (!normalizedLinkage.childTurnId || !normalizedLinkage.childDurableRunId) {
      throw new ValidationError({
        field: "linkage",
        message: "childTurnId and childDurableRunId are required when attaching a deterministic cron child.",
      });
    }
    const normalizedNow = normalizeTimestamp(now ?? this.readDatabaseNow(), "now");
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedToken.runId);
      if (!current || !tokenMatches(current, normalizedToken) || !this.ownsActiveGeneration(normalizedToken)) {
        return undefined;
      }
      assertLinkageCompatible(current, normalizedLinkage);
      if (current.status === "admitted") {
        return current;
      }
      if (current.status !== "admitting" || current.phase !== "child_admission") {
        throw invalidTransitionError(current, "admitted", "chat_execution");
      }
      const changed = this.attachStmt.run({
        ...normalizedToken,
        ...linkageParams(normalizedLinkage),
        expectedStatus: current.status,
        now: normalizedNow,
      });
      return changed.changes > 0 ? this.get(normalizedToken.runId) : undefined;
    });
  }

  public attachChild(token: CronRunExecutionToken, linkage: CronRunLinkage, now?: string): CronRunRecord | undefined {
    return this.attachDeterministicChild(token, linkage, now);
  }

  /**
   * Admits an inline cron handler after the canonical occurrence row has been
   * reserved and before the handler can perform a side effect. Agent-turn
   * occurrences use attachDeterministicChild instead because their durable
   * child linkage is part of admission truth.
   */
  public admitInlineExecution(token: CronRunExecutionToken, now?: string): CronRunRecord | undefined {
    const normalizedToken = normalizeToken(token);
    const normalizedNow = normalizeTimestamp(now ?? this.readDatabaseNow(), "now");
    return this.db.transaction("immediate", () => {
      const current = this.get(normalizedToken.runId);
      if (!current || !tokenMatches(current, normalizedToken) || !this.ownsActiveGeneration(normalizedToken)) {
        return undefined;
      }
      if (current.status === "running" && current.phase === "chat_execution") return current;
      if (current.status !== "admitting" || current.phase !== "child_admission") {
        throw invalidTransitionError(current, "running", "chat_execution");
      }
      const changed = this.admitInlineStmt.run({ ...normalizedToken, now: normalizedNow });
      return changed.changes > 0 ? this.get(normalizedToken.runId) : undefined;
    });
  }

  public advancePhase(
    token: CronRunExecutionToken,
    input: { status: CronRunActiveStatus; phase: CronRunPhase; linkage?: CronRunLinkage; now?: string },
  ): CronRunRecord | undefined {
    const normalizedToken = normalizeToken(token);
    const targetStatus = normalizeActiveStatus(input.status);
    const targetPhase = normalizePhase(input.phase);
    const normalizedLinkage = normalizeLinkage(input.linkage ?? {});
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    return this.db.transaction("immediate", () => {
      const job = this.getJobForUpdateStmt.get<CronJobExecutionRow>(normalizedToken.jobId);
      const current = this.get(normalizedToken.runId);
      if (!current || !tokenMatches(current, normalizedToken) || !jobOwnsActiveGeneration(job, normalizedToken)) {
        return undefined;
      }
      assertLinkageCompatible(current, normalizedLinkage);
      const hasNewLinkage = LINKAGE_FIELDS.some(
        (key) => normalizedLinkage[key] !== undefined && current[key] === undefined,
      );
      if (current.status === targetStatus && current.phase === targetPhase && !hasNewLinkage) {
        return current;
      }
      if (!canAdvance(current, targetStatus, targetPhase)) {
        throw invalidTransitionError(current, targetStatus, targetPhase);
      }
      const changed = this.advanceStmt.run({
        ...normalizedToken,
        expectedStatus: current.status,
        expectedPhase: current.phase,
        targetStatus,
        targetPhase,
        ...linkageParams(normalizedLinkage),
        now,
      });
      return changed.changes > 0 ? this.get(normalizedToken.runId) : undefined;
    });
  }

  public advance(
    token: CronRunExecutionToken,
    targetStatus: CronRunActiveStatus,
    now?: string,
  ): CronRunRecord | undefined {
    const current = this.get(token.runId);
    const phase = current?.phase === "child_admission" ? "chat_execution" : (current?.phase ?? "chat_execution");
    return this.advancePhase(token, { status: targetStatus, phase, now });
  }

  public terminalize(
    token: CronRunExecutionToken,
    input: {
      status: CronRunTerminalStatus;
      outcome?: Record<string, unknown>;
      failure?: Record<string, unknown>;
      reconciliationReason?: string;
      evidenceEnvelopeId?: string;
      now?: string;
    },
  ): CronRunRecord | undefined {
    const normalizedToken = normalizeToken(token);
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    const targetStatus = normalizeTerminalStatus(input.status);
    if (targetStatus === "manual_reconciliation_required" && !input.reconciliationReason?.trim()) {
      throw new ValidationError({
        field: "reconciliationReason",
        message: "reconciliationReason is required for manual reconciliation.",
      });
    }
    return this.db.transaction("immediate", () => {
      // Lock the PostgreSQL job row before reading or writing the run. Settlement
      // and release must see the same active owner even when other writers are waiting.
      const job = this.getJobForUpdateStmt.get<CronJobExecutionRow>(normalizedToken.jobId);
      const current = this.get(normalizedToken.runId);
      if (!current || !tokenMatches(current, normalizedToken)) {
        return undefined;
      }
      if (isCronRunTerminalStatus(current.status)) {
        if (current.status !== targetStatus) {
          return undefined;
        }
        assertTerminalReplayCompatible(current, input);
        return current;
      }
      if (!jobOwnsActiveGeneration(job, normalizedToken)) {
        return undefined;
      }
      assertLinkageCompatible(current, { evidenceEnvelopeId: input.evidenceEnvelopeId });
      const changed = this.terminalStmt.run({
        ...normalizedToken,
        expectedStatus: current.status,
        expectedPhase: current.phase,
        status: targetStatus,
        outcomeJson: input.outcome ? normalizeBoundedJson(input.outcome, "outcome") : null,
        failureJson: input.failure ? normalizeBoundedJson(input.failure, "failure") : null,
        reconciliationReason: normalizeOptional(input.reconciliationReason, "reconciliationReason") ?? null,
        evidenceEnvelopeId: normalizeOptional(input.evidenceEnvelopeId, "evidenceEnvelopeId") ?? null,
        now,
      });
      if (changed.changes === 0) {
        return undefined;
      }
      if (targetStatus !== "manual_reconciliation_required") {
        this.clearActiveJobStmt.run({ ...normalizedToken, now });
      }
      return this.get(normalizedToken.runId);
    });
  }

  public markSucceeded(
    token: CronRunExecutionToken,
    input: { output?: string; evidenceEnvelopeId?: string; now?: string } = {},
  ): CronRunRecord | undefined {
    return this.terminalize(token, {
      status: "completed",
      outcome: input.output === undefined ? undefined : { output: input.output },
      evidenceEnvelopeId: input.evidenceEnvelopeId,
      now: input.now,
    });
  }

  public markFailed(
    token: CronRunExecutionToken,
    input: { error: string; evidenceEnvelopeId?: string; now?: string },
  ): CronRunRecord | undefined {
    return this.terminalize(token, {
      status: "failed",
      failure: { message: normalizeRequired(input.error, "error") },
      evidenceEnvelopeId: input.evidenceEnvelopeId,
      now: input.now,
    });
  }

  public requireReconciliation(
    token: CronRunExecutionToken,
    input: { reason: string; error?: string; evidenceEnvelopeId?: string; now?: string },
  ): CronRunRecord | undefined {
    return this.terminalize(token, {
      status: "manual_reconciliation_required",
      reconciliationReason: normalizeRequired(input.reason, "reason"),
      failure: input.error ? { message: input.error } : undefined,
      evidenceEnvelopeId: input.evidenceEnvelopeId,
      now: input.now,
    });
  }

  public recordReconciliation(
    token: CronRunExecutionToken,
    input: {
      status: Exclude<CronRunTerminalStatus, "manual_reconciliation_required">;
      resolution: string;
      reconciledBy: string;
      outcome?: Record<string, unknown>;
      failure?: Record<string, unknown>;
      evidenceEnvelopeId?: string;
      now?: string;
    },
  ): CronRunRecord | undefined {
    const normalizedToken = normalizeToken(token);
    const now = normalizeTimestamp(input.now ?? this.readDatabaseNow(), "now");
    const targetStatus = normalizeReconciliationStatus(input.status);
    const evidenceEnvelopeId = normalizeOptional(input.evidenceEnvelopeId, "evidenceEnvelopeId");
    return this.db.transaction("immediate", () => {
      // Keep the same job-then-run lock order as terminal settlement.
      this.getJobForUpdateStmt.get(normalizedToken.jobId);
      const current = this.get(normalizedToken.runId);
      if (!current || !tokenMatches(current, normalizedToken)) {
        return undefined;
      }
      assertLinkageCompatible(current, { evidenceEnvelopeId });
      const changed = this.reconcileStmt.run({
        ...normalizedToken,
        status: targetStatus,
        resolution: normalizeRequired(input.resolution, "resolution"),
        reconciledBy: normalizeRequired(input.reconciledBy, "reconciledBy"),
        outcomeJson: input.outcome ? normalizeBoundedJson(input.outcome, "outcome") : null,
        failureJson: input.failure ? normalizeBoundedJson(input.failure, "failure") : null,
        evidenceEnvelopeId: evidenceEnvelopeId ?? null,
        now,
      });
      if (changed.changes === 0) {
        return undefined;
      }
      this.clearActiveJobStmt.run({ ...normalizedToken, now });
      return this.get(normalizedToken.runId);
    });
  }

  public reconcile(
    token: CronRunExecutionToken,
    input: {
      status: "succeeded" | "failed";
      resolution: string;
      reconciledBy: string;
      output?: string;
      error?: string;
      now?: string;
    },
  ): CronRunRecord | undefined {
    return this.recordReconciliation(token, {
      status: input.status === "succeeded" ? "completed" : "failed",
      resolution: input.resolution,
      reconciledBy: input.reconciledBy,
      outcome: input.output === undefined ? undefined : { output: input.output },
      failure: input.error === undefined ? undefined : { message: input.error },
      now: input.now,
    });
  }

  private readJob(jobId: string, lock = false): CronJobExecutionRow {
    const row = (lock ? this.getJobForUpdateStmt : this.getJobStmt).get<CronJobExecutionRow>(jobId);
    if (!row) {
      throw new NotFoundError({ entity: "Cron job", id: jobId });
    }
    return row;
  }

  private readHistoricalMaxGeneration(jobId: string): number {
    const row = this.maxGenerationStmt.get(jobId) as { max_generation?: number | string | null } | undefined;
    return row?.max_generation === null || row?.max_generation === undefined
      ? 0
      : normalizeInteger(row.max_generation, "max_generation", 0);
  }

  private ownsActiveGeneration(token: CronRunExecutionToken): boolean {
    return jobOwnsActiveGeneration(this.readJob(token.jobId), token);
  }

  private readDatabaseNow(): string {
    const row = this.databaseNowStmt.get<{ now_iso?: unknown }>();
    if (!row || typeof row.now_iso !== "string") {
      throw new Error("Database did not return a cron run timestamp.");
    }
    return row.now_iso;
  }
}

function mapRow(row: CronRunRow): CronRunRecord {
  return {
    runId: row.run_id,
    jobId: row.job_id,
    admissionKey: row.admission_key,
    executionGeneration: normalizeInteger(row.execution_generation, "execution_generation", 1),
    trigger: normalizeTrigger(row.trigger_kind),
    jobRevision: normalizeInteger(row.job_revision, "job_revision", 1),
    action: normalizeAction(row.action),
    actionSnapshot: parseStoredObject(row.action_snapshot_json, "action_snapshot_json", row.run_id),
    scheduledFor: row.scheduled_for,
    status: normalizeStatus(row.status),
    phase: normalizePhase(row.phase),
    childSessionId: row.child_session_id ?? undefined,
    childMessageId: row.child_message_id ?? undefined,
    childTurnId: row.child_turn_id ?? undefined,
    childAssistantMessageId: row.child_assistant_message_id ?? undefined,
    childDurableRunId: row.child_durable_run_id ?? undefined,
    deliveryRunId: row.delivery_run_id ?? undefined,
    externalSideEffectRunId: row.external_side_effect_run_id ?? undefined,
    evidenceEnvelopeId: row.evidence_envelope_id ?? undefined,
    outcome: row.outcome_json ? parseStoredObject(row.outcome_json, "outcome_json", row.run_id) : undefined,
    failure: row.failure_json ? parseStoredObject(row.failure_json, "failure_json", row.run_id) : undefined,
    reconciliationReason: row.reconciliation_reason ?? undefined,
    reconciliationResolution: row.reconciliation_resolution ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    admittedAt: row.admitted_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    settledAt: row.settled_at ?? undefined,
    reconciledAt: row.reconciled_at ?? undefined,
    reconciledBy: row.reconciled_by ?? undefined,
  };
}

function normalizeToken(token: CronRunExecutionToken): CronRunExecutionToken {
  return {
    runId: normalizeRequired(token.runId, "runId"),
    jobId: normalizeRequired(token.jobId, "jobId"),
    executionGeneration: normalizeInteger(token.executionGeneration, "executionGeneration", 1),
  };
}

function tokenMatches(run: CronRunRecord, token: CronRunExecutionToken): boolean {
  return (
    run.runId === token.runId && run.jobId === token.jobId && run.executionGeneration === token.executionGeneration
  );
}

function jobOwnsActiveGeneration(job: CronJobExecutionRow | undefined, token: CronRunExecutionToken): boolean {
  return (
    job?.active_run_id === token.runId &&
    normalizeInteger(job.execution_generation, "execution_generation", 0) === token.executionGeneration
  );
}

function normalizeLinkage(linkage: CronRunLinkage): CronRunLinkage {
  return {
    childSessionId: normalizeOptional(linkage.childSessionId, "childSessionId"),
    childMessageId: normalizeOptional(linkage.childMessageId, "childMessageId"),
    childTurnId: normalizeOptional(linkage.childTurnId, "childTurnId"),
    childAssistantMessageId: normalizeOptional(linkage.childAssistantMessageId, "childAssistantMessageId"),
    childDurableRunId: normalizeOptional(linkage.childDurableRunId, "childDurableRunId"),
    deliveryRunId: normalizeOptional(linkage.deliveryRunId, "deliveryRunId"),
    externalSideEffectRunId: normalizeOptional(linkage.externalSideEffectRunId, "externalSideEffectRunId"),
    evidenceEnvelopeId: normalizeOptional(linkage.evidenceEnvelopeId, "evidenceEnvelopeId"),
  };
}

function linkageParams(linkage: CronRunLinkage): Record<string, string | null> {
  return {
    childSessionId: linkage.childSessionId ?? null,
    childMessageId: linkage.childMessageId ?? null,
    childTurnId: linkage.childTurnId ?? null,
    childAssistantMessageId: linkage.childAssistantMessageId ?? null,
    childDurableRunId: linkage.childDurableRunId ?? null,
    deliveryRunId: linkage.deliveryRunId ?? null,
    externalSideEffectRunId: linkage.externalSideEffectRunId ?? null,
    evidenceEnvelopeId: linkage.evidenceEnvelopeId ?? null,
  };
}

const LINKAGE_FIELDS = [
  "childSessionId",
  "childMessageId",
  "childTurnId",
  "childAssistantMessageId",
  "childDurableRunId",
  "deliveryRunId",
  "externalSideEffectRunId",
  "evidenceEnvelopeId",
] as const;

function assertLinkageCompatible(current: CronRunRecord, linkage: CronRunLinkage): void {
  for (const key of LINKAGE_FIELDS) {
    if (current[key] && linkage[key] && current[key] !== linkage[key]) {
      throw new ConflictError({
        message: `Cron run ${current.runId} is already linked to a different ${key}.`,
        details: { runId: current.runId, field: key },
      });
    }
  }
}

function canAdvance(current: CronRunRecord, targetStatus: CronRunActiveStatus, targetPhase: CronRunPhase): boolean {
  const phaseOrder: Record<CronRunPhase, number> = {
    child_admission: 0,
    chat_execution: 1,
    autonomous_post_commit: 2,
    delivery: 3,
    settlement: 4,
  };
  if (isCronRunTerminalStatus(current.status) || current.status === "admitting" || targetStatus === "admitting") {
    return false;
  }
  if (phaseOrder[targetPhase] < phaseOrder[current.phase]) {
    return false;
  }
  return true;
}

function assertTerminalReplayCompatible(
  current: CronRunRecord,
  input: {
    outcome?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    reconciliationReason?: string;
    evidenceEnvelopeId?: string;
  },
): void {
  assertLinkageCompatible(current, { evidenceEnvelopeId: input.evidenceEnvelopeId });
  const mismatched =
    (input.outcome !== undefined &&
      normalizeBoundedJson(input.outcome, "outcome") !== JSON.stringify(current.outcome)) ||
    (input.failure !== undefined &&
      normalizeBoundedJson(input.failure, "failure") !== JSON.stringify(current.failure)) ||
    (input.reconciliationReason !== undefined && input.reconciliationReason.trim() !== current.reconciliationReason);
  if (mismatched) {
    throw new ConflictError({
      message: `Cron run ${current.runId} terminal settlement was replayed with different evidence.`,
      details: { runId: current.runId, status: current.status },
    });
  }
}

function invalidTransitionError(
  current: CronRunRecord,
  targetStatus: CronRunStatus,
  targetPhase: CronRunPhase,
): ConflictError {
  return new ConflictError({
    message: `Cron run ${current.runId} cannot transition from ${current.status}/${current.phase} to ${targetStatus}/${targetPhase}.`,
    details: {
      runId: current.runId,
      currentStatus: current.status,
      currentPhase: current.phase,
      targetStatus,
      targetPhase,
    },
  });
}

function staleGenerationError(token: CronRunExecutionToken): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `Cron run ${token.runId} no longer owns execution generation ${token.executionGeneration}.`,
    details: {
      resourceKind: "cron_run",
      resourceId: token.runId,
      jobId: token.jobId,
      executionGeneration: token.executionGeneration,
    },
  });
}

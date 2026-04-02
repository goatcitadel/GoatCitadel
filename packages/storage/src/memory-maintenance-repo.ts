import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MemoryMaintenanceChangeRecord,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceRunSourceRecord,
  MemoryMaintenanceStateRecord,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface MemoryMaintenancePolicyRow {
  workspace_id: string;
  enabled: number;
  run_mode: MemoryMaintenancePolicyRecord["runMode"];
  timing_strategy: MemoryMaintenancePolicyRecord["timingStrategy"];
  schedule_json: string | null;
  time_zone: string;
  min_hours_since_last_success: number;
  min_changed_sessions: number;
  provider_id: string | null;
  model: string | null;
  execution_target: MemoryMaintenancePolicyRecord["executionTarget"];
  unavailable_model_policy: MemoryMaintenancePolicyRecord["unavailableModelPolicy"];
  created_at: string;
  updated_at: string;
}

interface MemoryMaintenanceStateRow {
  workspace_id: string;
  last_eligibility_at: string | null;
  last_successful_run_at: string | null;
  changed_session_count: number;
  active_run_id: string | null;
  last_recommendation_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryMaintenanceRunRow {
  run_id: string;
  durable_run_id: string | null;
  workspace_id: string;
  trigger_source: MemoryMaintenanceRunRecord["triggerSource"];
  status: MemoryMaintenanceRunRecord["status"];
  provider_id: string | null;
  model: string | null;
  policy_snapshot_json: string;
  source_session_count: number;
  changed_artifact_count: number;
  summary: string | null;
  error_text: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface MemoryMaintenanceRunSourceRow {
  source_id: string;
  run_id: string;
  source_kind: MemoryMaintenanceRunSourceRecord["sourceKind"];
  source_ref: string;
  modified_at: string | null;
  excerpt: string | null;
  token_estimate: number | null;
  created_at: string;
}

interface MemoryMaintenanceChangeRow {
  change_id: string;
  run_id: string;
  change_kind: MemoryMaintenanceChangeRecord["changeKind"];
  target_kind: MemoryMaintenanceChangeRecord["targetKind"];
  target_ref: string;
  before_ref: string | null;
  after_ref: string | null;
  summary: string;
  created_at: string;
}

interface MemoryMaintenanceRecommendationRow {
  recommendation_id: string;
  workspace_id: string;
  kind: MemoryMaintenanceRecommendationRecord["kind"];
  status: MemoryMaintenanceRecommendationRecord["status"];
  summary: string;
  proposed_patch_json: string;
  rationale: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

export class MemoryMaintenanceRepository {
  private readonly getPolicyStmt;
  private readonly upsertPolicyStmt;
  private readonly getStateStmt;
  private readonly upsertStateStmt;
  private readonly getRunStmt;
  private readonly getRunByDurableRunStmt;
  private readonly insertRunStmt;
  private readonly updateRunStmt;
  private readonly listRunsStmt;
  private readonly deleteRunSourcesStmt;
  private readonly insertRunSourceStmt;
  private readonly listRunSourcesStmt;
  private readonly deleteRunChangesStmt;
  private readonly insertRunChangeStmt;
  private readonly listRunChangesStmt;
  private readonly getRecommendationStmt;
  private readonly insertRecommendationStmt;
  private readonly updateRecommendationStmt;
  private readonly listRecommendationsStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getPolicyStmt = db.prepare(`
      SELECT *
      FROM workspace_memory_maintenance_policies
      WHERE workspace_id = ?
    `);
    this.upsertPolicyStmt = db.prepare(`
      INSERT INTO workspace_memory_maintenance_policies (
        workspace_id,
        enabled,
        run_mode,
        timing_strategy,
        schedule_json,
        time_zone,
        min_hours_since_last_success,
        min_changed_sessions,
        provider_id,
        model,
        execution_target,
        unavailable_model_policy,
        created_at,
        updated_at
      ) VALUES (
        @workspaceId,
        @enabled,
        @runMode,
        @timingStrategy,
        @scheduleJson,
        @timeZone,
        @minHoursSinceLastSuccess,
        @minChangedSessions,
        @providerId,
        @model,
        @executionTarget,
        @unavailableModelPolicy,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(workspace_id) DO UPDATE SET
        enabled = excluded.enabled,
        run_mode = excluded.run_mode,
        timing_strategy = excluded.timing_strategy,
        schedule_json = excluded.schedule_json,
        time_zone = excluded.time_zone,
        min_hours_since_last_success = excluded.min_hours_since_last_success,
        min_changed_sessions = excluded.min_changed_sessions,
        provider_id = excluded.provider_id,
        model = excluded.model,
        execution_target = excluded.execution_target,
        unavailable_model_policy = excluded.unavailable_model_policy,
        updated_at = excluded.updated_at
    `);
    this.getStateStmt = db.prepare(`
      SELECT *
      FROM workspace_memory_maintenance_state
      WHERE workspace_id = ?
    `);
    this.upsertStateStmt = db.prepare(`
      INSERT INTO workspace_memory_maintenance_state (
        workspace_id,
        last_eligibility_at,
        last_successful_run_at,
        changed_session_count,
        active_run_id,
        last_recommendation_at,
        created_at,
        updated_at
      ) VALUES (
        @workspaceId,
        @lastEligibilityAt,
        @lastSuccessfulRunAt,
        @changedSessionCount,
        @activeRunId,
        @lastRecommendationAt,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(workspace_id) DO UPDATE SET
        last_eligibility_at = excluded.last_eligibility_at,
        last_successful_run_at = excluded.last_successful_run_at,
        changed_session_count = excluded.changed_session_count,
        active_run_id = excluded.active_run_id,
        last_recommendation_at = excluded.last_recommendation_at,
        updated_at = excluded.updated_at
    `);
    this.getRunStmt = db.prepare(`
      SELECT *
      FROM memory_maintenance_runs
      WHERE run_id = ?
    `);
    this.getRunByDurableRunStmt = db.prepare(`
      SELECT *
      FROM memory_maintenance_runs
      WHERE durable_run_id = ?
      LIMIT 1
    `);
    this.insertRunStmt = db.prepare(`
      INSERT INTO memory_maintenance_runs (
        run_id,
        durable_run_id,
        workspace_id,
        trigger_source,
        status,
        provider_id,
        model,
        policy_snapshot_json,
        source_session_count,
        changed_artifact_count,
        summary,
        error_text,
        created_at,
        started_at,
        finished_at,
        updated_at
      ) VALUES (
        @runId,
        @durableRunId,
        @workspaceId,
        @triggerSource,
        @status,
        @providerId,
        @model,
        @policySnapshotJson,
        @sourceSessionCount,
        @changedArtifactCount,
        @summary,
        @errorText,
        @createdAt,
        @startedAt,
        @finishedAt,
        @updatedAt
      )
    `);
    this.updateRunStmt = db.prepare(`
      UPDATE memory_maintenance_runs
      SET
        durable_run_id = @durableRunId,
        status = @status,
        provider_id = @providerId,
        model = @model,
        policy_snapshot_json = @policySnapshotJson,
        source_session_count = @sourceSessionCount,
        changed_artifact_count = @changedArtifactCount,
        summary = @summary,
        error_text = @errorText,
        started_at = @startedAt,
        finished_at = @finishedAt,
        updated_at = @updatedAt
      WHERE run_id = @runId
    `);
    this.listRunsStmt = db.prepare(`
      SELECT *
      FROM memory_maintenance_runs
      WHERE workspace_id = @workspaceId
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.deleteRunSourcesStmt = db.prepare(`
      DELETE FROM memory_maintenance_run_sources
      WHERE run_id = ?
    `);
    this.insertRunSourceStmt = db.prepare(`
      INSERT INTO memory_maintenance_run_sources (
        source_id,
        run_id,
        source_kind,
        source_ref,
        modified_at,
        excerpt,
        token_estimate,
        created_at
      ) VALUES (
        @sourceId,
        @runId,
        @sourceKind,
        @sourceRef,
        @modifiedAt,
        @excerpt,
        @tokenEstimate,
        @createdAt
      )
    `);
    this.listRunSourcesStmt = db.prepare(`
      SELECT *
      FROM memory_maintenance_run_sources
      WHERE run_id = ?
      ORDER BY created_at ASC, source_id ASC
    `);
    this.deleteRunChangesStmt = db.prepare(`
      DELETE FROM memory_maintenance_run_changes
      WHERE run_id = ?
    `);
    this.insertRunChangeStmt = db.prepare(`
      INSERT INTO memory_maintenance_run_changes (
        change_id,
        run_id,
        change_kind,
        target_kind,
        target_ref,
        before_ref,
        after_ref,
        summary,
        created_at
      ) VALUES (
        @changeId,
        @runId,
        @changeKind,
        @targetKind,
        @targetRef,
        @beforeRef,
        @afterRef,
        @summary,
        @createdAt
      )
    `);
    this.listRunChangesStmt = db.prepare(`
      SELECT *
      FROM memory_maintenance_run_changes
      WHERE run_id = ?
      ORDER BY created_at ASC, change_id ASC
    `);
    this.getRecommendationStmt = db.prepare(`
      SELECT *
      FROM memory_maintenance_recommendations
      WHERE recommendation_id = ?
    `);
    this.insertRecommendationStmt = db.prepare(`
      INSERT INTO memory_maintenance_recommendations (
        recommendation_id,
        workspace_id,
        kind,
        status,
        summary,
        proposed_patch_json,
        rationale,
        created_at,
        updated_at,
        applied_at
      ) VALUES (
        @recommendationId,
        @workspaceId,
        @kind,
        @status,
        @summary,
        @proposedPatchJson,
        @rationale,
        @createdAt,
        @updatedAt,
        @appliedAt
      )
    `);
    this.updateRecommendationStmt = db.prepare(`
      UPDATE memory_maintenance_recommendations
      SET
        status = @status,
        summary = @summary,
        proposed_patch_json = @proposedPatchJson,
        rationale = @rationale,
        updated_at = @updatedAt,
        applied_at = @appliedAt
      WHERE recommendation_id = @recommendationId
    `);
    this.listRecommendationsStmt = db.prepare(`
      SELECT *
      FROM memory_maintenance_recommendations
      WHERE workspace_id = @workspaceId
      ORDER BY created_at DESC, recommendation_id DESC
      LIMIT @limit
    `);
  }

  public findPolicy(workspaceId: string): MemoryMaintenancePolicyRecord | undefined {
    const row = this.getPolicyStmt.get(workspaceId) as MemoryMaintenancePolicyRow | undefined;
    return row ? mapPolicyRow(row) : undefined;
  }

  public upsertPolicy(record: MemoryMaintenancePolicyRecord): MemoryMaintenancePolicyRecord {
    this.upsertPolicyStmt.run({
      workspaceId: record.workspaceId,
      enabled: record.enabled ? 1 : 0,
      runMode: record.runMode,
      timingStrategy: record.timingStrategy,
      scheduleJson: record.schedule ? JSON.stringify(record.schedule) : null,
      timeZone: record.timeZone,
      minHoursSinceLastSuccess: record.minHoursSinceLastSuccess,
      minChangedSessions: record.minChangedSessions,
      providerId: normalizeNullableText(record.providerId),
      model: normalizeNullableText(record.model),
      executionTarget: record.executionTarget,
      unavailableModelPolicy: record.unavailableModelPolicy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return this.requirePolicy(record.workspaceId);
  }

  public patchPolicy(
    workspaceId: string,
    patch: MemoryMaintenancePolicyPatchInput,
    defaults: MemoryMaintenancePolicyRecord,
    now = new Date().toISOString(),
  ): MemoryMaintenancePolicyRecord {
    const current = this.findPolicy(workspaceId) ?? defaults;
    return this.upsertPolicy({
      ...current,
      enabled: patch.enabled ?? current.enabled,
      runMode: patch.runMode ?? current.runMode,
      timingStrategy: patch.timingStrategy ?? current.timingStrategy,
      schedule: patch.schedule === undefined ? current.schedule : patch.schedule ?? undefined,
      timeZone: patch.timeZone ?? current.timeZone,
      minHoursSinceLastSuccess: patch.minHoursSinceLastSuccess ?? current.minHoursSinceLastSuccess,
      minChangedSessions: patch.minChangedSessions ?? current.minChangedSessions,
      providerId: patch.providerId === undefined ? current.providerId : patch.providerId ?? undefined,
      model: patch.model === undefined ? current.model : patch.model ?? undefined,
      executionTarget: patch.executionTarget ?? current.executionTarget,
      unavailableModelPolicy: patch.unavailableModelPolicy ?? current.unavailableModelPolicy,
      createdAt: current.createdAt,
      updatedAt: now,
    });
  }

  public requirePolicy(workspaceId: string): MemoryMaintenancePolicyRecord {
    const record = this.findPolicy(workspaceId);
    if (!record) {
      throw new NotFoundError({ entity: "Memory maintenance policy", id: workspaceId });
    }
    return record;
  }

  public findState(workspaceId: string): MemoryMaintenanceStateRecord | undefined {
    const row = this.getStateStmt.get(workspaceId) as MemoryMaintenanceStateRow | undefined;
    return row ? mapStateRow(row) : undefined;
  }

  public upsertState(record: MemoryMaintenanceStateRecord): MemoryMaintenanceStateRecord {
    this.upsertStateStmt.run({
      workspaceId: record.workspaceId,
      lastEligibilityAt: record.lastEligibilityAt ?? null,
      lastSuccessfulRunAt: record.lastSuccessfulRunAt ?? null,
      changedSessionCount: record.changedSessionCount,
      activeRunId: normalizeNullableText(record.activeRunId),
      lastRecommendationAt: record.lastRecommendationAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    return this.requireState(record.workspaceId);
  }

  public requireState(workspaceId: string): MemoryMaintenanceStateRecord {
    const record = this.findState(workspaceId);
    if (!record) {
      throw new NotFoundError({ entity: "Memory maintenance state", id: workspaceId });
    }
    return record;
  }

  public createRun(record: Omit<MemoryMaintenanceRunRecord, "runId"> & { runId?: string }): MemoryMaintenanceRunRecord {
    const runId = record.runId ?? `mmrun_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    this.insertRunStmt.run({
      runId,
      durableRunId: normalizeNullableText(record.durableRunId),
      workspaceId: record.workspaceId,
      triggerSource: record.triggerSource,
      status: record.status,
      providerId: normalizeNullableText(record.providerId),
      model: normalizeNullableText(record.model),
      policySnapshotJson: JSON.stringify(record.policySnapshot ?? {}),
      sourceSessionCount: record.sourceSessionCount,
      changedArtifactCount: record.changedArtifactCount,
      summary: normalizeNullableText(record.summary),
      errorText: normalizeNullableText(record.error),
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      updatedAt: record.updatedAt,
    });
    return this.getRun(runId);
  }

  public getRun(runId: string): MemoryMaintenanceRunRecord {
    const row = this.getRunStmt.get(runId) as MemoryMaintenanceRunRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Memory maintenance run", id: runId });
    }
    return mapRunRow(row);
  }

  public findRunByDurableRunId(durableRunId: string): MemoryMaintenanceRunRecord | undefined {
    const row = this.getRunByDurableRunStmt.get(durableRunId) as MemoryMaintenanceRunRow | undefined;
    return row ? mapRunRow(row) : undefined;
  }

  public updateRun(record: MemoryMaintenanceRunRecord): MemoryMaintenanceRunRecord {
    this.updateRunStmt.run({
      runId: record.runId,
      durableRunId: normalizeNullableText(record.durableRunId),
      status: record.status,
      providerId: normalizeNullableText(record.providerId),
      model: normalizeNullableText(record.model),
      policySnapshotJson: JSON.stringify(record.policySnapshot ?? {}),
      sourceSessionCount: record.sourceSessionCount,
      changedArtifactCount: record.changedArtifactCount,
      summary: normalizeNullableText(record.summary),
      errorText: normalizeNullableText(record.error),
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      updatedAt: record.updatedAt,
    });
    return this.getRun(record.runId);
  }

  public listRuns(workspaceId: string, limit = 100): MemoryMaintenanceRunRecord[] {
    const rows = this.listRunsStmt.all({
      workspaceId,
      limit: clampLimit(limit, 500),
    }) as unknown as MemoryMaintenanceRunRow[];
    return rows.map(mapRunRow);
  }

  public replaceRunSources(runId: string, records: MemoryMaintenanceRunSourceRecord[]): MemoryMaintenanceRunSourceRecord[] {
    this.deleteRunSourcesStmt.run(runId);
    for (const record of records) {
      this.insertRunSourceStmt.run({
        sourceId: record.sourceId,
        runId,
        sourceKind: record.sourceKind,
        sourceRef: record.sourceRef,
        modifiedAt: record.modifiedAt ?? null,
        excerpt: normalizeNullableText(record.excerpt),
        tokenEstimate: record.tokenEstimate ?? null,
        createdAt: record.createdAt,
      });
    }
    return this.listRunSources(runId);
  }

  public listRunSources(runId: string): MemoryMaintenanceRunSourceRecord[] {
    const rows = this.listRunSourcesStmt.all(runId) as unknown as MemoryMaintenanceRunSourceRow[];
    return rows.map((row) => ({
      sourceId: row.source_id,
      runId: row.run_id,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      modifiedAt: row.modified_at ?? undefined,
      excerpt: row.excerpt ?? undefined,
      tokenEstimate: row.token_estimate ?? undefined,
      createdAt: row.created_at,
    }));
  }

  public replaceRunChanges(runId: string, records: MemoryMaintenanceChangeRecord[]): MemoryMaintenanceChangeRecord[] {
    this.deleteRunChangesStmt.run(runId);
    for (const record of records) {
      this.insertRunChangeStmt.run({
        changeId: record.changeId,
        runId,
        changeKind: record.changeKind,
        targetKind: record.targetKind,
        targetRef: record.targetRef,
        beforeRef: normalizeNullableText(record.beforeRef),
        afterRef: normalizeNullableText(record.afterRef),
        summary: record.summary,
        createdAt: record.createdAt,
      });
    }
    return this.listRunChanges(runId);
  }

  public listRunChanges(runId: string): MemoryMaintenanceChangeRecord[] {
    const rows = this.listRunChangesStmt.all(runId) as unknown as MemoryMaintenanceChangeRow[];
    return rows.map((row) => ({
      changeId: row.change_id,
      runId: row.run_id,
      changeKind: row.change_kind,
      targetKind: row.target_kind,
      targetRef: row.target_ref,
      beforeRef: row.before_ref ?? undefined,
      afterRef: row.after_ref ?? undefined,
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }

  public createRecommendation(
    record: Omit<MemoryMaintenanceRecommendationRecord, "recommendationId"> & { recommendationId?: string },
  ): MemoryMaintenanceRecommendationRecord {
    const recommendationId = record.recommendationId ?? `mmrec_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    this.insertRecommendationStmt.run({
      recommendationId,
      workspaceId: record.workspaceId,
      kind: record.kind,
      status: record.status,
      summary: record.summary,
      proposedPatchJson: JSON.stringify(record.proposedPatch ?? {}),
      rationale: normalizeNullableText(record.rationale),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      appliedAt: record.appliedAt ?? null,
    });
    return this.getRecommendation(recommendationId);
  }

  public getRecommendation(recommendationId: string): MemoryMaintenanceRecommendationRecord {
    const row = this.getRecommendationStmt.get(recommendationId) as MemoryMaintenanceRecommendationRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Memory maintenance recommendation", id: recommendationId });
    }
    return mapRecommendationRow(row);
  }

  public updateRecommendation(record: MemoryMaintenanceRecommendationRecord): MemoryMaintenanceRecommendationRecord {
    this.updateRecommendationStmt.run({
      recommendationId: record.recommendationId,
      status: record.status,
      summary: record.summary,
      proposedPatchJson: JSON.stringify(record.proposedPatch ?? {}),
      rationale: normalizeNullableText(record.rationale),
      updatedAt: record.updatedAt,
      appliedAt: record.appliedAt ?? null,
    });
    return this.getRecommendation(record.recommendationId);
  }

  public listRecommendations(workspaceId: string, limit = 100): MemoryMaintenanceRecommendationRecord[] {
    const rows = this.listRecommendationsStmt.all({
      workspaceId,
      limit: clampLimit(limit, 500),
    }) as unknown as MemoryMaintenanceRecommendationRow[];
    return rows.map(mapRecommendationRow);
  }
}

function mapPolicyRow(row: MemoryMaintenancePolicyRow): MemoryMaintenancePolicyRecord {
  return {
    workspaceId: row.workspace_id,
    enabled: row.enabled === 1,
    runMode: row.run_mode,
    timingStrategy: row.timing_strategy,
    schedule: row.schedule_json
      ? safeJsonParse<MemoryMaintenancePolicyRecord["schedule"]>(row.schedule_json, undefined)
      : undefined,
    timeZone: row.time_zone,
    minHoursSinceLastSuccess: Number(row.min_hours_since_last_success ?? 0),
    minChangedSessions: Number(row.min_changed_sessions ?? 0),
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    executionTarget: row.execution_target,
    unavailableModelPolicy: row.unavailable_model_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStateRow(row: MemoryMaintenanceStateRow): MemoryMaintenanceStateRecord {
  return {
    workspaceId: row.workspace_id,
    lastEligibilityAt: row.last_eligibility_at ?? undefined,
    lastSuccessfulRunAt: row.last_successful_run_at ?? undefined,
    changedSessionCount: Number(row.changed_session_count ?? 0),
    activeRunId: row.active_run_id ?? undefined,
    lastRecommendationAt: row.last_recommendation_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRunRow(row: MemoryMaintenanceRunRow): MemoryMaintenanceRunRecord {
  return {
    runId: row.run_id,
    durableRunId: row.durable_run_id ?? undefined,
    workspaceId: row.workspace_id,
    triggerSource: row.trigger_source,
    status: row.status,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    policySnapshot: safeJsonParse<Record<string, unknown>>(row.policy_snapshot_json, {}),
    sourceSessionCount: Number(row.source_session_count ?? 0),
    changedArtifactCount: Number(row.changed_artifact_count ?? 0),
    summary: row.summary ?? undefined,
    error: row.error_text ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function mapRecommendationRow(row: MemoryMaintenanceRecommendationRow): MemoryMaintenanceRecommendationRecord {
  return {
    recommendationId: row.recommendation_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    proposedPatch: safeJsonParse<Record<string, unknown>>(row.proposed_patch_json, {}),
    rationale: row.rationale ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

function normalizeNullableText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value)));
}

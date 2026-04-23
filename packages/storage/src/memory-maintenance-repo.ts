/* eslint-disable max-lines -- Memory maintenance SQL ownership stays co-located while gateway direct-SQL callers are being migrated behind repositories. */
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  MemoryItemLifecycleState,
  MemoryItemRecord,
  MemoryMaintenanceChangeRecord,
  MemoryMaintenancePolicyPatchInput,
  MemoryMaintenancePolicyRecord,
  MemoryMaintenanceRecommendationRecord,
  MemoryMaintenanceRunRecord,
  MemoryMaintenanceRunSourceRecord,
  MemoryMaintenanceStateRecord,
} from "@goatcitadel/contracts";
import { NotFoundError, deriveMemoryItemLifecycleState } from "@goatcitadel/contracts";
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

interface EligibleWorkspaceSessionRow {
  session_id: string;
  modified_at: string | null;
}

interface WorkspaceMemoryItemRow {
  item_id: string;
  namespace: string;
  title: string;
  content: string;
  metadata_json: string | null;
  pinned: number;
  ttl_override_seconds: number | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceToolArtifactRow {
  artifact_id: string;
  tool_name: string;
  session_id: string;
  byte_length: number;
  snippet: string | null;
  content_type: string | null;
  created_at: string;
}

export interface EligibleWorkspaceSessionRecord {
  sessionId: string;
  modifiedAt: string;
}

export interface WorkspaceToolArtifactRecord {
  artifactId: string;
  toolName: string;
  sessionId: string;
  byteLength: number;
  snippet?: string;
  contentType?: string;
  createdAt: string;
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
  private readonly listEnabledPolicyWorkspaceIdsStmt;
  private readonly countChangedSessionsStmt;
  private readonly countChangedSessionsSinceStmt;
  private readonly listEligibleSessionsStmt;
  private readonly listEligibleSessionsSinceStmt;
  private readonly listActiveMemoryItemsStmt;
  private readonly listRecentToolArtifactsStmt;
  private readonly listRecentToolArtifactsSinceStmt;

  public constructor(private readonly db: DatabaseClient) {
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
    this.listEnabledPolicyWorkspaceIdsStmt = db.prepare(`
      SELECT workspace_id
      FROM workspace_memory_maintenance_policies
      WHERE enabled = 1
      ORDER BY workspace_id ASC
    `);
    this.countChangedSessionsStmt = db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT meta.session_id
        FROM chat_session_meta AS meta
        INNER JOIN chat_session_bindings AS binding
          ON binding.session_id = meta.session_id
        INNER JOIN chat_turn_traces AS trace
          ON trace.session_id = meta.session_id
        LEFT JOIN task_subagent_sessions AS subagent
          ON subagent.agent_session_id = meta.session_id
        WHERE meta.workspace_id = @workspaceId
          AND meta.include_in_history = 1
          AND (meta.origin IS NULL OR meta.origin = 'operator')
          AND binding.transport = 'llm'
          AND binding.writable = 1
          AND subagent.agent_session_id IS NULL
          AND trace.status = 'completed'
          AND trace.assistant_message_id IS NOT NULL
        GROUP BY meta.session_id
      ) AS changed_sessions
    `);
    this.countChangedSessionsSinceStmt = db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT meta.session_id
        FROM chat_session_meta AS meta
        INNER JOIN chat_session_bindings AS binding
          ON binding.session_id = meta.session_id
        INNER JOIN chat_turn_traces AS trace
          ON trace.session_id = meta.session_id
        LEFT JOIN task_subagent_sessions AS subagent
          ON subagent.agent_session_id = meta.session_id
        WHERE meta.workspace_id = @workspaceId
          AND meta.include_in_history = 1
          AND (meta.origin IS NULL OR meta.origin = 'operator')
          AND binding.transport = 'llm'
          AND binding.writable = 1
          AND subagent.agent_session_id IS NULL
          AND trace.status = 'completed'
          AND trace.assistant_message_id IS NOT NULL
          AND trace.finished_at > @since
        GROUP BY meta.session_id
      ) AS changed_sessions
    `);
    this.listEligibleSessionsStmt = db.prepare(`
      SELECT meta.session_id AS session_id, MAX(trace.finished_at) AS modified_at
      FROM chat_session_meta AS meta
      INNER JOIN chat_session_bindings AS binding
        ON binding.session_id = meta.session_id
      INNER JOIN chat_turn_traces AS trace
        ON trace.session_id = meta.session_id
      LEFT JOIN task_subagent_sessions AS subagent
        ON subagent.agent_session_id = meta.session_id
      WHERE meta.workspace_id = @workspaceId
        AND meta.include_in_history = 1
        AND (meta.origin IS NULL OR meta.origin = 'operator')
        AND binding.transport = 'llm'
        AND binding.writable = 1
        AND subagent.agent_session_id IS NULL
        AND trace.status = 'completed'
        AND trace.assistant_message_id IS NOT NULL
      GROUP BY meta.session_id
      ORDER BY modified_at DESC, meta.session_id DESC
      LIMIT @limit
    `);
    this.listEligibleSessionsSinceStmt = db.prepare(`
      SELECT meta.session_id AS session_id, MAX(trace.finished_at) AS modified_at
      FROM chat_session_meta AS meta
      INNER JOIN chat_session_bindings AS binding
        ON binding.session_id = meta.session_id
      INNER JOIN chat_turn_traces AS trace
        ON trace.session_id = meta.session_id
      LEFT JOIN task_subagent_sessions AS subagent
        ON subagent.agent_session_id = meta.session_id
      WHERE meta.workspace_id = @workspaceId
        AND meta.include_in_history = 1
        AND (meta.origin IS NULL OR meta.origin = 'operator')
        AND binding.transport = 'llm'
        AND binding.writable = 1
        AND subagent.agent_session_id IS NULL
        AND trace.status = 'completed'
        AND trace.assistant_message_id IS NOT NULL
        AND trace.finished_at > @since
      GROUP BY meta.session_id
      ORDER BY modified_at DESC, meta.session_id DESC
      LIMIT @limit
    `);
    this.listActiveMemoryItemsStmt = db.prepare(`
      SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds, expires_at, created_at, updated_at
      FROM memory_items
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > @now)
      ORDER BY pinned DESC, updated_at DESC
      LIMIT @limit
    `);
    this.listRecentToolArtifactsStmt = db.prepare(`
      SELECT
        artifact.artifact_id AS artifact_id,
        artifact.tool_name AS tool_name,
        artifact.session_id AS session_id,
        artifact.byte_length AS byte_length,
        artifact.snippet AS snippet,
        artifact.content_type AS content_type,
        artifact.created_at AS created_at
      FROM chat_tool_artifacts AS artifact
      INNER JOIN chat_session_meta AS meta
        ON meta.session_id = artifact.session_id
      WHERE meta.workspace_id = @workspaceId
      ORDER BY artifact.created_at DESC
      LIMIT @limit
    `);
    this.listRecentToolArtifactsSinceStmt = db.prepare(`
      SELECT
        artifact.artifact_id AS artifact_id,
        artifact.tool_name AS tool_name,
        artifact.session_id AS session_id,
        artifact.byte_length AS byte_length,
        artifact.snippet AS snippet,
        artifact.content_type AS content_type,
        artifact.created_at AS created_at
      FROM chat_tool_artifacts AS artifact
      INNER JOIN chat_session_meta AS meta
        ON meta.session_id = artifact.session_id
      WHERE meta.workspace_id = @workspaceId
        AND artifact.created_at > @since
      ORDER BY artifact.created_at DESC
      LIMIT @limit
    `);
  }

  public listEnabledPolicyWorkspaceIds(): string[] {
    const rows = this.listEnabledPolicyWorkspaceIdsStmt.all() as Array<{ workspace_id: string }>;
    return rows.map((row) => row.workspace_id);
  }

  public countChangedSessions(workspaceId: string, since?: string): number {
    const stmt = since ? this.countChangedSessionsSinceStmt : this.countChangedSessionsStmt;
    const params: { workspaceId: string; since?: string } = { workspaceId };
    if (since) {
      params.since = since;
    }
    const row = stmt.get(params) as { count: number | null } | undefined;
    return Number(row?.count ?? 0);
  }

  public listEligibleSessions(workspaceId: string, since?: string, limit = 100): EligibleWorkspaceSessionRecord[] {
    const stmt = since ? this.listEligibleSessionsSinceStmt : this.listEligibleSessionsStmt;
    const params: { workspaceId: string; limit: number; since?: string } = {
      workspaceId,
      limit: clampLimit(limit, 200),
    };
    if (since) {
      params.since = since;
    }
    const rows = stmt.all(params) as EligibleWorkspaceSessionRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      modifiedAt: row.modified_at ?? new Date(0).toISOString(),
    }));
  }

  public listActiveMemoryItems(limit = 200): MemoryItemRecord[] {
    const nowIso = new Date().toISOString();
    const rows = this.listActiveMemoryItemsStmt.all({
      now: nowIso,
      limit: clampLimit(limit, 500),
    }) as WorkspaceMemoryItemRow[];
    return rows.map((row) => ({
      itemId: row.item_id,
      namespace: row.namespace,
      title: row.title,
      content: row.content,
      metadata: parseObjectJson(row.metadata_json),
      pinned: row.pinned === 1,
      ttlOverrideSeconds: row.ttl_override_seconds ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      status: "active",
      lifecycleState: deriveMemoryItemLifecycleState(
        {
          status: "active",
          expiresAt: row.expires_at ?? undefined,
        },
        nowIso,
      ) as MemoryItemLifecycleState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public listRecentToolArtifacts(workspaceId: string, since?: string, limit = 100): WorkspaceToolArtifactRecord[] {
    const stmt = since ? this.listRecentToolArtifactsSinceStmt : this.listRecentToolArtifactsStmt;
    const params: { workspaceId: string; limit: number; since?: string } = {
      workspaceId,
      limit: clampLimit(limit, 500),
    };
    if (since) {
      params.since = since;
    }
    const rows = stmt.all(params) as WorkspaceToolArtifactRow[];
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      toolName: row.tool_name,
      sessionId: row.session_id,
      byteLength: row.byte_length,
      snippet: row.snippet ?? undefined,
      contentType: row.content_type ?? undefined,
      createdAt: row.created_at,
    }));
  }

  public findPolicy(workspaceId: string): MemoryMaintenancePolicyRecord | undefined {
    const row = toMemoryMaintenancePolicyRow(this.getPolicyStmt.get(workspaceId));
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
      schedule: patch.schedule === undefined ? current.schedule : (patch.schedule ?? undefined),
      timeZone: patch.timeZone ?? current.timeZone,
      minHoursSinceLastSuccess: patch.minHoursSinceLastSuccess ?? current.minHoursSinceLastSuccess,
      minChangedSessions: patch.minChangedSessions ?? current.minChangedSessions,
      providerId: patch.providerId === undefined ? current.providerId : (patch.providerId ?? undefined),
      model: patch.model === undefined ? current.model : (patch.model ?? undefined),
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
    const row = toMemoryMaintenanceStateRow(this.getStateStmt.get(workspaceId));
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
    const row = toMemoryMaintenanceRunRow(this.getRunStmt.get(runId));
    if (!row) {
      throw new NotFoundError({ entity: "Memory maintenance run", id: runId });
    }
    return mapRunRow(row);
  }

  public findRunByDurableRunId(durableRunId: string): MemoryMaintenanceRunRecord | undefined {
    const row = toMemoryMaintenanceRunRow(this.getRunByDurableRunStmt.get(durableRunId));
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
    const rows = toMemoryMaintenanceRunRows(
      this.listRunsStmt.all({
        workspaceId,
        limit: clampLimit(limit, 500),
      }),
    );
    return rows.map(mapRunRow);
  }

  public replaceRunSources(
    runId: string,
    records: MemoryMaintenanceRunSourceRecord[],
  ): MemoryMaintenanceRunSourceRecord[] {
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
    const rows = toMemoryMaintenanceRunSourceRows(this.listRunSourcesStmt.all(runId));
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
    const rows = toMemoryMaintenanceChangeRows(this.listRunChangesStmt.all(runId));
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
    const row = toMemoryMaintenanceRecommendationRow(this.getRecommendationStmt.get(recommendationId));
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
    const rows = toMemoryMaintenanceRecommendationRows(
      this.listRecommendationsStmt.all({
        workspaceId,
        limit: clampLimit(limit, 500),
      }),
    );
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
    policySnapshot: parseObjectJson(row.policy_snapshot_json),
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
    proposedPatch: parseObjectJson(row.proposed_patch_json),
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

function parseObjectJson(value: string | null): Record<string, unknown> {
  const parsed = safeJsonParse<unknown>(value ?? "{}", {});
  return isRecord(parsed) ? parsed : {};
}

function toMemoryMaintenancePolicyRow(value: unknown): MemoryMaintenancePolicyRow | undefined {
  return isMemoryMaintenancePolicyRow(value) ? value : undefined;
}

function toMemoryMaintenanceStateRow(value: unknown): MemoryMaintenanceStateRow | undefined {
  return isMemoryMaintenanceStateRow(value) ? value : undefined;
}

function toMemoryMaintenanceRunRow(value: unknown): MemoryMaintenanceRunRow | undefined {
  return isMemoryMaintenanceRunRow(value) ? value : undefined;
}

function toMemoryMaintenanceRunRows(value: unknown): MemoryMaintenanceRunRow[] {
  return Array.isArray(value) ? value.filter(isMemoryMaintenanceRunRow) : [];
}

function toMemoryMaintenanceRunSourceRows(value: unknown): MemoryMaintenanceRunSourceRow[] {
  return Array.isArray(value) ? value.filter(isMemoryMaintenanceRunSourceRow) : [];
}

function toMemoryMaintenanceChangeRows(value: unknown): MemoryMaintenanceChangeRow[] {
  return Array.isArray(value) ? value.filter(isMemoryMaintenanceChangeRow) : [];
}

function toMemoryMaintenanceRecommendationRow(value: unknown): MemoryMaintenanceRecommendationRow | undefined {
  return isMemoryMaintenanceRecommendationRow(value) ? value : undefined;
}

function toMemoryMaintenanceRecommendationRows(value: unknown): MemoryMaintenanceRecommendationRow[] {
  return Array.isArray(value) ? value.filter(isMemoryMaintenanceRecommendationRow) : [];
}

function isMemoryMaintenancePolicyRow(value: unknown): value is MemoryMaintenancePolicyRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.workspace_id === "string" &&
    typeof value.enabled === "number" &&
    typeof value.run_mode === "string" &&
    typeof value.timing_strategy === "string" &&
    (typeof value.schedule_json === "string" || value.schedule_json === null) &&
    typeof value.time_zone === "string" &&
    typeof value.min_hours_since_last_success === "number" &&
    typeof value.min_changed_sessions === "number" &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    typeof value.execution_target === "string" &&
    typeof value.unavailable_model_policy === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isMemoryMaintenanceStateRow(value: unknown): value is MemoryMaintenanceStateRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.workspace_id === "string" &&
    (typeof value.last_eligibility_at === "string" || value.last_eligibility_at === null) &&
    (typeof value.last_successful_run_at === "string" || value.last_successful_run_at === null) &&
    typeof value.changed_session_count === "number" &&
    (typeof value.active_run_id === "string" || value.active_run_id === null) &&
    (typeof value.last_recommendation_at === "string" || value.last_recommendation_at === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isMemoryMaintenanceRunRow(value: unknown): value is MemoryMaintenanceRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.run_id === "string" &&
    (typeof value.durable_run_id === "string" || value.durable_run_id === null) &&
    typeof value.workspace_id === "string" &&
    typeof value.trigger_source === "string" &&
    typeof value.status === "string" &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    typeof value.policy_snapshot_json === "string" &&
    typeof value.source_session_count === "number" &&
    typeof value.changed_artifact_count === "number" &&
    (typeof value.summary === "string" || value.summary === null) &&
    (typeof value.error_text === "string" || value.error_text === null) &&
    typeof value.created_at === "string" &&
    (typeof value.started_at === "string" || value.started_at === null) &&
    (typeof value.finished_at === "string" || value.finished_at === null) &&
    typeof value.updated_at === "string"
  );
}

function isMemoryMaintenanceRunSourceRow(value: unknown): value is MemoryMaintenanceRunSourceRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.source_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.source_kind === "string" &&
    typeof value.source_ref === "string" &&
    (typeof value.modified_at === "string" || value.modified_at === null) &&
    (typeof value.excerpt === "string" || value.excerpt === null) &&
    (typeof value.token_estimate === "number" || value.token_estimate === null) &&
    typeof value.created_at === "string"
  );
}

function isMemoryMaintenanceChangeRow(value: unknown): value is MemoryMaintenanceChangeRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.change_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.change_kind === "string" &&
    typeof value.target_kind === "string" &&
    typeof value.target_ref === "string" &&
    (typeof value.before_ref === "string" || value.before_ref === null) &&
    (typeof value.after_ref === "string" || value.after_ref === null) &&
    typeof value.summary === "string" &&
    typeof value.created_at === "string"
  );
}

function isMemoryMaintenanceRecommendationRow(value: unknown): value is MemoryMaintenanceRecommendationRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.recommendation_id === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.kind === "string" &&
    typeof value.status === "string" &&
    typeof value.summary === "string" &&
    typeof value.proposed_patch_json === "string" &&
    (typeof value.rationale === "string" || value.rationale === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (typeof value.applied_at === "string" || value.applied_at === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

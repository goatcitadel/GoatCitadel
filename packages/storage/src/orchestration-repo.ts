import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

export interface OrchestrationCheckpoint {
  checkpointId: string;
  runId: string;
  planId: string;
  waveId?: string;
  phaseId?: string;
  checkpointKind:
    | "run_created"
    | "durable_run_linked"
    | "worktree_allocated"
    | "run_queued"
    | "run_started"
    | "run_paused_for_approval"
    | "run_resumed"
    | "phase_approved"
    | "phase_executed"
    | "wave_advanced"
    | "run_completed"
    | "run_stopped"
    | "run_failed"
    | "run_cancelled";
  gitRef?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface OrchestrationRunRow {
  run_id: string;
  plan_id: string;
  status: OrchestrationRun["status"];
  started_at: string;
  ended_at: string | null;
  current_wave_id: string | null;
  current_phase_id: string | null;
  total_cost_usd: number;
  total_iterations: number;
  workspace_id: string | null;
  durable_run_id: string | null;
  operator_id: string | null;
  auth_actor_id: string | null;
  auth_actor_source: string | null;
  permission_profile_id: string | null;
  local_operator_override_id: string | null;
  execution_state: NonNullable<OrchestrationRun["executionState"]> | null;
  worktree_path: string | null;
  worktree_status: NonNullable<OrchestrationRun["worktreeStatus"]> | null;
  worktree_base_ref: string | null;
  pending_approval_phase_id: string | null;
  pending_approved_by: string | null;
  pending_cost_increment_usd: number | null;
  last_error: string | null;
}

interface OrchestrationCheckpointRow {
  checkpoint_id: string;
  run_id: string;
  plan_id: string;
  wave_id: string | null;
  phase_id: string | null;
  checkpoint_kind: OrchestrationCheckpoint["checkpointKind"];
  git_ref: string | null;
  details_json: string;
  created_at: string;
}

export class OrchestrationRepository {
  private readonly upsertPlanStmt;
  private readonly getPlanStmt;
  private readonly createRunStmt;
  private readonly updateRunStmt;
  private readonly updateRunIfCurrentStateStmt;
  private readonly getRunStmt;
  private readonly listRunsStmt;
  private readonly getLatestRunByPlanStmt;
  private readonly findActiveRunByPlanStmt;
  private readonly insertCheckpointStmt;
  private readonly listCheckpointsStmt;
  private readonly listCheckpointsAfterStmt;
  private readonly insertEventStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertPlanStmt = db.prepare(`
      INSERT INTO orchestration_plans (
        plan_id, plan_json, created_at, updated_at
      ) VALUES (@planId, @planJson, @createdAt, @updatedAt)
      ON CONFLICT(plan_id) DO UPDATE SET
        plan_json = excluded.plan_json,
        updated_at = excluded.updated_at
    `);

    this.getPlanStmt = db.prepare("SELECT plan_json FROM orchestration_plans WHERE plan_id = ?");

    this.createRunStmt = db.prepare(`
      INSERT INTO orchestration_runs (
        run_id, plan_id, status, started_at, ended_at,
        current_wave_id, current_phase_id, total_cost_usd, total_iterations,
        workspace_id, durable_run_id, operator_id, auth_actor_id,
        auth_actor_source, permission_profile_id, local_operator_override_id,
        execution_state, worktree_path,
        worktree_status, worktree_base_ref, pending_approval_phase_id,
        pending_approved_by, pending_cost_increment_usd, last_error
      ) VALUES (
        @runId, @planId, @status, @startedAt, @endedAt,
        @currentWaveId, @currentPhaseId, @totalCostUsd, @totalIterations,
        @workspaceId, @durableRunId, @operatorId, @authActorId,
        @authActorSource, @permissionProfileId, @localOperatorOverrideId,
        @executionState, @worktreePath,
        @worktreeStatus, @worktreeBaseRef, @pendingApprovalPhaseId,
        @pendingApprovedBy, @pendingCostIncrementUsd, @lastError
      )
    `);

    this.updateRunStmt = db.prepare(`
      UPDATE orchestration_runs SET
        status = @status,
        ended_at = @endedAt,
        current_wave_id = @currentWaveId,
        current_phase_id = @currentPhaseId,
        total_cost_usd = @totalCostUsd,
        total_iterations = @totalIterations,
        workspace_id = @workspaceId,
        durable_run_id = @durableRunId,
        operator_id = @operatorId,
        auth_actor_id = @authActorId,
        auth_actor_source = @authActorSource,
        permission_profile_id = @permissionProfileId,
        local_operator_override_id = @localOperatorOverrideId,
        execution_state = @executionState,
        worktree_path = @worktreePath,
        worktree_status = @worktreeStatus,
        worktree_base_ref = @worktreeBaseRef,
        pending_approval_phase_id = @pendingApprovalPhaseId,
        pending_approved_by = @pendingApprovedBy,
        pending_cost_increment_usd = @pendingCostIncrementUsd,
        last_error = @lastError
      WHERE run_id = @runId
    `);

    this.updateRunIfCurrentStateStmt = db.prepare(`
      UPDATE orchestration_runs SET
        status = @status,
        ended_at = @endedAt,
        current_wave_id = @currentWaveId,
        current_phase_id = @currentPhaseId,
        total_cost_usd = @totalCostUsd,
        total_iterations = @totalIterations,
        workspace_id = @workspaceId,
        durable_run_id = @durableRunId,
        operator_id = @operatorId,
        auth_actor_id = @authActorId,
        auth_actor_source = @authActorSource,
        permission_profile_id = @permissionProfileId,
        local_operator_override_id = @localOperatorOverrideId,
        execution_state = @executionState,
        worktree_path = @worktreePath,
        worktree_status = @worktreeStatus,
        worktree_base_ref = @worktreeBaseRef,
        pending_approval_phase_id = @pendingApprovalPhaseId,
        pending_approved_by = @pendingApprovedBy,
        pending_cost_increment_usd = @pendingCostIncrementUsd,
        last_error = @lastError
      WHERE run_id = @runId
        AND status = @expectedStatus
        AND (
          (@expectedExecutionState IS NULL AND execution_state IS NULL)
          OR execution_state = @expectedExecutionState
        )
    `);

    this.getRunStmt = db.prepare("SELECT * FROM orchestration_runs WHERE run_id = ?");
    this.listRunsStmt = db.prepare("SELECT * FROM orchestration_runs ORDER BY started_at DESC LIMIT @limit");
    this.getLatestRunByPlanStmt = db.prepare(
      "SELECT * FROM orchestration_runs WHERE plan_id = ? ORDER BY started_at DESC LIMIT 1",
    );
    this.findActiveRunByPlanStmt = db.prepare(`
      SELECT * FROM orchestration_runs
      WHERE plan_id = @planId
        AND COALESCE(workspace_id, 'default') = @workspaceId
        AND status IN ('queued', 'running', 'paused')
      ORDER BY started_at DESC
      LIMIT 1
    `);

    this.insertCheckpointStmt = db.prepare(`
      INSERT INTO orchestration_checkpoints (
        checkpoint_id, run_id, plan_id, wave_id, phase_id,
        checkpoint_kind, git_ref, details_json, created_at
      ) VALUES (
        @checkpointId, @runId, @planId, @waveId, @phaseId,
        @checkpointKind, @gitRef, @detailsJson, @createdAt
      )
    `);

    this.listCheckpointsStmt = db.prepare(
      "SELECT * FROM orchestration_checkpoints WHERE run_id = @runId ORDER BY created_at ASC LIMIT @limit",
    );
    this.listCheckpointsAfterStmt = db.prepare(
      "SELECT * FROM orchestration_checkpoints WHERE run_id = @runId AND created_at > @cursor ORDER BY created_at ASC LIMIT @limit",
    );

    this.insertEventStmt = db.prepare(`
      INSERT INTO orchestration_events (
        event_id, run_id, event_type, payload_json, created_at
      ) VALUES (@eventId, @runId, @eventType, @payloadJson, @createdAt)
    `);
  }

  public upsertPlan(plan: OrchestrationPlan): void {
    const now = new Date().toISOString();
    this.upsertPlanStmt.run({
      planId: plan.planId,
      planJson: JSON.stringify(plan),
      createdAt: now,
      updatedAt: now,
    });
  }

  public getPlan(planId: string): OrchestrationPlan {
    const row = this.getPlanStmt.get(planId) as { plan_json: string } | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Orchestration plan", id: planId });
    }
    return safeJsonParse<OrchestrationPlan>(row.plan_json, {
      planId,
      goal: "[corrupted orchestration plan payload]",
      mode: "auto",
      maxIterations: 1,
      maxRuntimeMinutes: 1,
      maxCostUsd: 0,
      waves: [],
    });
  }

  public createRun(run: OrchestrationRun): OrchestrationRun {
    this.createRunStmt.run({
      runId: run.runId,
      planId: run.planId,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      currentWaveId: run.currentWaveId ?? null,
      currentPhaseId: run.currentPhaseId ?? null,
      totalCostUsd: run.totalCostUsd,
      totalIterations: run.totalIterations,
      workspaceId: run.workspaceId ?? null,
      durableRunId: run.durableRunId ?? null,
      operatorId: run.operatorId ?? null,
      authActorId: run.authActorId ?? null,
      authActorSource: run.authActorSource ?? null,
      permissionProfileId: run.permissionProfileId ?? null,
      localOperatorOverrideId: run.localOperatorOverrideId ?? null,
      executionState: run.executionState ?? null,
      worktreePath: run.worktreePath ?? null,
      worktreeStatus: run.worktreeStatus ?? null,
      worktreeBaseRef: run.worktreeBaseRef ?? null,
      pendingApprovalPhaseId: run.pendingApprovalPhaseId ?? null,
      pendingApprovedBy: run.pendingApprovedBy ?? null,
      pendingCostIncrementUsd: run.pendingCostIncrementUsd ?? null,
      lastError: run.lastError ?? null,
    });

    return this.getRun(run.runId);
  }

  public updateRun(run: OrchestrationRun): OrchestrationRun {
    this.updateRunStmt.run({
      runId: run.runId,
      status: run.status,
      endedAt: run.endedAt ?? null,
      currentWaveId: run.currentWaveId ?? null,
      currentPhaseId: run.currentPhaseId ?? null,
      totalCostUsd: run.totalCostUsd,
      totalIterations: run.totalIterations,
      workspaceId: run.workspaceId ?? null,
      durableRunId: run.durableRunId ?? null,
      operatorId: run.operatorId ?? null,
      authActorId: run.authActorId ?? null,
      authActorSource: run.authActorSource ?? null,
      permissionProfileId: run.permissionProfileId ?? null,
      localOperatorOverrideId: run.localOperatorOverrideId ?? null,
      executionState: run.executionState ?? null,
      worktreePath: run.worktreePath ?? null,
      worktreeStatus: run.worktreeStatus ?? null,
      worktreeBaseRef: run.worktreeBaseRef ?? null,
      pendingApprovalPhaseId: run.pendingApprovalPhaseId ?? null,
      pendingApprovedBy: run.pendingApprovedBy ?? null,
      pendingCostIncrementUsd: run.pendingCostIncrementUsd ?? null,
      lastError: run.lastError ?? null,
    });

    return this.getRun(run.runId);
  }

  public updateRunIfCurrentState(
    run: OrchestrationRun,
    expected: Pick<OrchestrationRun, "status" | "executionState">,
  ): OrchestrationRun | undefined {
    const result = this.updateRunIfCurrentStateStmt.run({
      runId: run.runId,
      status: run.status,
      endedAt: run.endedAt ?? null,
      currentWaveId: run.currentWaveId ?? null,
      currentPhaseId: run.currentPhaseId ?? null,
      totalCostUsd: run.totalCostUsd,
      totalIterations: run.totalIterations,
      workspaceId: run.workspaceId ?? null,
      durableRunId: run.durableRunId ?? null,
      operatorId: run.operatorId ?? null,
      authActorId: run.authActorId ?? null,
      authActorSource: run.authActorSource ?? null,
      permissionProfileId: run.permissionProfileId ?? null,
      localOperatorOverrideId: run.localOperatorOverrideId ?? null,
      executionState: run.executionState ?? null,
      worktreePath: run.worktreePath ?? null,
      worktreeStatus: run.worktreeStatus ?? null,
      worktreeBaseRef: run.worktreeBaseRef ?? null,
      pendingApprovalPhaseId: run.pendingApprovalPhaseId ?? null,
      pendingApprovedBy: run.pendingApprovedBy ?? null,
      pendingCostIncrementUsd: run.pendingCostIncrementUsd ?? null,
      lastError: run.lastError ?? null,
      expectedStatus: expected.status,
      expectedExecutionState: expected.executionState ?? null,
    });

    return result.changes > 0 ? this.getRun(run.runId) : undefined;
  }

  public getRun(runId: string): OrchestrationRun {
    const row = toOrchestrationRunRow(this.getRunStmt.get(runId));
    if (!row) {
      throw new NotFoundError({ entity: "Orchestration run", id: runId });
    }
    return mapRunRow(row);
  }

  public findLatestRunByPlan(planId: string): OrchestrationRun | undefined {
    const row = toOrchestrationRunRow(this.getLatestRunByPlanStmt.get(planId));
    if (!row) {
      return undefined;
    }
    return mapRunRow(row);
  }

  public findActiveRunByPlan(planId: string, workspaceId = "default"): OrchestrationRun | undefined {
    const row = toOrchestrationRunRow(this.findActiveRunByPlanStmt.get({ planId, workspaceId }));
    if (!row) {
      return undefined;
    }
    return mapRunRow(row);
  }

  public listRuns(limit = 1000): OrchestrationRun[] {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    return toOrchestrationRunRows(this.listRunsStmt.all({ limit: safeLimit })).map(mapRunRow);
  }

  public createCheckpoint(input: Omit<OrchestrationCheckpoint, "checkpointId" | "createdAt">): OrchestrationCheckpoint {
    const checkpoint: OrchestrationCheckpoint = {
      checkpointId: randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };

    this.insertCheckpointStmt.run({
      checkpointId: checkpoint.checkpointId,
      runId: checkpoint.runId,
      planId: checkpoint.planId,
      waveId: checkpoint.waveId ?? null,
      phaseId: checkpoint.phaseId ?? null,
      checkpointKind: checkpoint.checkpointKind,
      gitRef: checkpoint.gitRef ?? null,
      detailsJson: JSON.stringify(checkpoint.details),
      createdAt: checkpoint.createdAt,
    });

    return checkpoint;
  }

  public listCheckpoints(runId: string, options: { limit?: number; cursor?: string } = {}): OrchestrationCheckpoint[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 1_000)));
    const cursor = options.cursor?.trim();
    const rows = toOrchestrationCheckpointRows(
      cursor
        ? this.listCheckpointsAfterStmt.all({ runId, cursor, limit: safeLimit })
        : this.listCheckpointsStmt.all({ runId, limit: safeLimit }),
    );
    return rows.map((row) => ({
      checkpointId: row.checkpoint_id,
      runId: row.run_id,
      planId: row.plan_id,
      waveId: row.wave_id ?? undefined,
      phaseId: row.phase_id ?? undefined,
      checkpointKind: row.checkpoint_kind,
      gitRef: row.git_ref ?? undefined,
      details: safeJsonParse<Record<string, unknown>>(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }

  public appendRunEvent(runId: string, eventType: string, payload: Record<string, unknown>): void {
    this.insertEventStmt.run({
      eventId: randomUUID(),
      runId,
      eventType,
      payloadJson: JSON.stringify(payload),
      createdAt: new Date().toISOString(),
    });
  }
}

function mapRunRow(row: OrchestrationRunRow): OrchestrationRun {
  return {
    runId: row.run_id,
    planId: row.plan_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    currentWaveId: row.current_wave_id ?? undefined,
    currentPhaseId: row.current_phase_id ?? undefined,
    totalCostUsd: row.total_cost_usd,
    totalIterations: row.total_iterations,
    workspaceId: row.workspace_id ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
    operatorId: row.operator_id ?? undefined,
    authActorId: row.auth_actor_id ?? undefined,
    authActorSource:
      row.auth_actor_source === null ? undefined : (row.auth_actor_source as OrchestrationRun["authActorSource"]),
    permissionProfileId: row.permission_profile_id ?? undefined,
    localOperatorOverrideId: row.local_operator_override_id ?? undefined,
    executionState: row.execution_state ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    worktreeStatus: row.worktree_status ?? undefined,
    worktreeBaseRef: row.worktree_base_ref ?? undefined,
    pendingApprovalPhaseId: row.pending_approval_phase_id ?? undefined,
    pendingApprovedBy: row.pending_approved_by ?? undefined,
    pendingCostIncrementUsd:
      typeof row.pending_cost_increment_usd === "number" ? row.pending_cost_increment_usd : undefined,
    lastError: row.last_error ?? undefined,
  };
}

function toOrchestrationRunRow(value: unknown): OrchestrationRunRow | undefined {
  return isOrchestrationRunRow(value) ? value : undefined;
}

function toOrchestrationRunRows(value: unknown): OrchestrationRunRow[] {
  if (!Array.isArray(value) || value.some((row) => !isOrchestrationRunRow(row))) {
    throw new TypeError("Unexpected orchestration_runs row shape");
  }
  return value;
}

function toOrchestrationCheckpointRows(value: unknown): OrchestrationCheckpointRow[] {
  return Array.isArray(value) ? value.filter(isOrchestrationCheckpointRow) : [];
}

function isOrchestrationRunRow(value: unknown): value is OrchestrationRunRow {
  return (
    isRecord(value) &&
    typeof value.run_id === "string" &&
    typeof value.plan_id === "string" &&
    typeof value.status === "string" &&
    typeof value.started_at === "string" &&
    (typeof value.ended_at === "string" || value.ended_at === null) &&
    (typeof value.current_wave_id === "string" || value.current_wave_id === null) &&
    (typeof value.current_phase_id === "string" || value.current_phase_id === null) &&
    typeof value.total_cost_usd === "number" &&
    typeof value.total_iterations === "number" &&
    (typeof value.workspace_id === "string" || value.workspace_id === null) &&
    (typeof value.durable_run_id === "string" || value.durable_run_id === null) &&
    (typeof value.operator_id === "string" || value.operator_id === null) &&
    (typeof value.auth_actor_id === "string" || value.auth_actor_id === null) &&
    (typeof value.auth_actor_source === "string" || value.auth_actor_source === null) &&
    (typeof value.permission_profile_id === "string" || value.permission_profile_id === null) &&
    (typeof value.local_operator_override_id === "string" || value.local_operator_override_id === null) &&
    (typeof value.execution_state === "string" || value.execution_state === null) &&
    (typeof value.worktree_path === "string" || value.worktree_path === null) &&
    (typeof value.worktree_status === "string" || value.worktree_status === null) &&
    (typeof value.worktree_base_ref === "string" || value.worktree_base_ref === null) &&
    (typeof value.pending_approval_phase_id === "string" || value.pending_approval_phase_id === null) &&
    (typeof value.pending_approved_by === "string" || value.pending_approved_by === null) &&
    (typeof value.pending_cost_increment_usd === "number" || value.pending_cost_increment_usd === null) &&
    (typeof value.last_error === "string" || value.last_error === null)
  );
}

function isOrchestrationCheckpointRow(value: unknown): value is OrchestrationCheckpointRow {
  return (
    isRecord(value) &&
    typeof value.checkpoint_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.plan_id === "string" &&
    (typeof value.wave_id === "string" || value.wave_id === null) &&
    (typeof value.phase_id === "string" || value.phase_id === null) &&
    typeof value.checkpoint_kind === "string" &&
    (typeof value.git_ref === "string" || value.git_ref === null) &&
    typeof value.details_json === "string" &&
    typeof value.created_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

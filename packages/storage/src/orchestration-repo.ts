import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
    | "run_started"
    | "phase_approved"
    | "wave_advanced"
    | "run_completed"
    | "run_stopped";
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
  private readonly getRunStmt;
  private readonly getLatestRunByPlanStmt;
  private readonly insertCheckpointStmt;
  private readonly listCheckpointsStmt;
  private readonly listCheckpointsAfterStmt;
  private readonly insertEventStmt;

  public constructor(private readonly db: DatabaseSync) {
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
        current_wave_id, current_phase_id, total_cost_usd, total_iterations
      ) VALUES (
        @runId, @planId, @status, @startedAt, @endedAt,
        @currentWaveId, @currentPhaseId, @totalCostUsd, @totalIterations
      )
    `);

    this.updateRunStmt = db.prepare(`
      UPDATE orchestration_runs SET
        status = @status,
        ended_at = @endedAt,
        current_wave_id = @currentWaveId,
        current_phase_id = @currentPhaseId,
        total_cost_usd = @totalCostUsd,
        total_iterations = @totalIterations
      WHERE run_id = @runId
    `);

    this.getRunStmt = db.prepare("SELECT * FROM orchestration_runs WHERE run_id = ?");
    this.getLatestRunByPlanStmt = db.prepare("SELECT * FROM orchestration_runs WHERE plan_id = ? ORDER BY started_at DESC LIMIT 1");

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
    });

    return this.getRun(run.runId);
  }

  public getRun(runId: string): OrchestrationRun {
    const row = this.getRunStmt.get(runId) as OrchestrationRunRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Orchestration run", id: runId });
    }
    return mapRunRow(row);
  }

  public findLatestRunByPlan(planId: string): OrchestrationRun | undefined {
    const row = this.getLatestRunByPlanStmt.get(planId) as OrchestrationRunRow | undefined;
    if (!row) {
      return undefined;
    }
    return mapRunRow(row);
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

  public listCheckpoints(
    runId: string,
    options: { limit?: number; cursor?: string } = {},
  ): OrchestrationCheckpoint[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 1_000)));
    const cursor = options.cursor?.trim();
    const rows = (
      cursor
        ? this.listCheckpointsAfterStmt.all({ runId, cursor, limit: safeLimit })
        : this.listCheckpointsStmt.all({ runId, limit: safeLimit })
    ) as unknown as OrchestrationCheckpointRow[];
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
    totalCostUsd: Number(row.total_cost_usd ?? 0),
    totalIterations: Number(row.total_iterations ?? 0),
  };
}

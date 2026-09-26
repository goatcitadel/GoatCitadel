import { randomUUID } from "node:crypto";
import type { OrchestrationPlan, OrchestrationRun } from "@goatcitadel/contracts";
import { validatePlan } from "./plan-schema.js";
import { findOwnershipConflicts } from "./ownership-matrix.js";

export interface RunLimitState {
  iterations: number;
  runtimeMinutes: number;
  costUsd: number;
}

export interface PhaseApprovalOptions {
  now?: string;
}

export interface PhaseAdvanceOptions {
  now?: string;
  costIncrementUsd?: number;
}

export type LimitOverrun =
  | { kind: "plan_cost"; limitUsd: number; spentUsd: number }
  | { kind: "wave_cost"; waveId: string; limitUsd: number; spentUsd: number }
  | { kind: "runtime"; limitMinutes: number; elapsedMinutes: number };

/**
 * Lists the plan limits a run went past. Limits only stop further work, so a
 * final phase can finish over budget or over time; callers report the overrun
 * alongside the completed run instead of hiding it.
 */
export function listLimitOverruns(
  plan: OrchestrationPlan,
  run: OrchestrationRun,
  now: string = run.endedAt ?? new Date().toISOString(),
): LimitOverrun[] {
  const overruns: LimitOverrun[] = [];
  if (run.totalCostUsd > plan.maxCostUsd) {
    overruns.push({ kind: "plan_cost", limitUsd: plan.maxCostUsd, spentUsd: run.totalCostUsd });
  }
  for (const wave of plan.waves) {
    const spentUsd = run.waveCostUsdByWaveId?.[wave.waveId] ?? 0;
    if (wave.budgetUsd > 0 && spentUsd > wave.budgetUsd) {
      overruns.push({ kind: "wave_cost", waveId: wave.waveId, limitUsd: wave.budgetUsd, spentUsd });
    }
  }
  const elapsedMinutes = Math.max(0, (Date.parse(now) - Date.parse(run.startedAt)) / 60000);
  if (elapsedMinutes > plan.maxRuntimeMinutes) {
    overruns.push({ kind: "runtime", limitMinutes: plan.maxRuntimeMinutes, elapsedMinutes });
  }
  return overruns;
}

export class OrchestrationEngine {
  public validate(plan: OrchestrationPlan): void {
    validatePlan(plan);

    for (const wave of plan.waves) {
      const conflicts = findOwnershipConflicts(wave);
      if (conflicts.length > 0) {
        const first = conflicts[0]!;
        throw new Error(
          `Wave ${wave.waveId} ownership conflict: ${first.agentA}:${first.pathA} overlaps ${first.agentB}:${first.pathB}`,
        );
      }
    }
  }

  public createRun(plan: OrchestrationPlan): OrchestrationRun {
    this.validate(plan);
    return {
      runId: randomUUID(),
      planId: plan.planId,
      status: "queued",
      startedAt: new Date().toISOString(),
      totalCostUsd: 0,
      totalIterations: 0,
    };
  }

  public startRun(plan: OrchestrationPlan, run: OrchestrationRun): OrchestrationRun {
    this.validate(plan);
    if (run.status !== "queued") {
      throw new Error(`Run ${run.runId} cannot be started from status ${run.status}`);
    }

    const first = this.firstPhase(plan);
    return {
      ...run,
      status: this.isApprovalGated(plan, first.phaseId) ? "paused" : "running",
      currentWaveId: first.waveId,
      currentPhaseId: first.phaseId,
      endedAt: undefined,
    };
  }

  /**
   * Approves the paused, approval-gated current phase so that it runs.
   *
   * Approval gates entry: the run resumes at the same phase and records
   * `pendingApprovalPhaseId` as the "approved, not yet run" marker that
   * {@link advancePhase} consumes once the phase has executed. Approval never
   * advances, counts an iteration, or attributes cost. If a plan limit was
   * reached while the run waited (for example its runtime), the run stops
   * instead of starting more work.
   */
  public approvePhase(
    plan: OrchestrationPlan,
    run: OrchestrationRun,
    approvedPhaseId: string,
    options: PhaseApprovalOptions = {},
  ): OrchestrationRun {
    this.validate(plan);

    if (run.status !== "paused") {
      throw new Error(`Run ${run.runId} is not waiting for approval: ${run.status}`);
    }

    if (run.currentPhaseId !== approvedPhaseId) {
      throw new Error(
        `Run ${run.runId} expected phase ${run.currentPhaseId ?? "<none>"} but received approval for ${approvedPhaseId}`,
      );
    }
    if (!this.isApprovalGated(plan, approvedPhaseId)) {
      throw new Error(`Phase ${approvedPhaseId} is not approval-gated for run ${run.runId}`);
    }

    const now = options.now ?? new Date().toISOString();
    if (
      this.shouldStopByLimits(plan, {
        iterations: run.totalIterations,
        runtimeMinutes: this.runtimeMinutes(run, now),
        costUsd: run.totalCostUsd,
      })
    ) {
      return {
        ...run,
        status: "stopped_by_limit",
        stopReason: "plan_limit",
        pendingApprovalPhaseId: undefined,
        pendingApprovedBy: undefined,
        pendingCostIncrementUsd: undefined,
        endedAt: now,
      };
    }

    return {
      ...run,
      status: "running",
      pendingApprovalPhaseId: approvedPhaseId,
      endedAt: undefined,
    };
  }

  public advancePhase(
    plan: OrchestrationPlan,
    run: OrchestrationRun,
    phaseId: string,
    options: PhaseAdvanceOptions = {},
  ): OrchestrationRun {
    this.validate(plan);

    if (run.status !== "running") {
      throw new Error(`Run ${run.runId} is not actively running: ${run.status}`);
    }
    if (run.currentPhaseId !== phaseId) {
      throw new Error(
        `Run ${run.runId} expected phase ${run.currentPhaseId ?? "<none>"} but received advancement for ${phaseId}`,
      );
    }
    if (this.isApprovalGated(plan, phaseId) && run.pendingApprovalPhaseId !== phaseId) {
      throw new Error(`Phase ${phaseId} requires approval and cannot auto-advance for run ${run.runId}`);
    }
    return this.advanceFromPhase(plan, run, phaseId, options);
  }

  public shouldStopByLimits(plan: OrchestrationPlan, state: RunLimitState): boolean {
    return (
      state.iterations >= plan.maxIterations ||
      state.runtimeMinutes >= plan.maxRuntimeMinutes ||
      state.costUsd >= plan.maxCostUsd
    );
  }

  private firstPhase(plan: OrchestrationPlan): { waveId: string; phaseId: string } {
    const firstWave = plan.waves[0]!;
    const firstPhase = firstWave.phases[0]!;

    return {
      waveId: firstWave.waveId,
      phaseId: firstPhase.phaseId,
    };
  }

  private nextPhase(plan: OrchestrationPlan, currentPhaseId: string): { waveId: string; phaseId: string } | undefined {
    for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
      const wave = plan.waves[waveIndex]!;
      const phaseIndex = wave.phases.findIndex((phase) => phase.phaseId === currentPhaseId);
      if (phaseIndex === -1) {
        continue;
      }

      const nextInWave = wave.phases[phaseIndex + 1];
      if (nextInWave) {
        return {
          waveId: wave.waveId,
          phaseId: nextInWave.phaseId,
        };
      }

      const nextWave = plan.waves[waveIndex + 1];
      const firstInNextWave = nextWave?.phases[0];
      if (nextWave && firstInNextWave) {
        return {
          waveId: nextWave.waveId,
          phaseId: firstInNextWave.phaseId,
        };
      }

      return undefined;
    }

    throw new Error(`Phase ${currentPhaseId} not found in plan ${plan.planId}`);
  }

  /** A phase waits for operator approval before it runs: every phase in `hitl` mode, or one marked `requiresApproval`. */
  private isApprovalGated(plan: OrchestrationPlan, phaseId: string): boolean {
    const phase = this.findPhase(plan, phaseId);
    return plan.mode === "hitl" || phase.requiresApproval;
  }

  private runtimeMinutes(run: OrchestrationRun, now: string): number {
    return Math.max(0, (Date.parse(now) - Date.parse(run.startedAt)) / 60000);
  }

  private advanceFromPhase(
    plan: OrchestrationPlan,
    run: OrchestrationRun,
    phaseId: string,
    options: PhaseAdvanceOptions,
  ): OrchestrationRun {
    const now = options.now ?? new Date().toISOString();
    const next = this.nextPhase(plan, phaseId);
    const costIncrementUsd = options.costIncrementUsd ?? 0;

    // Attribute the increment to the wave that owns the phase being advanced from, not the
    // wave we are advancing into. Resolving from the plan (rather than run.currentWaveId)
    // keeps attribution correct even if a caller hands us a stale current wave id.
    const executedWave = this.findWaveForPhase(plan, phaseId);
    const waveCostUsdByWaveId = {
      ...(run.waveCostUsdByWaveId ?? {}),
      [executedWave.waveId]: (run.waveCostUsdByWaveId?.[executedWave.waveId] ?? 0) + costIncrementUsd,
    };

    const candidate: OrchestrationRun = {
      ...run,
      totalIterations: run.totalIterations + 1,
      totalCostUsd: run.totalCostUsd + costIncrementUsd,
      waveCostUsdByWaveId,
      currentWaveId: next?.waveId,
      currentPhaseId: next?.phaseId,
      // Any approval for the phase that just ran has been consumed.
      pendingApprovalPhaseId: undefined,
      pendingApprovedBy: undefined,
      pendingCostIncrementUsd: undefined,
      status: next ? (this.isApprovalGated(plan, next.phaseId) ? "paused" : "running") : "completed",
      endedAt: next ? undefined : now,
    };

    // Limits stop further work. When the final phase has run there is no further
    // work, so reaching a limit there leaves the run completed; callers report any
    // overrun with listLimitOverruns.
    if (!next) {
      return candidate;
    }

    const runtimeMinutes = this.runtimeMinutes(run, now);

    if (
      this.shouldStopByLimits(plan, {
        iterations: candidate.totalIterations,
        runtimeMinutes,
        costUsd: candidate.totalCostUsd,
      })
    ) {
      return {
        ...candidate,
        status: "stopped_by_limit",
        stopReason: "plan_limit",
        endedAt: now,
      };
    }

    if (this.shouldStopByWaveBudget(executedWave, waveCostUsdByWaveId[executedWave.waveId]!)) {
      return {
        ...candidate,
        currentWaveId: executedWave.waveId,
        currentPhaseId: phaseId,
        status: "stopped_by_limit",
        stopReason: "wave_budget_exceeded",
        endedAt: now,
      };
    }

    return candidate;
  }

  private shouldStopByWaveBudget(wave: OrchestrationPlan["waves"][number], accumulatedCostUsd: number): boolean {
    return wave.budgetUsd > 0 && accumulatedCostUsd >= wave.budgetUsd;
  }

  private findWaveForPhase(plan: OrchestrationPlan, phaseId: string): OrchestrationPlan["waves"][number] {
    for (const wave of plan.waves) {
      if (wave.phases.some((candidate) => candidate.phaseId === phaseId)) {
        return wave;
      }
    }
    throw new Error(`Phase ${phaseId} not found in plan ${plan.planId}`);
  }

  private findPhase(plan: OrchestrationPlan, phaseId: string) {
    for (const wave of plan.waves) {
      const phase = wave.phases.find((candidate) => candidate.phaseId === phaseId);
      if (phase) {
        return phase;
      }
    }
    throw new Error(`Phase ${phaseId} not found in plan ${plan.planId}`);
  }
}

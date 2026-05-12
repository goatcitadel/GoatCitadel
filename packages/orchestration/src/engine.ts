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
  costIncrementUsd?: number;
}

export type PhaseAdvanceOptions = PhaseApprovalOptions;

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

    const first = this.firstPhase(plan);
    return {
      ...run,
      status: this.shouldPauseAtPhase(plan, first.phaseId) ? "paused" : "running",
      currentWaveId: first.waveId,
      currentPhaseId: first.phaseId,
      endedAt: undefined,
    };
  }

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
    const currentPhase = this.findPhase(plan, approvedPhaseId);
    if (!this.requiresApproval(plan, currentPhase.phaseId)) {
      throw new Error(`Phase ${approvedPhaseId} is not approval-gated for run ${run.runId}`);
    }

    return this.advanceFromPhase(plan, run, approvedPhaseId, options);
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
    if (this.requiresApproval(plan, phaseId)) {
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

  private shouldPauseAtPhase(plan: OrchestrationPlan, phaseId: string): boolean {
    return plan.mode === "hitl" || this.requiresApproval(plan, phaseId);
  }

  private advanceFromPhase(
    plan: OrchestrationPlan,
    run: OrchestrationRun,
    phaseId: string,
    options: PhaseAdvanceOptions,
  ): OrchestrationRun {
    const now = options.now ?? new Date().toISOString();
    const next = this.nextPhase(plan, phaseId);

    const candidate: OrchestrationRun = {
      ...run,
      totalIterations: run.totalIterations + 1,
      totalCostUsd: run.totalCostUsd + (options.costIncrementUsd ?? 0),
      currentWaveId: next?.waveId,
      currentPhaseId: next?.phaseId,
      status: next ? (this.shouldPauseAtPhase(plan, next.phaseId) ? "paused" : "running") : "completed",
      endedAt: next ? undefined : now,
    };

    const runtimeMinutes = Math.max(0, (Date.parse(now) - Date.parse(run.startedAt)) / 60000);

    if (
      next &&
      this.shouldStopByLimits(plan, {
        iterations: candidate.totalIterations,
        runtimeMinutes,
        costUsd: candidate.totalCostUsd,
      })
    ) {
      return {
        ...candidate,
        status: "stopped_by_limit",
        endedAt: now,
      };
    }

    return candidate;
  }

  private requiresApproval(plan: OrchestrationPlan, phaseId: string): boolean {
    return this.findPhase(plan, phaseId).requiresApproval;
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

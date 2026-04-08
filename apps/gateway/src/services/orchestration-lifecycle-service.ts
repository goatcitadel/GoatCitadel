/**
 * Orchestration lifecycle service.
 *
 * Holds the moved bodies for GatewayService's orchestration plan/run/phase
 * control surface (Step 8g of the gateway-service decomposition plan).
 *
 * Pattern reference: chat-turn-prep-service.ts, approval-lifecycle-service.ts.
 */

import { type OrchestrationPlan, type OrchestrationRun } from "@goatcitadel/contracts";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import { DEFAULT_WORKSPACE_ID, findPlanPhase, type GatewayService } from "./gateway-service.js";

export type OrchestrationLifecycleHost = GatewayService;

export function createOrchestrationPlan(host: OrchestrationLifecycleHost, plan: OrchestrationPlan): OrchestrationRun {
  host.storage.orchestration.upsertPlan(plan);
  const run = host.orchestrationEngine.createRun(plan);
  const persisted = host.storage.orchestration.createRun(run);

  host.createCheckpoint({
    runId: persisted.runId,
    planId: persisted.planId,
    checkpointKind: "run_created",
    details: { status: persisted.status },
  });

  host.storage.orchestration.appendRunEvent(persisted.runId, "run.created", {
    status: persisted.status,
  });

  host.publishRealtime("orchestration_event", "orchestration", {
    runId: persisted.runId,
    planId: persisted.planId,
    event: "run_created",
    status: persisted.status,
  });

  return persisted;
}

export async function runOrchestrationPlan(
  host: OrchestrationLifecycleHost,
  planId: string,
): Promise<OrchestrationRun> {
  let plan = host.storage.orchestration.getPlan(planId);
  let run = host.storage.orchestration.findLatestRunByPlan(planId);

  if (!run) {
    run = createOrchestrationPlan(host, plan);
  }

  const runBeforeHook = await host.hooksService.runInlineHooks<{
    maxIterations?: number;
    maxRuntimeMinutes?: number;
    maxCostUsd?: number;
  }>({
    workspaceId: DEFAULT_WORKSPACE_ID,
    trigger: "orchestration.run.before",
    entityType: "orchestration_run",
    entityId: run.runId,
    payload: {
      planId: plan.planId,
      goal: plan.goal,
      maxIterations: plan.maxIterations,
      maxRuntimeMinutes: plan.maxRuntimeMinutes,
      maxCostUsd: plan.maxCostUsd,
    },
    parsePatch: (value) => host.parseOrchestrationRunHookPatch(value),
    mergePatch: (current, next) => ({
      ...(current ?? {}),
      ...next,
    }),
  });
  if (runBeforeHook.blockedBy) {
    throw new Error(runBeforeHook.blockedBy.reason);
  }
  if (runBeforeHook.patch) {
    plan = {
      ...plan,
      ...(runBeforeHook.patch.maxIterations !== undefined ? { maxIterations: runBeforeHook.patch.maxIterations } : {}),
      ...(runBeforeHook.patch.maxRuntimeMinutes !== undefined
        ? { maxRuntimeMinutes: runBeforeHook.patch.maxRuntimeMinutes }
        : {}),
      ...(runBeforeHook.patch.maxCostUsd !== undefined ? { maxCostUsd: runBeforeHook.patch.maxCostUsd } : {}),
    };
    host.storage.orchestration.upsertPlan(plan);
  }

  const started = host.orchestrationEngine.startRun(plan, run);
  const persisted = host.storage.orchestration.updateRun(started);

  host.createCheckpoint({
    runId: persisted.runId,
    planId,
    waveId: persisted.currentWaveId,
    phaseId: persisted.currentPhaseId,
    checkpointKind: "run_started",
    details: {
      status: persisted.status,
    },
  });

  host.storage.orchestration.appendRunEvent(persisted.runId, "run.started", {
    status: persisted.status,
    waveId: persisted.currentWaveId,
    phaseId: persisted.currentPhaseId,
  });

  host.publishRealtime("orchestration_event", "orchestration", {
    runId: persisted.runId,
    planId,
    event: "run_started",
    status: persisted.status,
    waveId: persisted.currentWaveId,
    phaseId: persisted.currentPhaseId,
  });

  if (host.config.assistant.memory.enabled && host.config.assistant.memory.qmd.applyToOrchestration) {
    host.scheduleOrchestrationMemoryContext(plan, persisted);
  }

  return persisted;
}

export async function approvePhase(
  host: OrchestrationLifecycleHost,
  runId: string,
  phaseId: string,
  approvedBy: string,
  costIncrementUsd = 0,
): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
  const run = host.storage.orchestration.getRun(runId);
  let plan = host.storage.orchestration.getPlan(run.planId);
  const previousWaveId = run.currentWaveId;

  const phaseBeforeHook = await host.hooksService.runInlineHooks<{
    ownerAgentId?: string;
    specPath?: string;
    loopMode?: "fresh-context" | "compaction";
    requiresApproval?: boolean;
  }>({
    workspaceId: DEFAULT_WORKSPACE_ID,
    trigger: "orchestration.phase.before",
    entityType: "orchestration_phase",
    entityId: `${runId}:${phaseId}`,
    payload: {
      runId,
      phaseId,
      approvedBy,
      costIncrementUsd,
    },
    parsePatch: (value) => host.parseOrchestrationPhaseHookPatch(value),
    mergePatch: (current, next) => ({
      ...(current ?? {}),
      ...next,
    }),
  });
  if (phaseBeforeHook.blockedBy) {
    throw new Error(phaseBeforeHook.blockedBy.reason);
  }
  if (phaseBeforeHook.patch) {
    plan = host.applyOrchestrationPhaseHookPatch(plan, phaseId, phaseBeforeHook.patch);
    host.storage.orchestration.upsertPlan(plan);
  }

  const next = host.orchestrationEngine.approvePhase(plan, run, phaseId, {
    costIncrementUsd,
  });

  const persisted = host.storage.orchestration.updateRun(next);

  host.createCheckpoint({
    runId,
    planId: plan.planId,
    waveId: previousWaveId,
    phaseId,
    checkpointKind: "phase_approved",
    details: {
      approvedBy,
      status: persisted.status,
      nextWaveId: persisted.currentWaveId,
      nextPhaseId: persisted.currentPhaseId,
    },
  });

  if (previousWaveId !== persisted.currentWaveId && persisted.currentWaveId) {
    host.createCheckpoint({
      runId,
      planId: plan.planId,
      waveId: persisted.currentWaveId,
      phaseId: persisted.currentPhaseId,
      checkpointKind: "wave_advanced",
      details: {
        fromWave: previousWaveId,
        toWave: persisted.currentWaveId,
      },
    });
  }

  if (persisted.status === "completed") {
    host.createCheckpoint({
      runId,
      planId: plan.planId,
      checkpointKind: "run_completed",
      details: {
        totalIterations: persisted.totalIterations,
        totalCostUsd: persisted.totalCostUsd,
      },
    });
  }

  if (persisted.status === "stopped_by_limit") {
    host.createCheckpoint({
      runId,
      planId: plan.planId,
      checkpointKind: "run_stopped",
      details: {
        totalIterations: persisted.totalIterations,
        totalCostUsd: persisted.totalCostUsd,
      },
    });
  }

  host.storage.orchestration.appendRunEvent(runId, "phase.approved", {
    approvedBy,
    phaseId,
    status: persisted.status,
    currentWaveId: persisted.currentWaveId,
    currentPhaseId: persisted.currentPhaseId,
    totalIterations: persisted.totalIterations,
    totalCostUsd: persisted.totalCostUsd,
  });

  host.publishRealtime("orchestration_event", "orchestration", {
    runId,
    planId: plan.planId,
    event: "phase_approved",
    phaseId,
    approvedBy,
    status: persisted.status,
    currentWaveId: persisted.currentWaveId,
    currentPhaseId: persisted.currentPhaseId,
  });

  if (host.config.assistant.memory.enabled && host.config.assistant.memory.qmd.applyToOrchestration) {
    host.scheduleOrchestrationMemoryContext(plan, persisted);
  }

  host.hooksService.enqueueAfterHooks({
    workspaceId: DEFAULT_WORKSPACE_ID,
    trigger: "orchestration.phase.after",
    entityType: "orchestration_phase",
    entityId: `${runId}:${phaseId}`,
    payload: {
      runId,
      planId: plan.planId,
      phaseId,
      approvedBy,
      status: persisted.status,
      currentWaveId: persisted.currentWaveId,
      currentPhaseId: persisted.currentPhaseId,
    },
  });

  return {
    run: persisted,
    checkpoints: host.storage.orchestration.listCheckpoints(runId),
  };
}

export function getRun(host: OrchestrationLifecycleHost, runId: string): OrchestrationRun {
  return host.storage.orchestration.getRun(runId);
}

export function listRunCheckpoints(host: OrchestrationLifecycleHost, runId: string): OrchestrationCheckpoint[] {
  return host.storage.orchestration.listCheckpoints(runId);
}

// Keep the helper available even though it is not yet used in extracted bodies.
void findPlanPhase;

/**
 * Orchestration lifecycle service.
 *
 * Owns orchestration plan/run/phase lifecycle behavior behind an explicit host
 * contract while GatewayService remains the composition root.
 */

import {
  type HookTrigger,
  type OrchestrationPlan,
  type OrchestrationRun,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import type { OrchestrationEngine } from "@goatcitadel/orchestration";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";

const DEFAULT_WORKSPACE_ID = "default";

type OrchestrationRunHookPatch = {
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  maxCostUsd?: number;
};

type OrchestrationPhaseHookPatch = {
  ownerAgentId?: string;
  specPath?: string;
  loopMode?: "fresh-context" | "compaction";
  requiresApproval?: boolean;
};

export interface OrchestrationLifecycleHost {
  readonly config: {
    assistant: {
      memory: {
        enabled: boolean;
        qmd: {
          applyToOrchestration: boolean;
        };
      };
    };
  };
  readonly storage: {
    orchestration: {
      upsertPlan(plan: OrchestrationPlan): void;
      getPlan(planId: string): OrchestrationPlan;
      createRun(run: OrchestrationRun): OrchestrationRun;
      findLatestRunByPlan(planId: string): OrchestrationRun | undefined;
      updateRun(run: OrchestrationRun): OrchestrationRun;
      appendRunEvent(runId: string, event: string, payload: Record<string, unknown>): void;
      listCheckpoints(runId: string): OrchestrationCheckpoint[];
      getRun(runId: string): OrchestrationRun;
    };
  };
  readonly orchestrationEngine: Pick<OrchestrationEngine, "approvePhase" | "createRun" | "startRun">;
  readonly hooksService: {
    runInlineHooks<T extends Record<string, unknown>>(input: {
      workspaceId?: string;
      trigger: HookTrigger;
      entityType: string;
      entityId: string;
      payload: Record<string, unknown>;
      parsePatch?: (value: Record<string, unknown>) => T | undefined;
      mergePatch?: (current: T | undefined, next: T) => T;
    }): Promise<{ blockedBy?: { reason: string }; patch?: T }>;
    enqueueAfterHooks(input: {
      workspaceId?: string;
      trigger: HookTrigger;
      entityType: string;
      entityId: string;
      payload: Record<string, unknown>;
    }): void;
  };
  createCheckpoint(
    input: Omit<OrchestrationCheckpoint, "checkpointId" | "createdAt" | "gitRef">,
  ): OrchestrationCheckpoint;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  scheduleOrchestrationMemoryContext(plan: OrchestrationPlan, run: OrchestrationRun): void;
  parseOrchestrationRunHookPatch(value: Record<string, unknown>): OrchestrationRunHookPatch | undefined;
  parseOrchestrationPhaseHookPatch(value: Record<string, unknown>): OrchestrationPhaseHookPatch | undefined;
  applyOrchestrationPhaseHookPatch(
    plan: OrchestrationPlan,
    phaseId: string,
    patch: OrchestrationPhaseHookPatch,
  ): OrchestrationPlan;
}

function buildOrchestrationRealtimeLinks(input: { runId: string }): NonNullable<RealtimeEvent["links"]> {
  return {
    runId: input.runId,
  };
}

function publishOrchestrationRealtime(
  host: OrchestrationLifecycleHost,
  payload: {
    runId: string;
    planId?: string;
    event: string;
    status: string;
    waveId?: string;
    phaseId?: string;
    approvedBy?: string;
    nextWaveId?: string;
    nextPhaseId?: string;
  },
): void {
  host.publishRealtime("orchestration_event", "orchestration", payload, {
    eventClass: "domain_fact",
    eventAuthority: "retained_stream",
    links: buildOrchestrationRealtimeLinks({
      runId: payload.runId,
    }),
  });
}

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

  publishOrchestrationRealtime(host, {
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
  const run = createOrchestrationPlan(host, plan);

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

  publishOrchestrationRealtime(host, {
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
  const currentPhase = findPhaseInPlan(plan, phaseId);

  if (run.status !== "paused") {
    throw new Error(`Run ${run.runId} is not waiting for approval: ${run.status}`);
  }
  if (run.currentPhaseId !== phaseId) {
    throw new Error(
      `Run ${run.runId} expected phase ${run.currentPhaseId ?? "<none>"} but received approval for ${phaseId}`,
    );
  }
  if (plan.mode !== "hitl" && !currentPhase.requiresApproval) {
    throw new Error(`Phase ${phaseId} is not approval-gated for run ${runId}`);
  }

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
    const patchedPhase = findPhaseInPlan(plan, phaseId);
    if (plan.mode !== "hitl" && !patchedPhase.requiresApproval) {
      throw new Error(`Phase ${phaseId} is not approval-gated for run ${runId}`);
    }
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

  publishOrchestrationRealtime(host, {
    runId,
    planId: plan.planId,
    event: "phase_approved",
    phaseId,
    approvedBy,
    status: persisted.status,
    nextWaveId: persisted.currentWaveId,
    nextPhaseId: persisted.currentPhaseId,
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

function findPhaseInPlan(plan: OrchestrationPlan, phaseId: string) {
  for (const wave of plan.waves) {
    const phase = wave.phases.find((candidate) => candidate.phaseId === phaseId);
    if (phase) {
      return phase;
    }
  }
  throw new Error(`Phase ${phaseId} not found in plan ${plan.planId}`);
}

export function getRun(host: OrchestrationLifecycleHost, runId: string): OrchestrationRun {
  return host.storage.orchestration.getRun(runId);
}

export function listRunCheckpoints(host: OrchestrationLifecycleHost, runId: string): OrchestrationCheckpoint[] {
  return host.storage.orchestration.listCheckpoints(runId);
}

import {
  isChatTurnTerminalStatus,
  NotFoundError,
  type ChatTurnTraceRecord,
  type DurableRunRecord,
  type OrchestrationPlan,
  type OrchestrationPhaseExecutionResult,
  type OrchestrationRun,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type {
  OrchestrationLifecycleHost,
  OrchestrationLifecycleRuntimeDeps,
} from "./orchestration-lifecycle-service.js";
import { parseOrchestrationWorkflowPayload } from "./orchestration-lifecycle-state-helpers.js";
import {
  ORCHESTRATION_PHASE_CHILD_WAKE_EVENT,
  asString,
  asPromptReference,
  buildHarvestedWaitingExecution,
  findPhaseInPlan,
  isDurableRunTerminal,
  readRecoverableChildPhase,
} from "./orchestration-phase-child-state.js";

export type OrchestrationChildRecovery =
  | { outcome: "failed"; error: string; timelineReason?: string; runEvent?: string }
  | { outcome: "harvested"; execution: OrchestrationPhaseExecutionResult }
  | { outcome: "waiting"; childRunId: string; childRun: DurableRunRecord };

/** Read an already-dispatched child without committing, waking, or dispatching work. */
export async function prepareOrchestrationChildRecovery(
  host: Pick<OrchestrationLifecycleHost, "getDurableRun">,
  runtime: Pick<OrchestrationLifecycleRuntimeDeps, "phaseExecutor">,
  input: {
    plan: OrchestrationPlan;
    phaseId: string;
    childPhase: NonNullable<ReturnType<typeof readRecoverableChildPhase>>;
  },
): Promise<OrchestrationChildRecovery> {
  const { childPhase, phaseId } = input;
  const childRunId = childPhase.childRunId;
  if (!childRunId) {
    // An interrupted inline child cannot be reconstructed. Its phase must fail
    // recoverably rather than repeat a dispatch that may have had side effects.
    return {
      outcome: "failed",
      error: `Orchestration phase ${phaseId} dispatched a child without a durable run id before interruption; refusing to duplicate the dispatch.`,
    };
  }
  const childRun = await getDurableRunIfAvailable(host, childRunId);
  if (!childRun) {
    return {
      outcome: "failed",
      error: `Child durable run ${childRunId} is missing; refusing to duplicate orchestration phase ${phaseId}.`,
      timelineReason: "child_durable_run_missing",
      runEvent: "run.child_durable_missing",
    };
  }
  // Canonical Chat records take precedence over the earlier durable breadcrumb:
  // they include the final output, cost, and unsupported user-input waits.
  const settledChild = await runtime.phaseExecutor.harvest?.({
    phaseId,
    ownerAgentId: asString(childPhase.payload.ownerAgentId) ?? findPhaseInPlan(input.plan, phaseId).ownerAgentId,
    childRunId,
    childSessionId: asString(childPhase.payload.childSessionId),
    childTurnId: asString(childPhase.payload.childTurnId),
    startedAt: asString(childPhase.payload.startedAt),
    prompt: asPromptReference(childPhase.payload.prompt),
  });
  if (settledChild) {
    return { outcome: "harvested", execution: settledChild };
  }
  if (isDurableRunTerminal(childRun)) {
    return { outcome: "harvested", execution: buildHarvestedWaitingExecution(childPhase.payload, childRun) };
  }
  return { outcome: "waiting", childRunId, childRun };
}

/** Server-owned records read to decide whether a parked phase's child has settled. */
export interface OrchestrationPhaseChildWakeHost {
  readonly storage: {
    orchestration: Pick<OrchestrationLifecycleHost["storage"]["orchestration"], "getRun">;
    durableRuns: Pick<Storage["durableRuns"], "listRunIdsByStatus">;
    durableChildWatchers: Pick<Storage["durableChildWatchers"], "getByPair">;
    chatTurnTraces: Pick<Storage["chatTurnTraces"], "get">;
  };
  getDurableRun(runId: string): Promise<DurableRunRecord>;
  wakeDurableRun(
    runId: string,
    event: { eventKey: string; correlationId?: string; payload?: Record<string, unknown> },
  ): Promise<{ outcome: string }>;
}

/**
 * Wakes the orchestration run whose parked phase waits on this durable Chat
 * run. `orchestrationRunId` is the child's admitted policy run id. The parent
 * wakes only when it registered exactly this child (wait correlation, phase
 * breadcrumb and watcher agree) and the child has settled.
 */
export async function wakeOrchestrationPhaseParent(
  host: OrchestrationPhaseChildWakeHost,
  childRunId: string,
  orchestrationRunId: string | undefined,
): Promise<boolean> {
  const runId = orchestrationRunId?.trim();
  if (!runId) {
    return false;
  }
  const run = await getOrchestrationRunIfAvailable(host, runId);
  if (!run?.durableRunId || run.executionState !== "waiting_for_child") {
    return false;
  }
  const parent = await getDurableRunIfAvailable(host, run.durableRunId);
  return parent ? await wakeParkedOrchestrationPhase(host, parent, run, childRunId) : false;
}

/**
 * Catches up wakes that were missed, for example when a child settled before
 * its parent finished parking or the gateway restarted in between.
 */
export async function reconcileWaitingOrchestrationPhases(host: OrchestrationPhaseChildWakeHost): Promise<void> {
  const failures: unknown[] = [];
  for (const runId of await host.storage.durableRuns.listRunIdsByStatus("waiting")) {
    try {
      const parent = await getDurableRunIfAvailable(host, runId);
      const childRunId = parent ? readPhaseChildWaitCorrelation(parent) : undefined;
      const payload = parent && childRunId ? parseOrchestrationWorkflowPayload(parent) : undefined;
      if (!parent || !childRunId || !payload) {
        continue;
      }
      const run = await getOrchestrationRunIfAvailable(host, payload.orchestrationRunId);
      if (run) {
        await wakeParkedOrchestrationPhase(host, parent, run, childRunId);
      }
    } catch (error) {
      // One unreadable parent must not starve the others; report after the scan.
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Orchestration phase wake reconciliation could not check every parked run.");
  }
}

async function wakeParkedOrchestrationPhase(
  host: OrchestrationPhaseChildWakeHost,
  parent: DurableRunRecord,
  run: OrchestrationRun,
  childRunId: string,
): Promise<boolean> {
  if (
    parent.status !== "waiting" ||
    readPhaseChildWaitCorrelation(parent) !== childRunId ||
    run.durableRunId !== parent.runId ||
    run.executionState !== "waiting_for_child" ||
    !run.currentPhaseId
  ) {
    return false;
  }
  const phase = readRecoverableChildPhase(parent, run.currentPhaseId);
  if (phase?.childRunId !== childRunId) {
    return false;
  }
  const watcher = await host.storage.durableChildWatchers.getByPair(parent.runId, childRunId);
  if (watcher?.source !== "orchestration_phase") {
    return false;
  }
  if (!(await isPhaseChildSettled(host, childRunId, asString(phase.payload.childTurnId)))) {
    return false;
  }
  const result = await host.wakeDurableRun(parent.runId, {
    eventKey: ORCHESTRATION_PHASE_CHILD_WAKE_EVENT,
    correlationId: childRunId,
    payload: { orchestrationRunId: run.runId, phaseId: run.currentPhaseId },
  });
  return result.outcome === "woke";
}

/**
 * A phase child has settled once it cannot produce more phase output on its
 * own: its durable run ended (or is gone), or its turn finished or stopped to
 * ask for user input. A child waiting on an approval is still working; the
 * operator resolves that approval in Chat.
 */
async function isPhaseChildSettled(
  host: OrchestrationPhaseChildWakeHost,
  childRunId: string,
  childTurnId: string | undefined,
): Promise<boolean> {
  const child = await getDurableRunIfAvailable(host, childRunId);
  if (!child || isDurableRunTerminal(child)) {
    return true;
  }
  if (!childTurnId) {
    return false;
  }
  let traceStatus: ChatTurnTraceRecord["status"];
  try {
    traceStatus = (await host.storage.chatTurnTraces.get(childTurnId)).status;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }
    throw error;
  }
  return traceStatus === "waiting_for_user_input" || isChatTurnTerminalStatus(traceStatus);
}

function readPhaseChildWaitCorrelation(run: DurableRunRecord): string | undefined {
  const wait = asRecord(asRecord(run.metadata)?.waitForEvent);
  return wait?.eventKey === ORCHESTRATION_PHASE_CHILD_WAKE_EVENT ? asString(wait.correlationId) : undefined;
}

export async function getOrchestrationRunIfAvailable(
  host: { readonly storage: { orchestration: { getRun(runId: string): Promise<OrchestrationRun> } } },
  runId: string,
): Promise<OrchestrationRun | undefined> {
  try {
    return await host.storage.orchestration.getRun(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  }
}

export async function getDurableRunIfAvailable(
  host: Pick<OrchestrationLifecycleHost, "getDurableRun">,
  runId: string,
): Promise<DurableRunRecord | undefined> {
  try {
    return await host.getDurableRun(runId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

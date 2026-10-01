import type { DurableRunRecord, OrchestrationPhaseExecutionResult, OrchestrationPlan } from "@goatcitadel/contracts";

/**
 * Wake key a parent orchestration run parks on while its phase's child Chat
 * turn runs. The correlation id is the child's durable run id.
 */
export const ORCHESTRATION_PHASE_CHILD_WAKE_EVENT = "orchestration.phase_child.settled";

export function isDurableRunTerminal(run: DurableRunRecord): boolean {
  return ["completed", "failed", "cancelled", "dead_lettered"].includes(run.status);
}

/**
 * Reads the linkage breadcrumb for a phase that already dispatched its child
 * turn, so resume can harvest/reattach the existing child instead of
 * re-dispatching it (ORCH-002).
 *
 * Two breadcrumb shapes are recognized, both keyed on the current phase id:
 *  - `waitingPhase`: written by the approval-wait path. Always carries a child
 *    durable run id (approval waits require a linked child).
 *  - `dispatchedPhase`: written the instant a non-approval in-flight phase
 *    dispatches its child. May lack a child durable run id when durable
 *    execution was not used for the child (the unlinked case, handled by the
 *    caller as a recoverable failure rather than a re-dispatch).
 *
 * `waitingPhase` is preferred when both are present because it is the richer,
 * approval-correlated record.
 */
export function readRecoverableChildPhase(
  durableRun: DurableRunRecord,
  currentPhaseId: string,
):
  | { childRunId?: string; payload: Record<string, unknown>; breadcrumbKey: "waitingPhase" | "dispatchedPhase" }
  | undefined {
  const metadata = asRecord(durableRun.metadata);
  const waitingPhase = asRecord(metadata?.waitingPhase);
  if (waitingPhase && asString(waitingPhase.phaseId) === currentPhaseId) {
    const childRunId = asString(waitingPhase.childRunId);
    if (childRunId) {
      return { childRunId, payload: waitingPhase, breadcrumbKey: "waitingPhase" };
    }
  }
  const dispatchedPhase = asRecord(metadata?.dispatchedPhase);
  if (dispatchedPhase && asString(dispatchedPhase.phaseId) === currentPhaseId) {
    return {
      childRunId: asString(dispatchedPhase.childRunId),
      payload: dispatchedPhase,
      breadcrumbKey: "dispatchedPhase",
    };
  }
  return undefined;
}

/**
 * Fallback harvest from durable metadata when the child's canonical Chat
 * records are unavailable. The waiting payload was captured before the child
 * finished, so its cost is at most a lower bound and is flagged as unreported.
 */
export function buildHarvestedWaitingExecution(
  waitingPhase: Record<string, unknown>,
  childRun: DurableRunRecord,
): OrchestrationPhaseExecutionResult {
  const failed = childRun.status !== "completed";
  const childRunId = asString(waitingPhase.childRunId) ?? childRun.runId;
  const waitingOutputText = asString(waitingPhase.outputText);
  const childOutputText = asString(childRun.metadata?.outputText) ?? asString(childRun.metadata?.finalOutput);
  return {
    phaseId: asString(waitingPhase.phaseId) ?? "unknown",
    ownerAgentId: asString(waitingPhase.ownerAgentId) ?? "unknown",
    status: failed ? "failed" : "completed",
    startedAt: asString(waitingPhase.startedAt) ?? childRun.startedAt ?? childRun.createdAt,
    finishedAt: childRun.finishedAt ?? new Date().toISOString(),
    outputSummary: failed
      ? `Child phase durable run ${childRunId} ended as ${childRun.status}.`
      : (asString(childRun.metadata?.outputSummary) ??
        asString(childRun.metadata?.finalSummary) ??
        asString(waitingPhase.outputSummary) ??
        `Child phase durable run ${childRunId} completed after approval.`),
    outputText: failed ? (childRun.lastError ?? waitingOutputText) : (childOutputText ?? waitingOutputText),
    childSessionId: asString(waitingPhase.childSessionId),
    childTurnId: asString(waitingPhase.childTurnId),
    childRunId,
    approvalId: asString(waitingPhase.approvalId),
    responseId: asString(waitingPhase.responseId),
    model: asString(waitingPhase.model),
    costUsd: asNumber(waitingPhase.costUsd),
    costUnreported: true,
    inputTokens: asNumber(waitingPhase.inputTokens),
    outputTokens: asNumber(waitingPhase.outputTokens),
    citations: Array.isArray(waitingPhase.citations) ? (waitingPhase.citations as unknown[]) : undefined,
    artifacts: Array.isArray(waitingPhase.artifacts) ? (waitingPhase.artifacts as unknown[]) : undefined,
    prompt: asPromptReference(waitingPhase.prompt),
    error: failed
      ? (childRun.lastError ?? `Child phase durable run ${childRunId} ended as ${childRun.status}.`)
      : undefined,
  };
}

export function asPromptReference(value: unknown): OrchestrationPhaseExecutionResult["prompt"] {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.promptId !== "string" ||
    typeof record.promptVersion !== "string" ||
    typeof record.promptHash !== "string"
  ) {
    return undefined;
  }
  return {
    promptId: record.promptId,
    promptVersion: record.promptVersion,
    promptHash: record.promptHash,
  };
}

export function findPhaseInPlan(plan: OrchestrationPlan, phaseId: string) {
  for (const wave of plan.waves) {
    const phase = wave.phases.find((candidate) => candidate.phaseId === phaseId);
    if (phase) {
      return phase;
    }
  }
  throw new Error(`Phase ${phaseId} not found in plan ${plan.planId}`);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

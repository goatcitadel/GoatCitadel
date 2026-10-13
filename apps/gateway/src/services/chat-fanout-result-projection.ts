import type { ChatDelegateResponse, ChatFanoutInvocationRecord } from "@goatcitadel/contracts";

/** Pure projection of committed fanout evidence; never admits, dispatches or settles work. */
const SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT = 3_000;

export function mapDelegationStatus(response: ChatDelegateResponse): ChatFanoutInvocationRecord["status"] {
  if (response.status === "running") return "waiting";
  if (response.status === "completed") {
    return response.steps.every((step) => step.status === "completed") ? "completed" : "partial";
  }
  if (response.status === "partial") return "partial";
  return "failed";
}

export function projectDelegationResult(
  invocation: ChatFanoutInvocationRecord,
  response: ChatDelegateResponse,
): Record<string, unknown> {
  return projectCanonicalResult(invocation, response.steps, response.stitchedOutput, response.citations);
}

export function projectCanonicalResult(
  invocation: ChatFanoutInvocationRecord,
  steps: Array<{
    index: number;
    status: string;
    label?: string;
    summary?: string;
    output?: string;
    error?: string;
    durableRunId?: string;
    childSessionId?: string;
    childTurnId?: string;
  }>,
  stitchedOutput?: string,
  citations?: unknown[],
): Record<string, unknown> {
  const results = [...steps]
    .sort((left, right) => left.index - right.index)
    .map((step) => {
      const completed = step.status === "completed";
      const output = completed ? truncate(step.output?.trim() ?? "", SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT) : "";
      return {
        index: step.index,
        ...(step.label ? { label: step.label } : {}),
        status: completed
          ? "completed"
          : step.status === "running" || step.status === "pending"
            ? "waiting"
            : step.status,
        ...(step.summary ? { summary: step.summary } : {}),
        ...(output ? { output } : {}),
        ...(step.error ? { error: step.error } : {}),
        ...(step.durableRunId ? { durableRunId: step.durableRunId } : {}),
        ...(step.childSessionId ? { childSessionId: step.childSessionId } : {}),
        ...(step.childTurnId ? { childTurnId: step.childTurnId } : {}),
      };
    });
  const completedCount = results.filter((result) => result.status === "completed").length;
  const waiting = results.some((result) => result.status === "waiting");
  return {
    status: invocation.status,
    fanoutInvocationId: invocation.invocationId,
    parentRunId: invocation.parentRunId,
    toolRunId: invocation.toolRunId,
    ...(invocation.delegationRunId ? { delegationRunId: invocation.delegationRunId } : {}),
    grant: {
      grantId: invocation.grantId,
      projectId: invocation.projectId,
      reservedActivations: invocation.reservedActivations,
      reservedBudgetUsd: invocation.reservedBudgetUsd,
    },
    childCount: invocation.childCount,
    completedCount,
    waitingCount: results.filter((result) => result.status === "waiting").length,
    results,
    ...(stitchedOutput && !waiting
      ? { stitchedOutput: truncate(stitchedOutput, SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT) }
      : {}),
    ...(citations && citations.length > 0 ? { citations } : {}),
    ...(invocation.terminalReason ? { terminalReason: invocation.terminalReason } : {}),
    guidance: waiting
      ? "Fan-out is durably waiting for child terminal states or approvals. Do not synthesize from incomplete child work."
      : "Use only the committed completed-child outputs and explicit failure or approval state when synthesizing.",
  };
}


function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

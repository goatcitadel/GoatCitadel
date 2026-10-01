import {
  isChatTurnTerminalStatus,
  type ChatSendMessageResponse,
  type ChatTurnTraceRecord,
  type OrchestrationPhase,
  type OrchestrationPhaseExecutionResult,
} from "@goatcitadel/contracts";

const UNSUPPORTED_USER_INPUT_WAIT =
  "Phase child turn is waiting for user input, but durable orchestration can only pause/resume approval waits. Refactor this phase to: (1) detect where input is needed, (2) emit an approval-required tool/action and return waiting_for_approval, and (3) resume the run after approval to continue execution.";

/**
 * A child turn has settled for its phase once it finished or stopped to ask for
 * user input. Running turns and approval waits are still the child's to finish.
 */
export function isChildTurnSettled(status: ChatTurnTraceRecord["status"] | undefined): boolean {
  return status !== undefined && (status === "waiting_for_user_input" || isChatTurnTerminalStatus(status));
}

/**
 * Maps a settled child turn onto its phase. Only a finished turn with assistant
 * output completes the phase; a wait for user input fails it, because
 * orchestration cannot answer the question.
 */
export function describeSettledChildTurn(
  status: ChatTurnTraceRecord["status"] | undefined,
  assistantText: string,
  failure: string | undefined,
): { completed: boolean; error?: string } {
  const finished = status === "completed" || status === "partial";
  if (status === "waiting_for_user_input") {
    return { completed: false, error: UNSUPPORTED_USER_INPUT_WAIT };
  }
  if (finished && assistantText) {
    return { completed: true };
  }
  return {
    completed: false,
    error:
      failure ??
      (finished
        ? "Phase child turn finished without assistant output."
        : `Phase child turn ended as ${status ?? "unknown"}.`),
  };
}

/** Maps a settled child response when its canonical records cannot be read. */
export function settledChildResponseResult(
  phase: Pick<OrchestrationPhase, "phaseId" | "ownerAgentId">,
  startedAt: string,
  response: ChatSendMessageResponse,
  prompt: OrchestrationPhaseExecutionResult["prompt"],
): OrchestrationPhaseExecutionResult {
  const assistantText = response.assistantMessage?.content?.trim() ?? "";
  const { completed, error } = describeSettledChildTurn(
    response.trace?.status,
    assistantText,
    response.trace?.failure?.message ?? response.trace?.failure?.failureClass,
  );
  const costUsd = response.assistantMessage?.costUsd;
  return {
    phaseId: phase.phaseId,
    ownerAgentId: phase.ownerAgentId,
    status: completed ? "completed" : "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    outputSummary: summarizePhaseOutput(assistantText || error),
    outputText: assistantText || error,
    childSessionId: response.sessionId,
    childTurnId: response.turnId,
    childRunId: response.trace?.durable?.runId,
    model: response.model ?? response.trace?.model,
    costUsd,
    ...(costUsd === undefined ? { costUnreported: true } : {}),
    inputTokens: response.assistantMessage?.tokenInput,
    outputTokens: response.assistantMessage?.tokenOutput,
    citations: response.citations,
    prompt,
    error,
  };
}

export function summarizePhaseOutput(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
}

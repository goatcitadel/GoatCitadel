import type { ChatTurnTraceRecord, OrchestrationPhaseExecutionResult } from "@goatcitadel/contracts";
import type {
  OrchestrationChildTurnUsage,
  OrchestrationPhaseHarvestInput,
} from "./orchestration-phase-execution-service.js";
import { describeSettledChildTurn, isChildTurnSettled, summarizePhaseOutput } from "./orchestration-phase-output.js";

interface PhaseHarvestDependencies {
  readChatTurnTrace?(turnId: string): Promise<ChatTurnTraceRecord | undefined>;
  readChatMessageContent?(messageId: string): Promise<string | undefined>;
  readChatTurnUsage?(input: { sessionId: string; turnId: string }): Promise<OrchestrationChildTurnUsage>;
}

/** Canonical child result reads; dispatch and lifecycle mutations remain with their owners. */
export async function harvestOrchestrationPhase(
  deps: PhaseHarvestDependencies,
  input: OrchestrationPhaseHarvestInput,
): Promise<OrchestrationPhaseExecutionResult | undefined> {
  if (!input.childTurnId || !deps.readChatTurnTrace) {
    return undefined;
  }
  const trace = await deps.readChatTurnTrace(input.childTurnId);
  if (!trace || !isChildTurnSettled(trace.status)) {
    return undefined;
  }
  const assistantText = trace.assistantMessageId
    ? ((await deps.readChatMessageContent?.(trace.assistantMessageId)) ?? "").trim()
    : "";
  const usage =
    input.childSessionId && deps.readChatTurnUsage
      ? await deps.readChatTurnUsage({ sessionId: input.childSessionId, turnId: input.childTurnId })
      : undefined;
  const { completed, error } = describeSettledChildTurn(
    trace.status,
    assistantText,
    trace.failure?.message ?? trace.failure?.failureClass,
  );
  const outputText = assistantText || error;
  return {
    phaseId: input.phaseId,
    ownerAgentId: input.ownerAgentId,
    status: completed ? "completed" : "failed",
    startedAt: input.startedAt ?? trace.startedAt,
    finishedAt: trace.finishedAt ?? new Date().toISOString(),
    outputSummary: summarizePhaseOutput(outputText),
    outputText,
    childSessionId: input.childSessionId,
    childTurnId: input.childTurnId,
    childRunId: input.childRunId,
    model: trace.model,
    ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(!usage?.costComplete ? { costUnreported: true } : {}),
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    citations: trace.citations,
    prompt: input.prompt,
    error,
  };
}

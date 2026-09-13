import {
  REMOTE_WORKER_BUDGET_MAX_ATTEMPTS,
  REMOTE_WORKER_INFERENCE_MAX_OUTPUT_CHARS,
  canonicalJsonString,
  isModelUsageProvenNotDispatched,
  type ModelUsageEventRecord,
  type RemoteWorkerInferenceToolCall,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { LlmService } from "./llm-service.js";
import { readRemoteWorkerModelToolCalls } from "./remote-worker-model-tool-calls.js";
import { routeReceiptFor } from "./remote-worker-inference-service.js";
import type {
  RemoteWorkerInferenceDispatchOutcome,
  RemoteWorkerInferenceDispatchRequest,
} from "./remote-worker-inference-llm-adapter.js";

export interface RemoteWorkerLlmServiceAdapterDependencies {
  readonly llm: Pick<LlmService, "chatCompletionsWithDispatchGuard">;
  readonly complete?: LlmService["chatCompletionsWithDispatchGuard"];
  readonly budgets: Pick<
    AsyncStorage["remoteWorkerBudgets"],
    | "getReservationForOperation"
    | "authorizeAttempt"
    | "authorizeRelatedAttempt"
    | "reconcileRelatedAttempts"
    | "listRelatedAttempts"
  >;
  readonly usage: Pick<AsyncStorage["modelUsageEvents"], "listOperationAttemptsForUpdate">;
  /** Recheck canonical assignment, policy and capabilities for every transport attempt. */
  readonly assertAuthorityCurrent: (request: RemoteWorkerInferenceDispatchRequest) => Promise<void>;
}

/** Reuses LlmService and its sole HX-306 owner; it never creates a second usage event. */
export class RemoteWorkerInferenceLlmServiceAdapter {
  public constructor(private readonly dependencies: RemoteWorkerLlmServiceAdapterDependencies) {}

  public async dispatch(request: RemoteWorkerInferenceDispatchRequest): Promise<RemoteWorkerInferenceDispatchOutcome> {
    const { operationId, dispatchGeneration } = request.attribution;
    if (!operationId || !dispatchGeneration) throw new Error("Worker inference requires canonical dispatch identity.");
    const reservation = await this.dependencies.budgets.getReservationForOperation(operationId, dispatchGeneration);
    if (!reservation) throw new Error("Worker inference has no budget reservation.");
    let output: string | undefined;
    let toolCalls: readonly RemoteWorkerInferenceToolCall[] | undefined;
    let failed = false;
    try {
      const complete =
        this.dependencies.complete ??
        this.dependencies.llm.chatCompletionsWithDispatchGuard.bind(this.dependencies.llm);
      const response = await complete(
        {
          providerId: request.resolution.providerId,
          model: request.resolution.modelId,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.parts ?? message.text,
            ...(message.name === undefined ? {} : { name: message.name }),
            ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
            ...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
              id: call.callId, type: "function" as const,
              function: { name: call.modelToolName, arguments: call.argumentsJson },
            })) } : {}),
          })),
          max_tokens:
            request.reasoningTokenCeiling > 0
              ? Math.min(request.effectiveOutputTokenCap, request.reasoningTokenCeiling)
              : request.effectiveOutputTokenCap,
          temperature: request.temperatureMilli / 1000,
          reasoning: { effort: request.reasoningTokenCeiling === 0 ? "none" : "low" },
          // A provider without a separate numeric reasoning limit gets a total-output ceiling
          // no larger than the reasoning allowance. Zero allowance explicitly disables it.
          signal: request.signal,
          memory: request.memory,
          ...(request.tools?.length
            ? { tools: request.tools.map((tool) => structuredClone(tool)), tool_choice: "auto", parallel_tool_calls: false }
            : {}),
        },
        request.attribution,
        async (attempt) => {
          if (attempt.attribution.operationId !== operationId) {
            await this.dependencies.assertAuthorityCurrent(request);
            if (!Number.isSafeInteger(attempt.effectiveOutputTokenCap) || (attempt.effectiveOutputTokenCap ?? 0) <= 0)
              throw new Error("Worker related model dispatch requires an enforceable output bound.");
            await this.dependencies.budgets.authorizeRelatedAttempt({
              reservation,
              usageEventId: attempt.usageEventId,
              route: routeReceiptFor(attempt.route),
            });
            return;
          }
          if (
            canonicalJsonString(attempt.route) !== canonicalJsonString(request.resolution) ||
            attempt.transportAttemptIndex >= REMOTE_WORKER_BUDGET_MAX_ATTEMPTS ||
            attempt.effectiveOutputTokenCap === undefined ||
            attempt.effectiveOutputTokenCap > request.effectiveOutputTokenCap ||
            (request.reasoningTokenCeiling === 0 && attempt.attribution.dispatchedReasoningEffort !== "none") ||
            attempt.attribution.operationId !== operationId ||
            attempt.attribution.dispatchGeneration !== dispatchGeneration
          ) {
            throw new Error("Worker inference dispatch route or ceiling changed.");
          }
          await this.dependencies.assertAuthorityCurrent(request);
          await this.dependencies.budgets.authorizeAttempt(reservation, attempt.usageEventId);
        },
      );
      const choice = response.choices?.[0];
      toolCalls = readRemoteWorkerModelToolCalls(choice, request.tools);
      const content = choice?.message?.content;
      if (
        !(typeof content === "string" || (content == null && toolCalls?.length)) ||
        (typeof content === "string" && content.length > REMOTE_WORKER_INFERENCE_MAX_OUTPUT_CHARS)
      ) {
        throw new Error("Worker inference response exceeds its output contract.");
      }
      output = typeof content === "string" ? content : "";
    } catch {
      failed = true;
    }
    await this.dependencies.budgets.reconcileRelatedAttempts(reservation);
    const related = await this.dependencies.budgets.listRelatedAttempts(reservation);
    const attempts = await this.dependencies.usage.listOperationAttemptsForUpdate(operationId, dispatchGeneration);
    if (!attempts.length) throw new Error("Worker inference stopped before provider dispatch.");
    const uncertain =
      attempts.some(isUncertain) ||
      related.some(
        (attempt) =>
          isUncertain(attempt) || (!isModelUsageProvenNotDispatched(attempt) && attempt.costUsd === undefined),
      );
    const usageEventIds = attempts.map((attempt) => attempt.eventId);
    const terminalState = uncertain
      ? "dispatch_unknown"
      : request.signal?.aborted
        ? "cancelled"
        : failed
          ? "failed"
          : "completed";
    return {
      terminalState,
      chunks: !output || uncertain ? [] : [output],
      usageEventId: usageEventIds[usageEventIds.length - 1]!,
      usageEventIds,
      transportAttempts: attempts.filter((attempt) => !isModelUsageProvenNotDispatched(attempt)).length,
      ...(terminalState === "completed" && toolCalls ? { toolCalls } : {}),
      ...(terminalState === "completed"
        ? {}
        : { errorCode: uncertain ? "provider_dispatch_uncertain" : "provider_execution_failed" }),
    };
  }
}

function isUncertain(attempt: ModelUsageEventRecord): boolean {
  if (isModelUsageProvenNotDispatched(attempt)) return false;
  return attempt.transportStatus !== "accepted" || attempt.terminalOutcome === "in_flight" || !attempt.finishedAt;
}

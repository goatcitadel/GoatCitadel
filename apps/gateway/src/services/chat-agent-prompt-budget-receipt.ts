import type {
  ChatCompletionRequest,
  ChatNormalizationProfile,
  ChatPromptContextBudgetReceipt,
  ChatToolRunRecord,
  ChatTurnExecutionProfile,
} from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";

/** Shared estimator for missing provider usage and on-demand context visibility. */
export function estimateFirstProviderRequestInputTokens(request: ChatCompletionRequest): number {
  const serialized = canonicalJsonString({
    messages: request.messages,
    tools: request.tools ?? [],
    toolChoice: request.tool_choice ?? null,
    memory: request.memory ?? null,
    reasoning: request.reasoning ?? null,
    verbosity: request.verbosity ?? null,
  });
  const structuralOverhead = request.messages.length * 4 + (request.tools?.length ?? 0) * 8 + 3;
  return Math.max(1, estimateTokensFromText(serialized) + structuralOverhead);
}

export function buildModelVisibleContextBudget(request: ChatCompletionRequest, contextWindow?: number) {
  const contextWindowTokens = positiveIntegerOrNull(contextWindow);
  const outputReservedTokens = positiveIntegerOrNull(request.max_tokens);
  const estimatedInputTokens = estimateFirstProviderRequestInputTokens(request);
  return {
    basis: "next_provider_request_estimate" as const,
    providerId: request.providerId ?? null,
    model: request.model ?? null,
    contextWindowTokens,
    estimatedInputTokens,
    outputReservedTokens,
    remainingInputTokens:
      contextWindowTokens === null || outputReservedTokens === null
        ? null
        : Math.max(0, contextWindowTokens - estimatedInputTokens - outputReservedTokens),
    caveat:
      "Estimate only. Provider-added context and tokenizer differences are not measured; this is not reported usage or execution authority.",
  };
}

function positiveIntegerOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface BuildPromptContextBudgetReceiptInput {
  readonly executionProfile: ChatTurnExecutionProfile;
  readonly messages: ChatCompletionRequest["messages"];
  readonly tools?: readonly Record<string, unknown>[];
  readonly toolRuns?: readonly ChatToolRunRecord[];
}

export function shouldCapturePromptContextBudgetReceipt(input: {
  readonly debugEnabled: boolean;
  readonly executionProfile: ChatTurnExecutionProfile;
  readonly normalizationProfile: ChatNormalizationProfile;
}): boolean {
  return (
    input.debugEnabled || input.executionProfile === "quick_web" || input.normalizationProfile === "prompt_pack_harness"
  );
}

export function buildPromptContextBudgetReceipt(
  input: BuildPromptContextBudgetReceiptInput,
): ChatPromptContextBudgetReceipt {
  const systemText = stringifyMessages(input.messages.filter((message) => message.role === "system"));
  const historyText = stringifyMessages(
    input.messages.filter((message) => message.role !== "system" && message.role !== "tool"),
  );
  const toolMessages = input.messages.filter((message) => message.role === "tool");
  const toolSchemaText = stringifyUnknown(input.tools ?? []);
  const toolResultText =
    toolMessages.length > 0
      ? stringifyMessages(toolMessages)
      : stringifyUnknown((input.toolRuns ?? []).map((run) => run.result ?? run.error ?? ""));
  const charCounts = {
    system: systemText.length,
    history: historyText.length,
    toolSchemas: toolSchemaText.length,
    toolResults: toolResultText.length,
    total: systemText.length + historyText.length + toolSchemaText.length + toolResultText.length,
  };
  const tokenEstimates = {
    system: estimateTokensFromText(systemText),
    history: estimateTokensFromText(historyText),
    toolSchemas: estimateTokensFromText(toolSchemaText),
    toolResults: estimateTokensFromText(toolResultText),
    total: 0,
  };
  tokenEstimates.total =
    tokenEstimates.system + tokenEstimates.history + tokenEstimates.toolSchemas + tokenEstimates.toolResults;
  return {
    executionProfile: input.executionProfile,
    messageCount: input.messages.length,
    toolSchemaCount: input.tools?.length ?? 0,
    toolResultCount: input.toolRuns?.filter((run) => run.result || run.error).length ?? 0,
    charCounts,
    tokenEstimates,
  };
}

function stringifyMessages(messages: ChatCompletionRequest["messages"]): string {
  return messages.map((message) => `${message.role.toUpperCase()}: ${stringifyUnknown(message.content)}`).join("\n\n");
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

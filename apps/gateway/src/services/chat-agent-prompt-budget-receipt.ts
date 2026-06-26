import type {
  ChatCompletionRequest,
  ChatPromptContextBudgetReceipt,
  ChatToolRunRecord,
  ChatTurnExecutionProfile,
} from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";

export interface BuildPromptContextBudgetReceiptInput {
  readonly executionProfile: ChatTurnExecutionProfile;
  readonly messages: ChatCompletionRequest["messages"];
  readonly tools?: readonly Record<string, unknown>[];
  readonly toolRuns?: readonly ChatToolRunRecord[];
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

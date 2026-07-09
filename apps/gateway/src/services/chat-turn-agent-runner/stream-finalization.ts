import type {
  ChatMode,
  ChatNormalizationProfile,
  ChatToolRunRecord,
  ChatTurnFailureRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";

export interface ChatTurnCompletionFinalizationInput {
  completion: NonNullable<ChatTurnTraceRecord["completion"]>;
  finalStatus: ChatTurnTraceRecord["status"];
  approvalPending: boolean;
  userInputPending: boolean;
}

export interface RecoverableCompletionFailureClassifiers {
  looksLikeRecoverableAssistantFallbackContent: (content: string) => boolean;
  looksLikeDegradedAssistantFallbackContent: (content: string) => boolean;
  looksLikeSerializedToolCallMarkupContent: (content: string) => boolean;
}

export interface RecoverableCompletionFailureInput {
  normalizationProfile: ChatNormalizationProfile;
  mode: ChatMode;
  finalStatus: ChatTurnTraceRecord["status"];
  approvalPending: boolean;
  completion: NonNullable<ChatTurnTraceRecord["completion"]>;
  failure: ChatTurnFailureRecord | undefined;
  assistantContent: string;
  toolRuns: ChatToolRunRecord[];
}

export function finalizeTurnCompletionState(
  input: ChatTurnCompletionFinalizationInput,
): NonNullable<ChatTurnTraceRecord["completion"]> {
  if (input.approvalPending || input.userInputPending) {
    return {
      ...input.completion,
      status: "backgrounded",
    };
  }
  if (input.finalStatus === "cancelled") {
    return {
      ...input.completion,
      status: "interrupted",
    };
  }
  if (input.finalStatus === "failed" && input.completion.status === "complete") {
    return {
      ...input.completion,
      status: "interrupted",
    };
  }
  return input.completion;
}

export function shouldClearRecoverableCompletionFailureWithClassifiers(
  input: RecoverableCompletionFailureInput,
  classifiers: RecoverableCompletionFailureClassifiers,
): boolean {
  if (input.finalStatus !== "completed" || input.approvalPending || !input.failure) {
    return false;
  }
  const clearableSurface =
    input.normalizationProfile === "prompt_pack_harness" ||
    input.normalizationProfile === "quick_web" ||
    input.mode === "cowork";
  if (!clearableSurface) {
    return false;
  }
  if (
    input.normalizationProfile === "prompt_pack_harness" &&
    /\btool run budget exceeded\b|\btool budget\b/i.test(input.failure.message) &&
    input.toolRuns.some((run) => run.status === "executed" && run.result)
  ) {
    return (
      input.assistantContent.trim().length > 0 &&
      !classifiers.looksLikeRecoverableAssistantFallbackContent(input.assistantContent) &&
      !classifiers.looksLikeDegradedAssistantFallbackContent(input.assistantContent) &&
      !classifiers.looksLikeSerializedToolCallMarkupContent(input.assistantContent) &&
      // No \b after the closing quote: quote->space is not a word boundary.
      !/\bsay\s+"keep going"|best next move:\s*retry|parts of this answer may be incomplete/i.test(
        input.assistantContent,
      )
    );
  }
  if (!input.completion.repaired || input.failure.recommendedAction !== "continue_from_partial") {
    return false;
  }
  const clearableFailure =
    /provider stopped before the answer finished|repair pass is required|tool calls were fully assembled/i.test(
      input.failure.message,
    );
  if (!clearableFailure) {
    return false;
  }
  return (
    input.assistantContent.trim().length > 0 &&
    !classifiers.looksLikeRecoverableAssistantFallbackContent(input.assistantContent) &&
    !classifiers.looksLikeDegradedAssistantFallbackContent(input.assistantContent) &&
    !classifiers.looksLikeSerializedToolCallMarkupContent(input.assistantContent)
  );
}

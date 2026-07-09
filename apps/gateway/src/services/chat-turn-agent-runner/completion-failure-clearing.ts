import type {
  ChatMode,
  ChatNormalizationProfile,
  ChatToolRunRecord,
  ChatTurnFailureRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";

export interface RecoverableCompletionFailurePredicateInput {
  normalizationProfile: ChatNormalizationProfile;
  mode: ChatMode;
  finalStatus: ChatTurnTraceRecord["status"];
  approvalPending: boolean;
  completion: NonNullable<ChatTurnTraceRecord["completion"]>;
  failure: ChatTurnFailureRecord | undefined;
  assistantContent: string;
  toolRuns: ChatToolRunRecord[];
}

export interface CompletionFailureClearingInput extends RecoverableCompletionFailurePredicateInput {
  shouldClearRecoverableCompletionFailure: (input: RecoverableCompletionFailurePredicateInput) => boolean;
}

export interface CompletionFailureClearingResult {
  completion: NonNullable<ChatTurnTraceRecord["completion"]>;
  failure: ChatTurnFailureRecord | undefined;
}

export function applyCompletionFailureClearing(input: CompletionFailureClearingInput): CompletionFailureClearingResult {
  if (
    !input.failure ||
    !input.shouldClearRecoverableCompletionFailure({
      normalizationProfile: input.normalizationProfile,
      mode: input.mode,
      finalStatus: input.finalStatus,
      approvalPending: input.approvalPending,
      completion: input.completion,
      failure: input.failure,
      assistantContent: input.assistantContent,
      toolRuns: input.toolRuns,
    })
  ) {
    return {
      completion: input.completion,
      failure: input.failure,
    };
  }

  return {
    completion: {
      ...input.completion,
      failureCleared: {
        failureClass: input.failure.failureClass,
        message: input.failure.message,
      },
    },
    failure: undefined,
  };
}

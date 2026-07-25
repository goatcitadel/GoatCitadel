import type {
  ChatCompletionRequest,
  ChatMode,
  ChatNormalizationProfile,
  ChatRetrievalMode,
  ChatSpeedMode,
  ChatSubagentPolicy,
  ChatStreamChunkDraft,
  ChatThinkingLevel,
  ChatTurnCapabilityProfileRecord,
  ChatTurnBranchKind,
  ChatTurnTraceRecord,
  ChatWebMode,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";

export interface TurnRuntimeRequest {
  sessionId: string;
  turnId: string;
  userMessageId: string;
  /** Canonical persisted delegation step for a server-created worker turn. */
  parentDelegationStepId?: string;
  parentTurnId?: string;
  branchKind?: ChatTurnBranchKind;
  sourceTurnId?: string;
  content: string;
  mode: ChatMode;
  model?: string;
  providerId?: string;
  webMode: ChatWebMode;
  memoryMode: "auto" | "on" | "off";
  retrievalMode: ChatRetrievalMode;
  thinkingLevel: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
  toolAutonomy: "safe_auto" | "manual";
  normalizationProfile?: ChatNormalizationProfile;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  permissionProfileId?: string;
  policyContext?: ToolPolicyActorContext;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  fullWebAccess?: boolean;
  historyMessages: ChatCompletionRequest["messages"];
  outputMessageId?: string;
  modelRouter?: ChatTurnTraceRecord["routing"]["modelRouter"];
  signal?: AbortSignal;
  canonicalWriteFence?: <T>(work: () => T) => T;
  /** Immutable server-owned capability upper bound for this admitted Chat turn. */
  capabilityProfile?: ChatTurnCapabilityProfileRecord;
  /** Original admitted content when a durable continuation adds answered-prompt context. */
  capabilityProfileContent?: string;
  /** Stable provider/model/capability-selection dimension used by compaction hysteresis. */
  compactionDimensionHash?: string;
}

export interface TurnRuntimeResult {
  turnTrace: ChatTurnTraceRecord;
  assistantContent: string;
  assistantModel?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
  modelUsageEventIds?: string[];
  requiresApproval?: {
    approvalId: string;
    toolName?: string;
    reason?: string;
    expiresAt?: string;
  };
}

export interface TurnRuntime {
  run(input: TurnRuntimeRequest): Promise<TurnRuntimeResult>;
  runStream(input: TurnRuntimeRequest): AsyncGenerator<ChatStreamChunkDraft>;
}

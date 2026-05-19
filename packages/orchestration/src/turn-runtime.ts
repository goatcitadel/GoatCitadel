import type {
  ChatCompletionRequest,
  ChatMode,
  ChatNormalizationProfile,
  ChatSpeedMode,
  ChatSubagentPolicy,
  ChatStreamChunkDraft,
  ChatThinkingLevel,
  ChatTurnBranchKind,
  ChatTurnTraceRecord,
  ChatWebMode,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";

export interface TurnRuntimeRequest {
  sessionId: string;
  turnId: string;
  userMessageId: string;
  parentTurnId?: string;
  branchKind?: ChatTurnBranchKind;
  sourceTurnId?: string;
  content: string;
  mode: ChatMode;
  model?: string;
  providerId?: string;
  webMode: ChatWebMode;
  memoryMode: "auto" | "on" | "off";
  thinkingLevel: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
  toolAutonomy: "safe_auto" | "manual";
  normalizationProfile?: ChatNormalizationProfile;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: ToolPolicyActorContext["authActorSource"];
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  historyMessages: ChatCompletionRequest["messages"];
  outputMessageId?: string;
  signal?: AbortSignal;
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

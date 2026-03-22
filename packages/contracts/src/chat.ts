import type { DurableRunStatus } from "./durable.js";
import type { SkillSourceProvider } from "./skills.js";

export type ChatProjectLifecycleStatus = "active" | "archived";
export type ChatSessionScope = "mission" | "external";
export type ChatSessionLifecycleStatus = "active" | "archived";
export type ChatBindingTransport = "llm" | "integration";
export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatAttachmentMediaType = "text" | "image" | "audio" | "video" | "binary";
export type ChatMode = "chat" | "cowork" | "code";
export type ChatModeTeamBehavior = "single_lead" | "guided_swarm" | "constrained_squad";
export type ChatWebMode = "auto" | "off" | "quick" | "deep";
export type ChatMemoryMode = "auto" | "on" | "off";
export type ChatThinkingLevel = "minimal" | "standard" | "extended";
export type ChatProactiveMode = "off" | "suggest" | "auto_safe";
export type ChatRetrievalMode = "standard" | "layered";
export type ChatReflectionMode = "off" | "on";
export type ChatPlanningMode = "off" | "advisory";
export type ChatOrchestrationIntensity = "minimal" | "balanced" | "deep";
export type ChatOrchestrationVisibility = "hidden" | "summarized" | "expandable" | "explicit";
export type ChatOrchestrationProviderPreference = "speed" | "quality" | "balanced" | "low_cost";
export type ChatOrchestrationReviewDepth = "off" | "standard" | "strict";
export type ChatOrchestrationParallelism = "auto" | "sequential" | "parallel";
export type ChatCodeAutoApplyPosture = "manual" | "low_risk_auto" | "aggressive_auto";
export type ChatTurnBranchKind = "append" | "retry" | "edit";
export type ChatDelegationMode = "sequential" | "parallel";
export type ChatDelegationStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type ChatDelegationRunStatus = "running" | "completed" | "failed" | "partial";

export type ChatInputPart =
  | {
    type: "text";
    text: string;
  }
  | {
    type: "image_ref";
    attachmentId: string;
    mimeType?: string;
    detail?: "low" | "high" | "auto";
  }
  | {
    type: "audio_ref";
    attachmentId: string;
    mimeType?: string;
  }
  | {
    type: "video_ref";
    attachmentId: string;
    mimeType?: string;
  }
  | {
    type: "file_ref";
    attachmentId: string;
    mimeType?: string;
  };

export interface ChatProjectRecord {
  projectId: string;
  workspaceId?: string;
  name: string;
  description?: string;
  workspacePath: string;
  color?: string;
  lifecycleStatus: ChatProjectLifecycleStatus;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionRecord {
  sessionId: string;
  sessionKey: string;
  workspaceId?: string;
  scope: ChatSessionScope;
  title?: string;
  pinned: boolean;
  lifecycleStatus: ChatSessionLifecycleStatus;
  archivedAt?: string;
  projectId?: string;
  projectName?: string;
  channel: string;
  account: string;
  updatedAt: string;
  lastActivityAt: string;
  tokenTotal: number;
  costUsdTotal: number;
}

export interface ChatSessionBindingRecord {
  sessionId: string;
  transport: ChatBindingTransport;
  connectionId?: string;
  target?: string;
  writable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAttachmentRecord {
  attachmentId: string;
  sessionId: string;
  workspaceId?: string;
  projectId?: string;
  fileName: string;
  mimeType: string;
  mediaType?: ChatAttachmentMediaType;
  sizeBytes: number;
  sha256: string;
  storageRelPath: string;
  extractStatus: "ready" | "unsupported" | "failed";
  extractPreview?: string;
  thumbnailRelPath?: string;
  ocrText?: string;
  transcriptText?: string;
  analysisStatus?: "queued" | "running" | "pending" | "ready" | "failed" | "unsupported";
  createdAt: string;
}

export interface ChatMessageRecord {
  messageId: string;
  sessionId: string;
  role: ChatMessageRole;
  actorType: "user" | "agent" | "system";
  actorId: string;
  content: string;
  parts?: ChatInputPart[];
  timestamp: string;
  tokenInput?: number;
  tokenOutput?: number;
  costUsd?: number;
  attachments?: Array<{
    attachmentId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

export interface ChatSessionPrefsRecord {
  sessionId: string;
  mode: ChatMode;
  planningMode: ChatPlanningMode;
  providerId?: string;
  model?: string;
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
  toolAutonomy: "safe_auto" | "manual";
  visionFallbackModel?: string;
  orchestrationEnabled: boolean;
  orchestrationIntensity: ChatOrchestrationIntensity;
  orchestrationVisibility: ChatOrchestrationVisibility;
  orchestrationProviderPreference: ChatOrchestrationProviderPreference;
  orchestrationReviewDepth: ChatOrchestrationReviewDepth;
  orchestrationParallelism: ChatOrchestrationParallelism;
  codeAutoApply: ChatCodeAutoApplyPosture;
  proactiveMode?: ChatProactiveMode;
  autonomyBudget?: ChatAutonomyBudget;
  retrievalMode?: ChatRetrievalMode;
  reflectionMode?: ChatReflectionMode;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAutonomyBudget {
  maxActionsPerHour: number;
  maxActionsPerTurn: number;
  cooldownSeconds: number;
}

export interface ChatSessionPrefsPatch {
  mode?: ChatMode;
  planningMode?: ChatPlanningMode;
  providerId?: string;
  model?: string;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  toolAutonomy?: "safe_auto" | "manual";
  visionFallbackModel?: string;
  orchestrationEnabled?: boolean;
  orchestrationIntensity?: ChatOrchestrationIntensity;
  orchestrationVisibility?: ChatOrchestrationVisibility;
  orchestrationProviderPreference?: ChatOrchestrationProviderPreference;
  orchestrationReviewDepth?: ChatOrchestrationReviewDepth;
  orchestrationParallelism?: ChatOrchestrationParallelism;
  codeAutoApply?: ChatCodeAutoApplyPosture;
  proactiveMode?: ChatProactiveMode;
  autonomyBudget?: Partial<ChatAutonomyBudget>;
  retrievalMode?: ChatRetrievalMode;
  reflectionMode?: ChatReflectionMode;
}

export interface ChatModePresetRecord {
  mode: ChatMode;
  label: string;
  summary: string;
  teamBehavior: ChatModeTeamBehavior;
  teamBehaviorLabel: string;
  teamBehaviorSummary: string;
  growthPolicyLabel: string;
  growthPolicySummary: string;
  allowsDynamicTeamGrowth: boolean;
  defaultPrefs: Pick<
    ChatSessionPrefsPatch,
    | "planningMode"
    | "webMode"
    | "thinkingLevel"
    | "toolAutonomy"
    | "orchestrationEnabled"
    | "orchestrationIntensity"
    | "orchestrationVisibility"
    | "orchestrationProviderPreference"
    | "orchestrationReviewDepth"
    | "orchestrationParallelism"
    | "codeAutoApply"
  >;
  requiresProjectBindingForExecution?: boolean;
}

export const CHAT_MODE_PRESETS = {
  chat: {
    mode: "chat",
    label: "Chat",
    summary: "Fast conversation with lightweight orchestration and compact trace defaults.",
    teamBehavior: "single_lead",
    teamBehaviorLabel: "Single lead",
    teamBehaviorSummary: "Chat stays single-assistant by default and keeps orchestration low-friction.",
    growthPolicyLabel: "No silent team growth",
    growthPolicySummary: "Chat may suggest delegation or escalation, but it does not silently add specialists on its own.",
    allowsDynamicTeamGrowth: false,
    defaultPrefs: {
      planningMode: "off",
      webMode: "auto",
      thinkingLevel: "standard",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: true,
      orchestrationIntensity: "minimal",
      orchestrationVisibility: "summarized",
      orchestrationProviderPreference: "speed",
      orchestrationReviewDepth: "off",
      orchestrationParallelism: "auto",
      codeAutoApply: "manual",
    },
  },
  cowork: {
    mode: "cowork",
    label: "Cowork",
    summary: "Guided multi-step execution with visible orchestration, checkpoints, and collaboration controls.",
    teamBehavior: "guided_swarm",
    teamBehaviorLabel: "Guided swarm",
    teamBehaviorSummary: "Cowork keeps one visible lead agent and adds specialists only through explicit, traceable workflow rules.",
    growthPolicyLabel: "Visible capped growth",
    growthPolicySummary: "Specialist expansion is allowed here, but every growth step must stay attributable, capped, and legible in the run trace.",
    allowsDynamicTeamGrowth: true,
    defaultPrefs: {
      planningMode: "off",
      webMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: true,
      orchestrationIntensity: "balanced",
      orchestrationVisibility: "expandable",
      orchestrationProviderPreference: "balanced",
      orchestrationReviewDepth: "standard",
      orchestrationParallelism: "parallel",
      codeAutoApply: "manual",
    },
  },
  code: {
    mode: "code",
    label: "Code",
    summary: "Project-bound implementation and review with stricter defaults for quality, visibility, and apply posture.",
    teamBehavior: "constrained_squad",
    teamBehaviorLabel: "Constrained squad",
    teamBehaviorSummary: "Code stays project-bound and favors tight specialist splits such as implement, review, and test.",
    growthPolicyLabel: "Project-bound specialist growth",
    growthPolicySummary: "Specialist expansion is allowed only inside tighter project and execution rules than Cowork.",
    allowsDynamicTeamGrowth: true,
    defaultPrefs: {
      planningMode: "off",
      webMode: "auto",
      thinkingLevel: "extended",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: true,
      orchestrationIntensity: "balanced",
      orchestrationVisibility: "expandable",
      orchestrationProviderPreference: "quality",
      orchestrationReviewDepth: "strict",
      orchestrationParallelism: "auto",
      codeAutoApply: "manual",
    },
    requiresProjectBindingForExecution: true,
  },
} satisfies Record<ChatMode, ChatModePresetRecord>;

export function getChatModePreset(mode: ChatMode): ChatModePresetRecord {
  return CHAT_MODE_PRESETS[mode];
}

export function buildChatModePrefsPatch(mode: ChatMode): ChatSessionPrefsPatch {
  return {
    mode,
    ...getChatModePreset(mode).defaultPrefs,
  };
}

export function applyChatModePresetToPatch(input: ChatSessionPrefsPatch): ChatSessionPrefsPatch {
  if (!input.mode) {
    return input;
  }
  return {
    ...buildChatModePrefsPatch(input.mode),
    ...input,
  };
}

export function chatModeRequiresProjectBinding(mode: ChatMode): boolean {
  return getChatModePreset(mode).requiresProjectBindingForExecution === true;
}

export interface ChatCitationRecord {
  citationId: string;
  title?: string;
  url: string;
  snippet?: string;
  sourceType?: "web" | "file" | "tool";
}

export interface ChatToolRunRecord {
  toolRunId: string;
  turnId: string;
  sessionId: string;
  toolName: string;
  status: "started" | "executed" | "blocked" | "approval_required" | "failed";
  approvalId?: string;
  startedAt: string;
  finishedAt?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  failureGuidance?: string;
}

export type ChatTurnLifecycleStatus =
  | "queued"
  | "running"
  | "waiting_for_tool"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ChatTurnFailureClass =
  | "provider_timeout"
  | "network_interrupted"
  | "tool_blocked"
  | "tool_failed"
  | "auth_required"
  | "budget_exceeded"
  | "approval_required"
  | "unknown";

export type ChatTurnCompletionStatus = "complete" | "truncated" | "interrupted" | "backgrounded";

export type ChatTurnRecoveryAction =
  | "retry"
  | "retry_narrower"
  | "continue_from_partial"
  | "reconnect_auth"
  | "approve_pending_step"
  | "switch_to_deep_mode"
  | "check_gateway_connection";

export interface ChatTurnFailureRecord {
  failureClass: ChatTurnFailureClass;
  message: string;
  retryable?: boolean;
  recommendedAction?: ChatTurnRecoveryAction;
}

export interface ChatTurnCompletionRecord {
  finishReason?: string;
  status: ChatTurnCompletionStatus;
  repaired: boolean;
}

export interface ChatTurnDurableRecord {
  runId?: string;
  status?: DurableRunStatus | "backgrounded";
  checkpointKind?: string;
}

export function getChatTurnRecoveryAction(failureClass: ChatTurnFailureClass): ChatTurnRecoveryAction {
  switch (failureClass) {
    case "provider_timeout":
      return "retry";
    case "network_interrupted":
      return "check_gateway_connection";
    case "tool_blocked":
    case "tool_failed":
      return "retry_narrower";
    case "auth_required":
      return "reconnect_auth";
    case "budget_exceeded":
      return "switch_to_deep_mode";
    case "approval_required":
      return "approve_pending_step";
    default:
      return "retry";
  }
}

export function getChatTurnRecoveryActionLabel(action: ChatTurnRecoveryAction): string {
  switch (action) {
    case "retry":
      return "Retry the turn";
    case "retry_narrower":
      return "Retry with a narrower request";
    case "continue_from_partial":
      return "Continue from the strongest leads";
    case "reconnect_auth":
      return "Reconnect auth";
    case "approve_pending_step":
      return "Approve the pending step";
    case "switch_to_deep_mode":
      return "Switch to Deep mode";
    case "check_gateway_connection":
      return "Check the gateway connection";
  }
}

export function getChatTurnRecoveryActionSummary(action: ChatTurnRecoveryAction): string {
  switch (action) {
    case "retry":
      return "Run the same turn again once. If it repeats, narrow the request before retrying.";
    case "retry_narrower":
      return "Ask for a smaller slice of the task so the next pass can finish cleanly.";
    case "continue_from_partial":
      return "Ask GoatCitadel to continue from the strongest leads or partial results it already gathered.";
    case "reconnect_auth":
      return "Reconnect the provider or integration auth, then resend the turn.";
    case "approve_pending_step":
      return "Review the pending approval so the turn can continue.";
    case "switch_to_deep_mode":
      return "Switch Web to Deep and resend if you want a slower, more exhaustive pass.";
    case "check_gateway_connection":
      return "Check the gateway or network connection, then retry the turn.";
  }
}

export const CHAT_TURN_ACTIVE_STATUSES = [
  "queued",
  "running",
  "waiting_for_tool",
  "waiting_for_approval",
] as const satisfies ChatTurnLifecycleStatus[];

export const CHAT_TURN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies ChatTurnLifecycleStatus[];

export function isChatTurnActiveStatus(status: ChatTurnLifecycleStatus): boolean {
  return (CHAT_TURN_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isChatTurnTerminalStatus(status: ChatTurnLifecycleStatus): boolean {
  return (CHAT_TURN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export interface ChatCapabilityUpgradeSuggestion {
  kind: "existing_but_disabled" | "skill_import" | "mcp_template";
  title: string;
  summary: string;
  reason: string;
  sourceProvider?: SkillSourceProvider | "mcp_template";
  sourceRef?: string;
  riskLevel?: "low" | "medium" | "high";
  recommendedAction: "enable_skill" | "install_skill_disabled" | "install_skill_enable" | "add_mcp_template" | "switch_tool_profile";
  candidateId?: string;
  requiresUserApproval: true;
}

export interface ChatOrchestrationProviderSelection {
  role: string;
  providerId?: string;
  model?: string;
}

export interface ChatOrchestrationSpecialistSelection {
  candidateId: string;
  title: string;
  role: string;
  baseRole: string;
  summary: string;
  matchReason: string;
  routingMode: ChatSpecialistCandidateRoutingMode;
}

export interface ChatOrchestrationRouteDecision {
  modePolicy: ChatMode;
  workflowTemplate: string;
  hidden: boolean;
  visibility: ChatOrchestrationVisibility;
  intensity: ChatOrchestrationIntensity;
  providerPreference: ChatOrchestrationProviderPreference;
  reviewDepth: ChatOrchestrationReviewDepth;
  parallelism: ChatOrchestrationParallelism;
  selectedRoles: string[];
  selectedProviders: ChatOrchestrationProviderSelection[];
  specialistCandidates?: ChatOrchestrationSpecialistSelection[];
  triggerReason: string;
}

export interface ChatOrchestrationStepSummary {
  stepId: string;
  role: string;
  index: number;
  status: ChatDelegationStepStatus;
  specialistCandidateId?: string;
  specialistTitle?: string;
  specialistRole?: string;
  providerId?: string;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
}

export interface ChatOrchestrationSummary {
  runId: string;
  objective: string;
  workflowTemplate: string;
  status: ChatDelegationRunStatus;
  modePolicy: ChatMode;
  visibility: ChatOrchestrationVisibility;
  finalSummary?: string;
  routeDecision: ChatOrchestrationRouteDecision;
  steps: ChatOrchestrationStepSummary[];
}

export type ChatExecutionPlanStatus =
  | "drafted"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ChatExecutionPlanStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ChatExecutionPlanSource =
  | "planner"
  | "workflow_template"
  | "planner_with_template_fallback";

export interface ChatExecutionPlanStepRecord {
  stepId: string;
  index: number;
  objective: string;
  successCriteria?: string;
  suggestedTools?: string[];
  expectedOutput?: string;
  parallelizable: boolean;
  dependsOnStepIds?: string[];
  delegatedRole?: string;
  status: ChatExecutionPlanStepStatus;
  summary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  childRunId?: string;
  childSessionId?: string;
  childTurnId?: string;
}

export interface ChatExecutionPlanRecord {
  planId: string;
  sessionId: string;
  turnId: string;
  mode: ChatMode;
  planningMode: ChatPlanningMode;
  status: ChatExecutionPlanStatus;
  source: ChatExecutionPlanSource;
  advisoryOnly: boolean;
  objective: string;
  summary: string;
  steps: ChatExecutionPlanStepRecord[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ChatConversationSummaryRecord {
  summaryId: string;
  sessionId: string;
  branchHeadTurnId: string;
  startTurnId: string;
  endTurnId: string;
  turnIds: string[];
  sourceHash: string;
  tokenEstimate: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatTurnTraceRecord {
  turnId: string;
  sessionId: string;
  userMessageId: string;
  parentTurnId?: string;
  branchKind: ChatTurnBranchKind;
  sourceTurnId?: string;
  assistantMessageId?: string;
  status: ChatTurnLifecycleStatus;
  failure?: ChatTurnFailureRecord;
  completion?: ChatTurnCompletionRecord;
  mode: ChatMode;
  model?: string;
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
  effectiveToolAutonomy?: "safe_auto" | "manual";
  startedAt: string;
  finishedAt?: string;
  toolRuns: ChatToolRunRecord[];
  citations: ChatCitationRecord[];
  routing: {
    usedVisionFallback?: boolean;
    effectiveProviderId?: string;
    effectiveModel?: string;
    liveDataIntent?: boolean;
    primaryProviderId?: string;
    primaryModel?: string;
    fallbackProviderId?: string;
    fallbackModel?: string;
    fallbackReason?: string;
    fallbackUsed?: boolean;
  };
  retrieval?: {
    l0Used: boolean;
    l1Used: boolean;
    l2Used: boolean;
    confidenceL0?: number;
    confidenceL1?: number;
    confidenceL2?: number;
    escalationReason?: string;
  };
  reflection?: {
    attempted: boolean;
    attemptCount: number;
    reason?: string;
    outcome?: "recovered" | "still_failed" | "not_needed";
  };
  proactive?: {
    runId?: string;
    actionCount?: number;
    mode?: ChatProactiveMode;
  };
  durable?: ChatTurnDurableRecord;
  orchestration?: ChatOrchestrationSummary;
  guidance?: {
    workspaceId: string;
    globalFilesUsed: string[];
    workspaceFilesUsed: string[];
    truncated: boolean;
  };
  executionPlanId?: string;
  executionPlan?: ChatExecutionPlanRecord;
  capabilityUpgradeSuggestions?: ChatCapabilityUpgradeSuggestion[];
  specialistCandidateSuggestions?: ChatSpecialistCandidateSuggestionRecord[];
}

export interface ChatDelegationStepRecord {
  stepId: string;
  runId: string;
  role: string;
  status: ChatDelegationStepStatus;
  index: number;
  providerId?: string;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  output?: string;
  error?: string;
  failureGuidance?: string;
  childSessionId?: string;
  childTurnId?: string;
  citations?: ChatCitationRecord[];
}

export interface ChatDelegationRunRecord {
  runId: string;
  sessionId: string;
  taskId: string;
  objective: string;
  roles: string[];
  mode: ChatDelegationMode;
  providerId?: string;
  model?: string;
  status: ChatDelegationRunStatus;
  visibility?: ChatOrchestrationVisibility;
  workflowTemplate?: string;
  executionPlanId?: string;
  routeDecision?: ChatOrchestrationRouteDecision;
  finalSummary?: string;
  startedAt: string;
  finishedAt?: string;
  stitchedOutput?: string;
  citations: ChatCitationRecord[];
  trace?: ChatTurnTraceRecord["routing"];
}

export interface ChatDelegateRequest {
  objective: string;
  roles: string[];
  mode?: ChatDelegationMode;
  providerId?: string;
  model?: string;
}

export interface ChatDelegateResponse {
  runId: string;
  taskId: string;
  executionPlanId?: string;
  steps: ChatDelegationStepRecord[];
  stitchedOutput: string;
  citations: ChatCitationRecord[];
  trace?: ChatTurnTraceRecord["routing"];
}

export interface ChatDelegationSuggestionRecord {
  suggestionId: string;
  sessionId: string;
  objective: string;
  roles: string[];
  mode: ChatDelegationMode;
  confidence: number;
  reason: string;
  source: "manual" | "heuristic" | "proactive";
  createdAt: string;
}

export type ChatSpecialistCandidateStatus =
  | "suggested"
  | "drafted"
  | "disabled"
  | "approved"
  | "active"
  | "retired";

export type ChatSpecialistCandidateRoutingMode =
  | "disabled"
  | "manual_only"
  | "strong_match_only";

export type ChatSpecialistCandidateSource =
  | "manual"
  | "runtime_gap"
  | "replay";

export type ChatSpecialistCandidateEvidenceKind =
  | "role_gap"
  | "tool_gap"
  | "skill_gap"
  | "successful_workaround";

export interface ChatSpecialistCandidateEvidenceRecord {
  evidenceId: string;
  kind: ChatSpecialistCandidateEvidenceKind;
  summary: string;
  turnId?: string;
  runId?: string;
  toolName?: string;
  skillRef?: string;
  confidence?: number;
}

export interface ChatSpecialistCandidateRoutingHints {
  preferredModes: ChatMode[];
  objectiveKeywords?: string[];
  requiresProjectBinding?: boolean;
  maxInvocationsPerRun?: number;
}

export interface ChatSpecialistCandidateRecord {
  candidateId: string;
  workspaceId?: string;
  sessionId: string;
  leadTurnId?: string;
  leadRunId?: string;
  title: string;
  role: string;
  summary: string;
  reason: string;
  source: ChatSpecialistCandidateSource;
  status: ChatSpecialistCandidateStatus;
  routingMode: ChatSpecialistCandidateRoutingMode;
  confidence: number;
  requiresApproval: boolean;
  suggestedTools?: string[];
  suggestedSkills?: string[];
  routingHints: ChatSpecialistCandidateRoutingHints;
  evidence: ChatSpecialistCandidateEvidenceRecord[];
  createdAt: string;
  updatedAt: string;
  activatedAt?: string;
  retiredAt?: string;
}

export interface ChatSpecialistCandidateSuggestionRecord {
  candidateId: string;
  title: string;
  role: string;
  summary: string;
  reason: string;
  source: ChatSpecialistCandidateSource;
  confidence: number;
  suggestedStatus: Extract<ChatSpecialistCandidateStatus, "suggested" | "drafted" | "disabled">;
  suggestedRoutingMode: ChatSpecialistCandidateRoutingMode;
  requiresApproval: true;
  suggestedTools?: string[];
  suggestedSkills?: string[];
  routingHints: ChatSpecialistCandidateRoutingHints;
  evidence: ChatSpecialistCandidateEvidenceRecord[];
}

export interface ChatSpecialistCandidateCreateInput {
  leadTurnId?: string;
  leadRunId?: string;
  title: string;
  role: string;
  summary: string;
  reason: string;
  source: ChatSpecialistCandidateSource;
  status?: ChatSpecialistCandidateStatus;
  routingMode?: ChatSpecialistCandidateRoutingMode;
  confidence: number;
  requiresApproval?: boolean;
  suggestedTools?: string[];
  suggestedSkills?: string[];
  routingHints: ChatSpecialistCandidateRoutingHints;
  evidence: ChatSpecialistCandidateEvidenceRecord[];
}

export interface ChatSpecialistCandidatePatchInput {
  title?: string;
  summary?: string;
  reason?: string;
  status?: ChatSpecialistCandidateStatus;
  routingMode?: ChatSpecialistCandidateRoutingMode;
  confidence?: number;
  suggestedTools?: string[];
  suggestedSkills?: string[];
  routingHints?: ChatSpecialistCandidateRoutingHints;
  evidence?: ChatSpecialistCandidateEvidenceRecord[];
}

export interface ChatDelegateSuggestRequest {
  objective?: string;
  roles?: string[];
  mode?: ChatDelegationMode;
}

export interface ChatDelegateSuggestResponse {
  suggestion: ChatDelegationSuggestionRecord;
}

export function chatModeAllowsDynamicTeamGrowth(mode: ChatMode): boolean {
  return getChatModePreset(mode).allowsDynamicTeamGrowth;
}

export interface ChatDelegateAcceptRequest {
  suggestionId?: string;
  objective: string;
  roles: string[];
  mode?: ChatDelegationMode;
  providerId?: string;
  model?: string;
}

export interface ChatSendMessageRequest {
  content: string;
  parts?: ChatInputPart[];
  providerId?: string;
  model?: string;
  useMemory?: boolean;
  attachments?: string[];
  mode?: ChatMode;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  commandText?: string;
  prefsOverride?: ChatSessionPrefsPatch;
}

export interface ChatSendMessageResponse {
  sessionId: string;
  userMessage: ChatMessageRecord;
  assistantMessage?: ChatMessageRecord;
  transport: ChatBindingTransport;
  model?: string;
  turnId?: string;
  trace?: ChatTurnTraceRecord;
  citations?: ChatCitationRecord[];
  routing?: ChatTurnTraceRecord["routing"];
}

export interface ChatCancelTurnResponse {
  sessionId: string;
  turnId: string;
  trace: ChatTurnTraceRecord;
  cancelled: boolean;
}

export interface ChatThreadTurnBranchRecord {
  siblingTurnIds: string[];
  activeSiblingIndex: number;
  siblingCount: number;
  isSelectedPath: boolean;
  newestLeafTurnId: string;
}

export interface ChatThreadTurnRecord {
  turnId: string;
  parentTurnId?: string;
  branchKind: ChatTurnBranchKind;
  sourceTurnId?: string;
  userMessage: ChatMessageRecord;
  assistantMessage?: ChatMessageRecord;
  trace: ChatTurnTraceRecord;
  toolRuns: ChatToolRunRecord[];
  citations: ChatCitationRecord[];
  branch: ChatThreadTurnBranchRecord;
}

export interface ChatThreadResponse {
  sessionId: string;
  activeLeafTurnId?: string;
  selectedTurnId?: string;
  turns: ChatThreadTurnRecord[];
}

export interface ChatStreamUsageRecord {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface ChatStreamApprovalRecord {
  approvalId: string;
  toolName?: string;
  reason?: string;
}

export interface ChatStreamChunkBase {
  sessionId: string;
  eventId: string;
  sequence: number;
  runId?: string;
}

export interface ChatStreamMessageStartChunk extends ChatStreamChunkBase {
  type: "message_start";
  turnId: string;
  messageId: string;
  parentTurnId?: string;
  branchKind: ChatTurnBranchKind;
  sourceTurnId?: string;
}

export interface ChatStreamDeltaChunk extends ChatStreamChunkBase {
  type: "delta";
  turnId: string;
  messageId?: string;
  delta: string;
}

export interface ChatStreamUsageChunk extends ChatStreamChunkBase {
  type: "usage";
  turnId: string;
  messageId?: string;
  usage: ChatStreamUsageRecord;
}

export interface ChatStreamMessageDoneChunk extends ChatStreamChunkBase {
  type: "message_done";
  turnId: string;
  messageId: string;
  content: string;
}

export interface ChatStreamToolStartChunk extends ChatStreamChunkBase {
  type: "tool_start";
  turnId: string;
  toolRun: ChatToolRunRecord;
}

export interface ChatStreamToolResultChunk extends ChatStreamChunkBase {
  type: "tool_result";
  turnId: string;
  toolRun: ChatToolRunRecord;
}

export interface ChatStreamApprovalRequiredChunk extends ChatStreamChunkBase {
  type: "approval_required";
  turnId: string;
  approval: ChatStreamApprovalRecord;
}

export interface ChatStreamTraceUpdateChunk extends ChatStreamChunkBase {
  type: "trace_update";
  turnId: string;
  trace: ChatTurnTraceRecord;
}

export interface ChatStreamCitationChunk extends ChatStreamChunkBase {
  type: "citation";
  turnId: string;
  citation: ChatCitationRecord;
}

export interface ChatStreamCapabilitySuggestionChunk extends ChatStreamChunkBase {
  type: "capability_upgrade_suggestion";
  turnId: string;
  capabilityUpgradeSuggestions: ChatCapabilityUpgradeSuggestion[];
}

export interface ChatStreamErrorChunk extends ChatStreamChunkBase {
  type: "error";
  // Route-level stream failures can end after an error chunk without a matching done chunk.
  turnId?: string;
  error: string;
}

export interface ChatStreamDoneChunk extends ChatStreamChunkBase {
  type: "done";
  turnId: string;
  messageId: string;
}

export type ChatStreamChunk =
  | ChatStreamMessageStartChunk
  | ChatStreamDeltaChunk
  | ChatStreamUsageChunk
  | ChatStreamMessageDoneChunk
  | ChatStreamToolStartChunk
  | ChatStreamToolResultChunk
  | ChatStreamApprovalRequiredChunk
  | ChatStreamTraceUpdateChunk
  | ChatStreamCitationChunk
  | ChatStreamCapabilitySuggestionChunk
  | ChatStreamErrorChunk
  | ChatStreamDoneChunk;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ChatStreamChunkDraft = DistributiveOmit<ChatStreamChunk, "eventId" | "sequence" | "runId">;

/* eslint-disable max-lines */
import type { DurableRunStatus } from "./durable.js";
import type { ThreadKnowledgeCitationRecord } from "./knowledge.js";
import type { SkillSourceProvider } from "./skills.js";

export type ChatProjectLifecycleStatus = "active" | "archived";
export type ChatSessionScope = "mission" | "external";
export type ChatSessionLifecycleStatus = "active" | "archived";
export type ChatSessionOrigin = "operator" | "prompt_pack" | "system";
export type ChatBindingTransport = "llm" | "integration";
export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatAttachmentMediaType = "text" | "image" | "audio" | "video" | "binary";
export type ChatMode = "chat" | "cowork" | "code";
export type ChatModeTeamBehavior = "single_lead" | "guided_swarm" | "constrained_squad";
export type ChatWebMode = "auto" | "off" | "quick" | "deep";
export type ChatMemoryMode = "auto" | "on" | "off";
export type ChatThinkingLevel = "off" | "minimal" | "standard" | "extended" | "deep";
export type ChatSpeedMode = "standard" | "fast";
export type ChatSubagentPolicy = "off" | "ask_when_useful" | "auto_when_useful";
export type ChatNormalizationProfile = "live" | "prompt_pack_harness";
export type ChatProactiveMode = "off" | "suggest" | "auto_safe" | "auto_full";
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
export type ChatDelegationStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled";
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

export type ChatProjectImportSource = "local_folder" | "github_repo";

export interface ChatProjectImportInput {
  workspaceId?: string;
  name?: string;
  sourceType: ChatProjectImportSource;
  sourcePath?: string;
  repoUrl?: string;
  ref?: string;
}

export interface ChatProjectImportResult {
  project: ChatProjectRecord;
  sourceType: ChatProjectImportSource;
  materializedPath: string;
  repoReady: boolean;
  imported: boolean;
}

export interface ChatFolderRecord {
  folderId: string;
  workspaceId?: string;
  name: string;
  sessionCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatSessionSearchHitRecord {
  messageId: string;
  turnId?: string;
  excerpt: string;
  score: number;
  matchedText?: string;
  timestamp?: string;
}

export type ChatSurfaceHandoffSource = ChatMode;

export interface ChatSessionHandoffRecord {
  sourceSurface: ChatSurfaceHandoffSource;
  originTurnId?: string;
  originArtifactId?: string;
  createdAt: string;
}

export interface ChatSessionDelegationParentRecord {
  parentSessionId: string;
  runId: string;
  stepId: string;
  role: string;
  label?: string;
  index: number;
}

export type ChatGeneratedArtifactKind = "markdown" | "html" | "mermaid" | "code" | "text";

export type ChatGeneratedArtifactSourceSurface = "chat" | "cowork" | "code";

export interface ChatGeneratedArtifactReference {
  artifactId: string;
  kind: ChatGeneratedArtifactKind;
  title: string;
  sourceSurface: ChatGeneratedArtifactSourceSurface;
  version: number;
  supersedesArtifactId?: string;
  turnId?: string;
  language?: string;
  providerId?: string;
  model?: string;
  sourceBlockIndex?: number;
  contentHash?: string;
  createdAt: string;
}

export interface ChatGeneratedArtifactRecord {
  artifactId: string;
  sessionId: string;
  workspaceId?: string;
  turnId: string;
  title: string;
  kind: ChatGeneratedArtifactKind;
  content: string;
  language?: string;
  sourceSurface: ChatGeneratedArtifactSourceSurface;
  version: number;
  supersedesArtifactId?: string;
  providerId?: string;
  model?: string;
  sourceBlockIndex?: number;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionRecord {
  sessionId: string;
  sessionKey: string;
  workspaceId?: string;
  scope: ChatSessionScope;
  mode?: ChatMode;
  origin?: ChatSessionOrigin;
  includeInHistory: boolean;
  title?: string;
  pinned: boolean;
  lifecycleStatus: ChatSessionLifecycleStatus;
  archivedAt?: string;
  folderId?: string;
  folderName?: string;
  tags?: string[];
  projectId?: string;
  projectName?: string;
  searchHits?: ChatSessionSearchHitRecord[];
  lastHandoff?: ChatSessionHandoffRecord;
  delegationParent?: ChatSessionDelegationParentRecord;
  generatedArtifacts?: ChatGeneratedArtifactReference[];
  channel: string;
  account: string;
  updatedAt: string;
  lastActivityAt: string;
  tokenTotal: number;
  costUsdTotal: number;
  pinnedGoal?: string;
  goalTurnBudget?: number;
  goalTurnsUsed?: number;
  goalSetAt?: string;
}

export interface ChatSessionCreateInput {
  workspaceId?: string;
  title?: string;
  folderId?: string;
  folderName?: string;
  tags?: string[];
  projectId?: string;
  mode?: ChatMode;
  origin?: ChatSessionOrigin;
  includeInHistory?: boolean;
}

export interface ChatSessionListQuery {
  scope?: ChatSessionScope | "all";
  workspaceId?: string;
  projectId?: string;
  folderId?: string;
  tag?: string;
  q?: string;
  view?: ChatSessionLifecycleStatus | "all";
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
}

export interface ChatSessionBulkArchiveInput {
  workspaceId?: string;
  scope?: ChatSessionScope | "all";
  includeHidden?: boolean;
}

export interface ChatSessionBulkArchiveFailure {
  sessionId: string;
  error: string;
}

export interface ChatSessionBulkArchiveResult {
  workspaceId: string;
  scope: ChatSessionScope | "all";
  attemptedCount: number;
  archivedCount: number;
  skippedCount: number;
  failedCount: number;
  archivedSessionIds: string[];
  failures: ChatSessionBulkArchiveFailure[];
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

export type ChatSessionWorkbenchWorktreeStatus = "uninitialized" | "ready" | "missing" | "blocked";

export type ChatSessionWorkbenchValidationStatus = "idle" | "pending" | "passed" | "failed";

export interface ChatSessionWorkbenchValidationResult {
  status: "passed" | "failed" | "skipped" | "timed_out";
  commandLabel?: string;
  durationMs?: number;
  changedFiles: string[];
  stdoutPreview?: string;
  stderrPreview?: string;
  reason?: string;
}

export interface ChatSessionWorkbenchRecord {
  sessionId: string;
  projectId?: string;
  baseRef?: string;
  worktreePath?: string;
  worktreeStatus: ChatSessionWorkbenchWorktreeStatus;
  activeFilePath?: string;
  diffArtifactId?: string;
  outputArtifactId?: string;
  validationStatus: ChatSessionWorkbenchValidationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionWorkbenchTreeEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  changed: boolean;
  depth: number;
}

export interface ChatSessionWorkbenchTreeResponse {
  state: ChatSessionWorkbenchRecord;
  rootPath: string;
  changedFiles: string[];
  items: ChatSessionWorkbenchTreeEntry[];
}

export interface ChatSessionWorkbenchFileResponse {
  state: ChatSessionWorkbenchRecord;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  contentType: string;
  language: string;
  changed: boolean;
  content: string;
}

export interface ChatSessionWorkbenchSaveFileRequest {
  path: string;
  content: string;
}

export interface ChatSessionWorkbenchFileDiffResponse {
  state: ChatSessionWorkbenchRecord;
  path: string;
  language: string;
  changed: boolean;
  originalContent: string;
  modifiedContent: string;
}

export interface ChatSessionWorkbenchDiffSummary {
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface ChatSessionWorkbenchDiffResponse {
  state: ChatSessionWorkbenchRecord;
  scopePath: string;
  changedFiles: string[];
  summary: ChatSessionWorkbenchDiffSummary;
  diff: string;
}

export interface ChatSessionWorkbenchCommandRunRequest {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface ChatSessionWorkbenchCommandRunResponse {
  state: ChatSessionWorkbenchRecord;
  run: import("./agentic-runtime.js").AgenticCommandRunRecord;
  output: ChatSessionWorkbenchOutputResponse;
}

export interface ChatSessionWorkbenchPatchApplyRequest {
  patch: string;
  checkOnly?: boolean;
}

export interface ChatSessionWorkbenchPatchApplyResponse {
  state: ChatSessionWorkbenchRecord;
  applied: boolean;
  checkOnly: boolean;
  changedFiles: string[];
  output: ChatSessionWorkbenchOutputResponse;
}

export interface ChatSessionWorkbenchPatchExportResponse {
  state: ChatSessionWorkbenchRecord;
  patch: string;
  changedFiles: string[];
  summary: ChatSessionWorkbenchDiffSummary;
  generatedAt: string;
}

export interface ChatSessionWorkbenchRevertFileRequest {
  path: string;
}

export interface ChatSessionWorkbenchRevertResponse {
  state: ChatSessionWorkbenchRecord;
  revertedFiles: string[];
  changedFiles: string[];
  output: ChatSessionWorkbenchOutputResponse;
}

export interface ChatSessionWorkbenchOutputRunSummary {
  runId: string;
  turnId?: string;
  status: import("./capabilities.js").CodeModeRunRecord["status"];
  language: import("./capabilities.js").CodeModeRunRecord["language"];
  requestedOutputIntent?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  createdAt: string;
}

export interface ChatSessionWorkbenchOutputResponse {
  state: ChatSessionWorkbenchRecord;
  helperRuns: ChatSessionWorkbenchOutputRunSummary[];
  output: string;
  validation?: ChatSessionWorkbenchValidationResult;
  lastUpdatedAt?: string;
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
  /**
   * Set true when this user message was injected into an active run via /steer.
   * Surfaces on transcript entries so operators can audit which prompts steered.
   */
  steered?: boolean;
  /**
   * Links the message to a parent delegation step. Set on the [Subagent Task]
   * first message of a child session so the lineage is queryable from the message.
   */
  parentDelegationStepId?: string;
}

export interface ChatSessionPrefsRecord {
  sessionId: string;
  mode: ChatMode;
  planningMode: ChatPlanningMode;
  providerId?: string;
  model?: string;
  imageProviderId?: string;
  imageModel?: string;
  webMode: ChatWebMode;
  memoryMode: ChatMemoryMode;
  thinkingLevel: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
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
  imageProviderId?: string;
  imageModel?: string;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
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
    | "speedMode"
    | "subagentPolicy"
    | "toolAutonomy"
    | "orchestrationEnabled"
    | "orchestrationIntensity"
    | "orchestrationVisibility"
    | "orchestrationProviderPreference"
    | "orchestrationReviewDepth"
    | "orchestrationParallelism"
    | "codeAutoApply"
    | "proactiveMode"
    | "autonomyBudget"
    | "retrievalMode"
    | "reflectionMode"
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
    growthPolicySummary:
      "Chat may suggest delegation or escalation, but it does not silently add specialists on its own.",
    allowsDynamicTeamGrowth: false,
    defaultPrefs: {
      planningMode: "off",
      webMode: "auto",
      thinkingLevel: "standard",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: true,
      orchestrationIntensity: "minimal",
      orchestrationVisibility: "summarized",
      orchestrationProviderPreference: "speed",
      orchestrationReviewDepth: "off",
      orchestrationParallelism: "auto",
      codeAutoApply: "manual",
      proactiveMode: "auto_safe",
      autonomyBudget: {
        maxActionsPerHour: 6,
        maxActionsPerTurn: 2,
        cooldownSeconds: 60,
      },
      retrievalMode: "standard",
      reflectionMode: "off",
    },
  },
  cowork: {
    mode: "cowork",
    label: "Cowork",
    summary: "Guided multi-step execution with visible orchestration, checkpoints, and collaboration controls.",
    teamBehavior: "guided_swarm",
    teamBehaviorLabel: "Guided swarm",
    teamBehaviorSummary:
      "Cowork keeps one visible lead agent and adds specialists only through explicit, traceable workflow rules.",
    growthPolicyLabel: "Visible capped growth",
    growthPolicySummary:
      "Specialist expansion is allowed here, but every growth step must stay attributable, capped, and legible in the run trace.",
    allowsDynamicTeamGrowth: true,
    defaultPrefs: {
      planningMode: "off",
      webMode: "auto",
      thinkingLevel: "extended",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: true,
      orchestrationIntensity: "balanced",
      orchestrationVisibility: "expandable",
      orchestrationProviderPreference: "balanced",
      orchestrationReviewDepth: "standard",
      orchestrationParallelism: "parallel",
      codeAutoApply: "manual",
      proactiveMode: "auto_full",
      autonomyBudget: {
        maxActionsPerHour: 12,
        maxActionsPerTurn: 4,
        cooldownSeconds: 30,
      },
      retrievalMode: "layered",
      reflectionMode: "on",
    },
  },
  code: {
    mode: "code",
    label: "Code",
    summary:
      "Project-bound implementation and review with stricter defaults for quality, visibility, and apply posture.",
    teamBehavior: "constrained_squad",
    teamBehaviorLabel: "Constrained squad",
    teamBehaviorSummary:
      "Code stays project-bound and favors tight specialist splits such as implement, review, and test.",
    growthPolicyLabel: "Project-bound specialist growth",
    growthPolicySummary: "Specialist expansion is allowed only inside tighter project and execution rules than Cowork.",
    allowsDynamicTeamGrowth: true,
    defaultPrefs: {
      planningMode: "off",
      webMode: "auto",
      thinkingLevel: "extended",
      speedMode: "standard",
      subagentPolicy: "ask_when_useful",
      toolAutonomy: "safe_auto",
      orchestrationEnabled: true,
      orchestrationIntensity: "balanced",
      orchestrationVisibility: "expandable",
      orchestrationProviderPreference: "quality",
      orchestrationReviewDepth: "strict",
      orchestrationParallelism: "auto",
      codeAutoApply: "manual",
      proactiveMode: "auto_full",
      autonomyBudget: {
        maxActionsPerHour: 12,
        maxActionsPerTurn: 4,
        cooldownSeconds: 30,
      },
      retrievalMode: "layered",
      reflectionMode: "on",
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
  knowledge?: ThreadKnowledgeCitationRecord;
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
  reused?: boolean;
  reusedFromToolRunId?: string;
  reuseReason?: string;
  error?: string;
  failureGuidance?: string;
}

export type ChatTurnLifecycleStatus =
  | "queued"
  | "running"
  | "waiting_for_tool"
  | "waiting_for_approval"
  | "waiting_for_user_input"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type ChatTurnFailureClass =
  | "provider_timeout"
  | "network_interrupted"
  | "tool_blocked"
  | "tool_failed"
  | "auth_required"
  | "tool_loop_guard"
  | "global_circuit_breaker"
  | "tool_run_budget_exceeded"
  | "turn_budget_exceeded"
  | "budget_exceeded"
  | "approval_required"
  | "unknown";

export type ChatTurnCompletionStatus = "complete" | "truncated" | "interrupted" | "backgrounded";

export type ChatTurnRepairKind =
  | "degraded_answer_synthesis"
  | "incomplete_truncated_completion"
  | "deterministic_empty_output_synthesis"
  | "cowork_contract_normalization"
  | "prompt_pack_harness_normalization";

export type ChatTurnRepairSource = "orchestrator" | "prompt_pack_harness" | "stream_layer";

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
  provider?: ChatProviderFailureRecord;
}

export interface ChatTurnRepairRecord {
  applied: boolean;
  kind?: ChatTurnRepairKind;
  source?: ChatTurnRepairSource;
  preRepairContent?: string;
  postRepairContent?: string;
}

export interface ChatTurnCompletionRecord {
  finishReason?: string;
  status: ChatTurnCompletionStatus;
  repaired: boolean;
  repair?: ChatTurnRepairRecord;
  usage?: ChatStreamUsageRecord;
  latencyMs?: number;
  providerCallCount?: number;
}

export type ChatUsageCostSource = "provider_reported" | "estimated" | "mixed" | "unknown";

export interface ChatProviderFailureRecord {
  code?: string;
  message?: string;
  status?: string;
  responseId?: string;
  type?: string;
}

export interface ChatTurnDurableRecord {
  runId?: string;
  status?: DurableRunStatus | "backgrounded";
  checkpointKind?: string;
  workerHealth?: import("./durable.js").DurableWorkerHealth;
  recoveryState?: import("./durable.js").DurableRecoveryState;
  recoverySummary?: string;
}

export function getChatTurnRecoveryAction(failureClass: ChatTurnFailureClass): ChatTurnRecoveryAction {
  switch (failureClass) {
    case "provider_timeout":
      return "retry";
    case "network_interrupted":
      return "check_gateway_connection";
    case "tool_blocked":
    case "tool_failed":
    case "tool_loop_guard":
    case "global_circuit_breaker":
    case "tool_run_budget_exceeded":
      return "retry_narrower";
    case "auth_required":
      return "reconnect_auth";
    case "turn_budget_exceeded":
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
  "waiting_for_user_input",
] as const satisfies ChatTurnLifecycleStatus[];

export const CHAT_TURN_TERMINAL_STATUSES = [
  "completed",
  "partial",
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
  recommendedAction:
    | "enable_skill"
    | "install_skill_disabled"
    | "install_skill_enable"
    | "add_mcp_template"
    | "switch_tool_profile";
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
  label?: string;
  index: number;
  status: ChatDelegationStepStatus;
  waitStatus?: Extract<ChatTurnLifecycleStatus, "waiting_for_tool" | "waiting_for_approval" | "waiting_for_user_input">;
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
  integritySignals?: string[];
  routeDecision: ChatOrchestrationRouteDecision;
  steps: ChatOrchestrationStepSummary[];
}

export type ChatExecutionPlanStatus =
  | "drafted"
  | "ready"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type ChatExecutionPlanStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ChatExecutionPlanSource = "planner" | "workflow_template" | "planner_with_template_fallback";

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
  durableRunId?: string;
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

export type ChatToolLoopGuardSeverity = "warning" | "critical" | "global_circuit_breaker";

export interface ChatToolLoopGuardEventRecord {
  eventId: string;
  detector: import("./policy.js").ToolLoopDetectorKind;
  severity: ChatToolLoopGuardSeverity;
  toolName?: string;
  message: string;
  repetitionCount: number;
  historySize: number;
  suppressed: boolean;
  createdAt: string;
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
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
  effectiveToolAutonomy?: "safe_auto" | "manual";
  startedAt: string;
  finishedAt?: string;
  capabilitySnapshotId?: string;
  codeModeRunId?: string;
  pendingApprovalSummary?: ChatStreamApprovalRecord;
  pendingUserInput?: ChatUserInputPromptRecord;
  toolRuns: ChatToolRunRecord[];
  citations: ChatCitationRecord[];
  routing: {
    usedVisionFallback?: boolean;
    effectiveProviderId?: string;
    effectiveModel?: string;
    effectiveApiStyle?: import("./llm.js").LlmApiStyle;
    liveDataIntent?: boolean;
    primaryProviderId?: string;
    primaryModel?: string;
    primaryApiStyle?: import("./llm.js").LlmApiStyle;
    fallbackProviderId?: string;
    fallbackModel?: string;
    fallbackApiStyle?: import("./llm.js").LlmApiStyle;
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
    linkedTaskId?: string;
    linkedDurableRunId?: string;
    nextWakeAt?: string;
    stopReason?: import("./proactive.js").ProactiveStopReason;
  };
  durable?: ChatTurnDurableRecord;
  orchestration?: ChatOrchestrationSummary;
  guidance?: {
    workspaceId: string;
    globalFilesUsed: string[];
    workspaceFilesUsed: string[];
    truncated: boolean;
  };
  loopGuard?: {
    enabled: boolean;
    historySize: number;
    events: ChatToolLoopGuardEventRecord[];
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
  label?: string;
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
  durableRunId?: string;
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

export interface ChatDelegateStepRequest {
  stepId?: string;
  index?: number;
  role: string;
  parallelizable?: boolean;
  dependsOnStepIds?: string[];
}

export interface ChatDelegateRequest {
  objective: string;
  roles: string[];
  mode?: ChatDelegationMode;
  surfaceMode?: ChatMode;
  providerId?: string;
  model?: string;
  steps?: ChatDelegateStepRequest[];
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  fullWebAccess?: boolean;
  /**
   * Depth of the parent run in the subagent tree. Children are spawned at
   * `parentSubagentDepth + 1` and are subject to the configured maxDepth
   * budget. Undefined implies a top-level parent (depth 0).
   */
  parentSubagentDepth?: number;
}

export interface ChatDelegateResponse {
  runId: string;
  taskId: string;
  status: ChatDelegationRunStatus;
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

export type ChatSpecialistCandidateStatus = "suggested" | "drafted" | "disabled" | "approved" | "active" | "retired";

export type ChatSpecialistCandidateRoutingMode = "disabled" | "manual_only" | "strong_match_only";

export type ChatSpecialistCandidateSource = "manual" | "runtime_gap" | "replay" | "catalog";

export type ChatSpecialistCandidateEvidenceKind = "role_gap" | "tool_gap" | "skill_gap" | "successful_workaround";

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
  surfaceMode?: ChatMode;
  providerId?: string;
  model?: string;
  steps?: ChatDelegateStepRequest[];
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  fullWebAccess?: boolean;
}

export interface ChatSendMessageRequest {
  content: string;
  parts?: ChatInputPart[];
  providerId?: string;
  model?: string;
  routeDecision?: RoutingDecisionSnapshot;
  signal?: AbortSignal;
  useMemory?: boolean;
  attachments?: string[];
  mode?: ChatMode;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
  normalizationProfile?: ChatNormalizationProfile;
  commandText?: string;
  prefsOverride?: ChatSessionPrefsPatch;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  policyRunId?: string;
  policyTaskId?: string;
  fullWebAccess?: boolean;
  /**
   * When set, the constructed user message will carry parentDelegationStepId so the
   * child transcript links back to the parent's delegation step record. Used by
   * the chat-delegation-service when spawning child sessions.
   */
  parentDelegationStepId?: string;
}

export type RoutingPreflightAction = "send" | "retry" | "edit";
export type RoutingPreflightSelectionSource = "manual" | "session" | "global";
export type RoutingPreflightFallbackPolicy = "off" | "armed";
export type RoutingPreflightFallbackResult = "not_applicable" | "same_boundary" | "local_to_cloud" | "cloud_to_local";
export type RoutingPreflightRuntimeReachability = "not_checked" | "reachable" | "unreachable" | "models_unavailable";
export type RoutingPreflightRuntimeClass = "local" | "cloud" | "unknown";

export interface RoutingPreflightRequest {
  action: RoutingPreflightAction;
  turnId?: string;
  providerId?: string;
  model?: string;
  mode?: ChatMode;
  webMode?: ChatWebMode;
  thinkingLevel?: ChatThinkingLevel;
  speedMode?: ChatSpeedMode;
  subagentPolicy?: ChatSubagentPolicy;
  prefsOverride?: ChatSessionPrefsPatch;
}

export interface RoutingDecisionSnapshot {
  action: RoutingPreflightAction;
  turnId?: string;
  issuedAt: string;
  expiresAt: string;
  requestedProviderId?: string;
  requestedModel?: string;
  effectiveProviderId?: string;
  effectiveModel?: string;
  selectionSource: RoutingPreflightSelectionSource;
  normalizationReason?: string;
  fallbackPolicy: RoutingPreflightFallbackPolicy;
  fallbackResult: RoutingPreflightFallbackResult;
  runtimeReachability: RoutingPreflightRuntimeReachability;
  runtimeClass: RoutingPreflightRuntimeClass;
  blockedReason?: string;
  degradedReason?: string;
  fingerprint: string;
}

export interface RoutingPreflightResult {
  requestedProviderId?: string;
  requestedModel?: string;
  effectiveProviderId?: string;
  effectiveModel?: string;
  selectionSource: RoutingPreflightSelectionSource;
  normalizationReason?: string;
  fallbackPolicy: RoutingPreflightFallbackPolicy;
  fallbackResult: RoutingPreflightFallbackResult;
  runtimeReachability: RoutingPreflightRuntimeReachability;
  runtimeClass: RoutingPreflightRuntimeClass;
  blockedReason?: string;
  degradedReason?: string;
  decision: RoutingDecisionSnapshot;
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
  generatedArtifacts?: ChatGeneratedArtifactReference[];
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
  costSource?: ChatUsageCostSource;
}

export interface ChatStreamApprovalRecord {
  approvalId: string;
  kind?: string;
  toolName?: string;
  description?: string;
  reason?: string;
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  affectedResources?: string[];
  taskId?: string;
  codeModeRunId?: string;
  codeHash?: string;
  wrapperManifestHash?: string;
  capabilitySnapshotId?: string;
  inspectPath?: string;
  requestedOutputIntent?: string;
  saveCandidateOnSuccess?: boolean;
  remainingCount?: number;
  expiresAt?: string;
}

export type ChatUserInputPromptKind = "single_select" | "text";

export interface ChatUserInputPromptOptionRecord {
  optionId: string;
  label: string;
  description: string;
  helpText?: string;
}

export interface ChatUserInputPromptRecord {
  promptId: string;
  turnId: string;
  kind: ChatUserInputPromptKind;
  title: string;
  question: string;
  required: boolean;
  dismissible?: boolean;
  expiresAt?: string;
  options?: ChatUserInputPromptOptionRecord[];
  placeholder?: string;
  submitLabel?: string;
  multiline?: boolean;
}

export type ChatUserInputPromptResponse =
  | {
      kind: "single_select";
      optionId: string;
    }
  | {
      kind: "text";
      text: string;
    };

export interface ChatUserInputPromptAnswerRequest {
  response: ChatUserInputPromptResponse;
}

export interface ChatUserInputPromptAnswerResponse {
  ok: true;
  sessionId: string;
  turnId: string;
  promptId: string;
  resumed: boolean;
  resumedTurnId?: string;
  resumedRunId?: string;
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
  repaired?: boolean;
  repair?: ChatTurnRepairRecord;
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

export interface ChatStreamUserInputRequiredChunk extends ChatStreamChunkBase {
  type: "user_input_required";
  turnId: string;
  prompt: ChatUserInputPromptRecord;
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
  | ChatStreamUserInputRequiredChunk
  | ChatStreamTraceUpdateChunk
  | ChatStreamCitationChunk
  | ChatStreamCapabilitySuggestionChunk
  | ChatStreamErrorChunk
  | ChatStreamDoneChunk;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ChatStreamChunkDraft = DistributiveOmit<ChatStreamChunk, "eventId" | "sequence" | "runId">;

export interface ChatSteerRequest {
  instruction: string;
}

export interface ChatSteerResponse {
  sessionId: string;
  turnId: string;
  accepted: boolean;
  reason?: string;
}

export interface ChatGoalRequest {
  goal: string;
  turnBudget?: number;
}

export interface ChatGoalStatusResponse {
  sessionId: string;
  goal: string | null;
  turnBudget: number | null;
  turnsUsed: number;
  setAt: string | null;
}

import type { ChatCompletionMessage } from "./llm.js";

export type HookPhase = "before" | "around" | "after";

export type HookMode = "observe" | "mutate" | "intercept";

export type HookFailPolicy = "open" | "closed";

export type HookActionType = "webhook";

export type HookTrigger =
  | "llm.model.select.before"
  | "llm.request.before"
  | "gateway.dispatch.before"
  | "llm.response.after"
  | "before_prompt_build"
  | "llm_input"
  | "llm_output"
  | "tool.call.before"
  | "tool.call.after"
  | "tool.call.error"
  | "after_tool_call"
  | "approval.create.before"
  | "approval.resolve.after"
  | "orchestration.run.before"
  | "orchestration.phase.before"
  | "orchestration.phase.after"
  | "orchestration.retry.scheduled"
  | "orchestration.run.woken"
  | "before_message_write"
  | "agent_end";

export type HookDeliveryStatus =
  | "queued"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "timed_out"
  | "dead_lettered"
  | "skipped";

export interface HookWebhookActionConfig {
  url: string;
  secret?: string;
}

export interface HookActionConfig {
  type: "webhook";
  webhook: HookWebhookActionConfig;
}

export interface LlmModelSelectHookPatch {
  providerId?: string;
  model?: string;
}

export interface LlmRequestHookPatch extends LlmModelSelectHookPatch {
  prependMessages?: ChatCompletionMessage[];
  appendMessages?: ChatCompletionMessage[];
  tools?: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface GatewayDispatchHookPatch {
  metadata?: Record<string, unknown>;
}

export interface ToolCallHookPatch {
  toolName?: string;
  args?: Record<string, unknown>;
}

export interface ApprovalCreateHookPatch {
  riskLevel?: "safe" | "caution" | "danger" | "nuclear";
  payloadMerge?: Record<string, unknown>;
  previewMerge?: Record<string, unknown>;
  expiresAt?: string | null;
}

export interface OrchestrationRunHookPatch {
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  maxCostUsd?: number;
}

export interface OrchestrationPhaseHookPatch {
  ownerAgentId?: string;
  specPath?: string;
  loopMode?: "fresh-context" | "compaction";
  requiresApproval?: boolean;
}

export type RuntimeLifecycleHookTrigger =
  | "before_prompt_build"
  | "llm_input"
  | "llm_output"
  | "after_tool_call"
  | "before_message_write"
  | "agent_end";

export interface RuntimeLifecycleHookBasePayload {
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  taskId?: string;
  approvalId?: string;
  providerId?: string;
  model?: string;
}

export interface BeforePromptBuildHookPayload extends RuntimeLifecycleHookBasePayload {
  messageCount: number;
  memoryEnabled: boolean;
  hasMemoryContext: boolean;
}

export interface LlmInputHookPayload extends RuntimeLifecycleHookBasePayload {
  messageCount: number;
  toolCount: number;
  metadataKeys: string[];
  stream: boolean;
}

export interface LlmOutputHookPayload extends RuntimeLifecycleHookBasePayload {
  effectiveProviderId?: string;
  effectiveModel?: string;
  fallbackUsed: boolean;
  stream: boolean;
  messageCount: number;
}

export interface AfterToolCallHookPayload extends RuntimeLifecycleHookBasePayload {
  toolName: string;
  outcome: string;
  auditEventId?: string;
  policyReason?: string;
}

export interface BeforeMessageWriteHookPayload extends RuntimeLifecycleHookBasePayload {
  messageId: string;
  contentLength: number;
  stream: boolean;
}

export interface AgentEndHookPayload extends RuntimeLifecycleHookBasePayload {
  status: string;
  toolRunCount: number;
  stream: boolean;
  repaired: boolean;
}

export interface RuntimeLifecycleHookPayloadByTrigger {
  before_prompt_build: BeforePromptBuildHookPayload;
  llm_input: LlmInputHookPayload;
  llm_output: LlmOutputHookPayload;
  after_tool_call: AfterToolCallHookPayload;
  before_message_write: BeforeMessageWriteHookPayload;
  agent_end: AgentEndHookPayload;
}

export interface HookPatchByTrigger {
  "llm.model.select.before": LlmModelSelectHookPatch;
  "llm.request.before": LlmRequestHookPatch;
  "gateway.dispatch.before": GatewayDispatchHookPatch;
  "llm.response.after": never;
  before_prompt_build: never;
  llm_input: never;
  llm_output: never;
  "tool.call.before": ToolCallHookPatch;
  "tool.call.after": never;
  "tool.call.error": never;
  after_tool_call: never;
  "approval.create.before": ApprovalCreateHookPatch;
  "approval.resolve.after": never;
  "orchestration.run.before": OrchestrationRunHookPatch;
  "orchestration.phase.before": OrchestrationPhaseHookPatch;
  "orchestration.phase.after": never;
  "orchestration.retry.scheduled": never;
  "orchestration.run.woken": never;
  before_message_write: never;
  agent_end: never;
}

export type HookPatch =
  | LlmModelSelectHookPatch
  | LlmRequestHookPatch
  | GatewayDispatchHookPatch
  | ToolCallHookPatch
  | ApprovalCreateHookPatch
  | OrchestrationRunHookPatch
  | OrchestrationPhaseHookPatch;

export interface HookPatchSummary {
  keys: string[];
  changed: boolean;
}

export interface HookDecisionContinue {
  type: "continue";
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface HookDecisionBlock {
  type: "block";
  reason: string;
  code?: string;
  metadata?: Record<string, unknown>;
}

export type HookDecision = HookDecisionContinue | HookDecisionBlock;

export interface HookRecord {
  hookId: string;
  workspaceId: string;
  label: string;
  trigger: HookTrigger;
  phase: HookPhase;
  mode: HookMode;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  failPolicy: HookFailPolicy;
  action: HookActionConfig;
  createdAt: string;
  updatedAt: string;
}

export interface HookCreateInput {
  workspaceId: string;
  label: string;
  trigger: HookTrigger;
  mode: HookMode;
  enabled?: boolean;
  priority?: number;
  timeoutMs?: number;
  failPolicy?: HookFailPolicy;
  action: HookActionConfig;
}

export interface HookUpdateInput {
  label?: string;
  enabled?: boolean;
  priority?: number;
  timeoutMs?: number;
  failPolicy?: HookFailPolicy;
  action?: HookActionConfig;
}

export interface HookRunRecord {
  runId: string;
  hookId: string;
  workspaceId: string;
  trigger: HookTrigger;
  entityType: string;
  entityId: string;
  mode: HookMode;
  status: HookDeliveryStatus;
  idempotencyKey: string;
  attemptCount: number;
  durableRunId?: string;
  decision?: HookDecision;
  patchSummary?: HookPatchSummary;
  errorText?: string;
  latencyMs?: number;
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface HookDispatchEnvelope {
  hook: {
    hookId: string;
    label: string;
    workspaceId: string;
    trigger: HookTrigger;
    phase: HookPhase;
    mode: HookMode;
  };
  delivery: {
    runId: string;
    idempotencyKey: string;
    attemptCount: number;
    timestamp: string;
  };
  event: {
    workspaceId: string;
    trigger: HookTrigger;
    entityType: string;
    entityId: string;
  };
  payload: Record<string, unknown>;
}

export interface HookWebhookResponse {
  decision?: HookDecision;
  patch?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function deriveHookPhase(trigger: HookTrigger): HookPhase {
  if (trigger === "before_prompt_build" || trigger === "before_message_write") {
    return "before";
  }
  if (trigger === "llm_input" || trigger === "llm_output" || trigger === "after_tool_call" || trigger === "agent_end") {
    return "after";
  }
  if (trigger.endsWith(".before")) {
    return "before";
  }
  if (trigger.endsWith(".after")) {
    return "after";
  }
  return "after";
}

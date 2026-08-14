import type { ChatCompletionMessage } from "./llm.js";

export type HookPhase = "before" | "around" | "after";

/**
 * Hook execution mode.
 *
 * - `observe`: hook receives the event but cannot affect dispatch. Best for logging,
 *   metrics, audit fan-out. Failure of observe hooks never blocks the caller.
 * - `mutate`: hook may return a `patch` object that the runtime merges back into the
 *   request before execution proceeds. Only valid for `*.before` triggers that define
 *   a `HookPatchByTrigger` entry (i.e., not `never`).
 * - `intercept`: hook may return `{ decision: { type: "block", reason } }` to veto
 *   the operation. The runtime surfaces the reason to the caller (transcript / API
 *   error) and never invokes the underlying side effect. Combine with
 *   `failPolicy: "closed"` for fail-closed enforcement when the hook itself errors.
 *
 * Veto contract:
 * - `tool.call.before` veto → `ToolInvokeResult.outcome === "blocked"`, downstream
 *   `policyEngine.invoke` is not called.
 * - `gateway.dispatch.before` / `llm.request.before` / `transform_llm_output` /
 *   `approval.request.before` / `approval.create.before` veto → caller throws an
 *   Error with the veto reason as message; downstream side effects do not run.
 */
export type HookMode = "observe" | "mutate" | "intercept";

export type HookFailPolicy = "open" | "closed";

/** Payload projection granted to a hook. Content is always an explicit opt-in. */
export type HookDataScope = "metadata" | "content";

export type HookActionType = "webhook" | "managed_package";

export type HookTrigger =
  | "llm.model.select.before"
  | "llm.request.before"
  | "gateway.dispatch.before"
  | "transform_llm_output"
  | "llm.response.after"
  | "before_prompt_build"
  | "llm_input"
  | "llm_output"
  | "tool.call.before"
  | "tool.call.after"
  | "tool.call.error"
  | "after_tool_call"
  | "approval.request.before"
  | "approval.create.before"
  | "approval.resolve.after"
  | "approval.response.after"
  | "orchestration.run.before"
  | "orchestration.phase.before"
  | "orchestration.phase.after"
  | "orchestration.retry.scheduled"
  | "orchestration.run.woken"
  | "before_message_write"
  | "agent_end"
  | "session.start"
  | "session.end"
  | "prompt.submit.before"
  | "context.compaction.before"
  | "context.compaction.after"
  | "subagent.start"
  | "subagent.end"
  | "agent.finalize.before";

export const HOOK_TRIGGER_VALUES: readonly HookTrigger[] = [
  "llm.model.select.before", "llm.request.before", "gateway.dispatch.before", "transform_llm_output",
  "llm.response.after", "before_prompt_build", "llm_input", "llm_output", "tool.call.before",
  "tool.call.after", "tool.call.error", "after_tool_call", "approval.request.before",
  "approval.create.before", "approval.resolve.after", "approval.response.after", "orchestration.run.before",
  "orchestration.phase.before", "orchestration.phase.after", "orchestration.retry.scheduled",
  "orchestration.run.woken", "before_message_write", "agent_end", "session.start", "session.end",
  "prompt.submit.before", "context.compaction.before", "context.compaction.after", "subagent.start",
  "subagent.end", "agent.finalize.before",
] as const;

export interface HookEventDefinition {
  trigger: HookTrigger;
  phase: HookPhase;
  allowedModes: readonly HookMode[];
  defaultDataScope: HookDataScope;
  durable: boolean;
  /** Pre-hooks execute in priority order; post-observers materialize durable runs. */
  ordering: "priority_serial" | "durable_async";
  /** The Gateway-enforced delivery budget before a hook is marked timed out. */
  defaultTimeoutMs: number;
  /** Public contract for a handler response; actual parsing remains Gateway-owned. */
  responseSchema: "observe" | "patch" | "block" | "finalize";
  /** Observe failures are recorded; enforcement hooks follow their configured fail policy. */
  failureSemantics: "record_only" | "configured_fail_policy";
}

const BEFORE_MUTABLE_TRIGGERS = new Set<HookTrigger>([
  "llm.model.select.before", "llm.request.before", "transform_llm_output", "tool.call.before",
  "approval.create.before", "orchestration.run.before", "orchestration.phase.before",
]);
const BEFORE_INTERCEPTABLE_TRIGGERS = new Set<HookTrigger>([
  "llm.model.select.before", "llm.request.before", "gateway.dispatch.before", "transform_llm_output",
  "tool.call.before", "approval.request.before", "approval.create.before", "orchestration.run.before",
  "orchestration.phase.before", "prompt.submit.before", "agent.finalize.before",
]);

/** Canonical lifecycle registration contract; runtime dispatch remains Gateway-owned. */
export const HOOK_EVENT_REGISTRY: Readonly<Record<HookTrigger, HookEventDefinition>> = Object.freeze(
  Object.fromEntries(HOOK_TRIGGER_VALUES.map((trigger) => {
    const phase = deriveHookPhase(trigger);
    const allowedModes: HookMode[] = ["observe"];
    if (BEFORE_MUTABLE_TRIGGERS.has(trigger)) allowedModes.push("mutate");
    if (BEFORE_INTERCEPTABLE_TRIGGERS.has(trigger)) allowedModes.push("intercept");
    const durable = phase === "after";
    return [
      trigger,
      {
        trigger,
        phase,
        allowedModes,
        defaultDataScope: "metadata",
        durable,
        ordering: durable ? "durable_async" : "priority_serial",
        defaultTimeoutMs: 5_000,
        responseSchema:
          trigger === "agent.finalize.before"
            ? "finalize"
            : allowedModes.includes("mutate")
              ? "patch"
              : allowedModes.includes("intercept")
                ? "block"
                : "observe",
        failureSemantics: allowedModes.length === 1 ? "record_only" : "configured_fail_policy",
      } satisfies HookEventDefinition,
    ];
  })) as unknown as Record<HookTrigger, HookEventDefinition>,
);

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
  /** Opaque keychain locator persisted for newly created or rotated hooks. */
  secretRef?: string;
  /** @deprecated Compatibility input only; Gateway custody removes it before persistence. */
  secret?: string;
}

export interface HookWebhookAction {
  type: "webhook";
  webhook: HookWebhookActionConfig;
}

export interface ManagedHookPackageActionConfig {
  packageId: string;
  manifestHash: string;
}

export interface ManagedHookPackageAction {
  type: "managed_package";
  managedPackage: ManagedHookPackageActionConfig;
}

export type HookActionConfig = HookWebhookAction | ManagedHookPackageAction;

/** Immutable, reviewed local handler bundle. This is integrity evidence, not a hostile-code sandbox claim. */
export interface HookPackageManifest {
  schemaVersion: 1;
  packageId: string;
  title: string;
  handlerArtifactSha256: string;
  skillArtifactSha256: string;
  subscriptions: Array<{ trigger: HookTrigger; mode: HookMode; dataScope: HookDataScope }>;
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

export interface TransformLlmOutputHookPatch {
  content?: string;
  metadata?: Record<string, unknown>;
}

export type RuntimeLifecycleHookTrigger =
  | "before_prompt_build"
  | "llm_input"
  | "llm_output"
  | "after_tool_call"
  | "before_message_write"
  | "agent_end"
  | "session.start"
  | "session.end"
  | "prompt.submit.before"
  | "context.compaction.before"
  | "context.compaction.after"
  | "subagent.start"
  | "subagent.end"
  | "agent.finalize.before";

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

export interface SessionStartHookPayload extends RuntimeLifecycleHookBasePayload {
  sessionId: string;
  origin: string;
  mode?: string;
}

export interface SessionEndHookPayload extends RuntimeLifecycleHookBasePayload {
  sessionId: string;
  reason: "deleted" | "archived" | "ended";
}

export interface PromptSubmitBeforeHookPayload extends RuntimeLifecycleHookBasePayload {
  sessionId: string;
  turnId: string;
  contentLength: number;
  mode?: string;
  attachmentCount: number;
}

export interface ContextCompactionHookPayload extends RuntimeLifecycleHookBasePayload {
  sessionId: string;
  branchHeadTurnId: string;
  startTurnId: string;
  endTurnId: string;
  turnCount: number;
  sourceHash: string;
  summaryHash?: string;
}

export interface SubagentLifecycleHookPayload extends RuntimeLifecycleHookBasePayload {
  parentSessionId: string;
  childSessionId: string;
  delegationRunId: string;
  stepId: string;
  role: string;
  status?: string;
}

export interface AgentFinalizeBeforeHookPayload extends BeforeMessageWriteHookPayload {}

export interface RuntimeLifecycleHookPayloadByTrigger {
  before_prompt_build: BeforePromptBuildHookPayload;
  llm_input: LlmInputHookPayload;
  llm_output: LlmOutputHookPayload;
  after_tool_call: AfterToolCallHookPayload;
  before_message_write: BeforeMessageWriteHookPayload;
  agent_end: AgentEndHookPayload;
  "session.start": SessionStartHookPayload;
  "session.end": SessionEndHookPayload;
  "prompt.submit.before": PromptSubmitBeforeHookPayload;
  "context.compaction.before": ContextCompactionHookPayload;
  "context.compaction.after": ContextCompactionHookPayload;
  "subagent.start": SubagentLifecycleHookPayload;
  "subagent.end": SubagentLifecycleHookPayload;
  "agent.finalize.before": AgentFinalizeBeforeHookPayload;
}

export interface HookPatchByTrigger {
  "llm.model.select.before": LlmModelSelectHookPatch;
  "llm.request.before": LlmRequestHookPatch;
  "gateway.dispatch.before": never;
  transform_llm_output: TransformLlmOutputHookPatch;
  "llm.response.after": never;
  before_prompt_build: never;
  llm_input: never;
  llm_output: never;
  "tool.call.before": ToolCallHookPatch;
  "tool.call.after": never;
  "tool.call.error": never;
  after_tool_call: never;
  "approval.request.before": never;
  "approval.create.before": ApprovalCreateHookPatch;
  "approval.resolve.after": never;
  "approval.response.after": never;
  "orchestration.run.before": OrchestrationRunHookPatch;
  "orchestration.phase.before": OrchestrationPhaseHookPatch;
  "orchestration.phase.after": never;
  "orchestration.retry.scheduled": never;
  "orchestration.run.woken": never;
  before_message_write: never;
  agent_end: never;
  "session.start": never;
  "session.end": never;
  "prompt.submit.before": never;
  "context.compaction.before": never;
  "context.compaction.after": never;
  "subagent.start": never;
  "subagent.end": never;
  "agent.finalize.before": never;
}

export type HookPatch =
  | LlmModelSelectHookPatch
  | LlmRequestHookPatch
  | ToolCallHookPatch
  | ApprovalCreateHookPatch
  | OrchestrationRunHookPatch
  | OrchestrationPhaseHookPatch
  | TransformLlmOutputHookPatch;

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

/** Only valid for agent.finalize.before and bounded by the durable turn owner. */
export interface HookDecisionRevise {
  type: "revise";
  reason: string;
  metadata?: Record<string, unknown>;
}

export type HookDecision = HookDecisionContinue | HookDecisionBlock | HookDecisionRevise;

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
  /** Omitted only by compatibility callers; persisted records always project metadata by default. */
  dataScope?: HookDataScope;
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
  dataScope?: HookDataScope;
  action: HookActionConfig;
}

export interface HookUpdateInput {
  label?: string;
  enabled?: boolean;
  priority?: number;
  timeoutMs?: number;
  failPolicy?: HookFailPolicy;
  dataScope?: HookDataScope;
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
  if (
    trigger === "before_prompt_build" ||
    trigger === "before_message_write" ||
    trigger === "prompt.submit.before" ||
    trigger === "context.compaction.before" ||
    trigger === "agent.finalize.before"
  ) {
    return "before";
  }
  if (
    trigger === "llm_input" ||
    trigger === "llm_output" ||
    trigger === "after_tool_call" ||
    trigger === "agent_end" ||
    trigger === "context.compaction.after" ||
    trigger === "session.start" ||
    trigger === "session.end" ||
    trigger === "subagent.start" ||
    trigger === "subagent.end"
  ) {
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

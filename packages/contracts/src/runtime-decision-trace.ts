export const RUNTIME_DECISION_TRACE_PAYLOAD_LIMIT_BYTES = 16 * 1024;

export const RUNTIME_DECISION_TRACE_LIMITS = {
  maxSignals: 12,
  maxAlternatives: 5,
  maxEvidenceRefs: 12,
  maxStringLength: 1_000,
} as const;

export const RUNTIME_DECISION_KINDS = [
  "chat_turn_prepared",
  "memory_context",
  "routing_choice",
  "workflow_choice",
  "direct_answer",
  "execution_plan_created",
  "execution_plan_revised",
  "tool_selected",
  "tool_reused",
  "tool_blocked",
  "tool_approval_required",
  "tool_failed",
  "approval_requested",
  "approval_resolved",
  "approval_expired",
  "runtime_paused",
  "runtime_resumed",
  "orchestration_run_started",
  "orchestration_phase_advanced",
  "durable_checkpoint",
  "orchestration_run_completed",
  "orchestration_run_failed",
  "orchestration_run_cancelled",
  "unknown",
] as const;

export type RuntimeDecisionKind = (typeof RUNTIME_DECISION_KINDS)[number];

export type RuntimeDecisionSignalSource =
  | "policy"
  | "capability"
  | "memory"
  | "routing"
  | "operator_pref"
  | "durable"
  | "tool_result"
  | "model_router"
  | "context"
  | "orchestration"
  | "approval"
  | "execution_plan"
  | "system";

export type RuntimeDecisionSignalWeight = "blocking" | "strong" | "weak" | "informational";

export type RuntimeDecisionPrimitive = string | number | boolean | null;

export type RuntimeDecisionEvidenceRefType =
  | "turn"
  | "session"
  | "run"
  | "plan"
  | "step"
  | "tool_run"
  | "approval"
  | "checkpoint"
  | "event"
  | "memory"
  | "capability_snapshot"
  | "durable_run"
  | "task";

export interface RuntimeDecisionEvidenceRef {
  refType: RuntimeDecisionEvidenceRefType;
  refId: string;
  label?: string;
}

export interface RuntimeDecisionSignal {
  source: RuntimeDecisionSignalSource;
  key: string;
  value?: RuntimeDecisionPrimitive;
  weight?: RuntimeDecisionSignalWeight;
  evidence?: RuntimeDecisionEvidenceRef;
}

export interface RuntimeDecisionAlternative {
  label: string;
  outcome: "not_chosen" | "blocked" | "deferred" | "fallback";
  reasonNotChosen: string;
  blockedBy?: string;
}

export interface RuntimeDecisionScope {
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  planId?: string;
  stepId?: string;
  toolRunId?: string;
  approvalId?: string;
  taskId?: string;
  durableRunId?: string;
}

export interface RuntimeDecisionTraceRecord {
  decisionId: string;
  kind: RuntimeDecisionKind;
  scope: RuntimeDecisionScope;
  selected: string;
  rationale: string;
  alternatives: RuntimeDecisionAlternative[];
  signals: RuntimeDecisionSignal[];
  evidenceRefs: RuntimeDecisionEvidenceRef[];
  previousDecisionId?: string;
  planRevision?: number;
  latencyMs?: number;
  createdAt: string;
}

export type RuntimeDecisionTraceAppendInput = Omit<
  RuntimeDecisionTraceRecord,
  "decisionId" | "createdAt" | "alternatives" | "signals" | "evidenceRefs"
> &
  Partial<Pick<RuntimeDecisionTraceRecord, "decisionId" | "createdAt" | "alternatives" | "signals" | "evidenceRefs">>;

export interface RuntimeDecisionTraceQuery extends RuntimeDecisionScope {
  limit?: number;
}

export interface RuntimeDecisionTraceResponse {
  items: RuntimeDecisionTraceRecord[];
}

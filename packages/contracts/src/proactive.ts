export type ProactiveMode = "off" | "suggest" | "auto_safe" | "auto_full";
export type ProactiveTriggerSource = "scheduler" | "manual" | "chat" | "approval_resume";
export type ProactiveOriginSurface = "chat" | "cowork" | "code";
export type ProactiveStopReason =
  | "completed"
  | "approval_block"
  | "operator_stop"
  | "budget_exhausted"
  | "cooldown"
  | "retry_exhausted"
  | "terminal_failure"
  | "policy_conflict"
  | "project_binding_conflict"
  | "no_action";

export interface ProactivePolicy {
  sessionId: string;
  mode: ProactiveMode;
  autonomyBudget: {
    maxActionsPerHour: number;
    maxActionsPerTurn: number;
    cooldownSeconds: number;
  };
  retrievalMode: "standard" | "layered";
  reflectionMode: "off" | "on";
  updatedAt: string;
}

export type ProactiveRunStatus =
  | "running"
  | "no_action"
  | "suggested"
  | "executed"
  | "blocked"
  | "failed";

export type ProactiveActionKind = "tool" | "delegate" | "note";

export interface ProactiveReferenceRootRecord {
  label: string;
  rootPath: string;
  access: "read_only";
}

export interface ProactiveActionRecord {
  actionId: string;
  runId: string;
  sessionId: string;
  linkedTaskId?: string;
  linkedDurableRunId?: string;
  approvalId?: string;
  kind: ProactiveActionKind;
  status: "suggested" | "executed" | "blocked" | "failed";
  triggerSource?: ProactiveTriggerSource;
  originSurface?: ProactiveOriginSurface;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  externalReferenceRoots?: ProactiveReferenceRootRecord[];
  createdAt: string;
  updatedAt?: string;
}

export interface ProactiveRunRecord {
  runId: string;
  sessionId: string;
  linkedTaskId?: string;
  linkedDurableRunId?: string;
  approvalId?: string;
  status: ProactiveRunStatus;
  mode: ProactiveMode;
  triggerSource?: ProactiveTriggerSource;
  originSurface?: ProactiveOriginSurface;
  confidence: number;
  reasoningSummary: string;
  nextWakeAt?: string;
  stopReason?: ProactiveStopReason;
  externalReferenceRoots?: ProactiveReferenceRootRecord[];
  resumeMetadata?: Record<string, unknown>;
  suggestedActions: ProactiveActionRecord[];
  executedActions: ProactiveActionRecord[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

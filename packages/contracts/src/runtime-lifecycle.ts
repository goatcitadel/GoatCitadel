import type { ApprovalEffectRecord, ApprovalRequest } from "./approvals.js";
import type {
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatExecutionPlanRecord,
  ChatExecutionPlanStepRecord,
  ChatToolRunRecord,
  ChatTurnTraceRecord,
} from "./chat.js";
import type { DurableRunRecord } from "./durable.js";
import type { SessionMeta, SessionSummary, SessionTimelineItem, TranscriptEvent } from "./session.js";
import type { TaskRecord } from "./tasks.js";
import type { ProactiveRunRecord } from "./proactive.js";

export interface RuntimeLifecycleQuery {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
}

export interface RuntimeLifecycleExportQuery extends RuntimeLifecycleQuery {
  includeTranscript?: boolean;
  includeTimeline?: boolean;
  timelineLimit?: number;
}

export interface RuntimeLifecycleTurnSummary extends Pick<
  ChatTurnTraceRecord,
  "turnId" | "sessionId" | "parentTurnId" | "status" | "mode" | "startedAt" | "finishedAt"
> {
  userMessageId: string;
  assistantMessageId?: string;
  durableRunId?: string;
  completion?: ChatTurnTraceRecord["completion"];
  failure?: ChatTurnTraceRecord["failure"];
}

export type RuntimeLifecycleToolRunSummary = Pick<
  ChatToolRunRecord,
  | "toolRunId"
  | "turnId"
  | "sessionId"
  | "toolName"
  | "status"
  | "approvalId"
  | "startedAt"
  | "finishedAt"
  | "reused"
  | "reusedFromToolRunId"
  | "reuseReason"
>;

export type RuntimeLifecycleExecutionPlanStepSummary = Pick<
  ChatExecutionPlanStepRecord,
  | "stepId"
  | "index"
  | "objective"
  | "status"
  | "delegatedRole"
  | "childRunId"
  | "durableRunId"
  | "childSessionId"
  | "childTurnId"
>;

export interface RuntimeLifecycleExecutionPlanSummary extends Pick<
  ChatExecutionPlanRecord,
  | "planId"
  | "sessionId"
  | "turnId"
  | "mode"
  | "planningMode"
  | "status"
  | "source"
  | "advisoryOnly"
  | "objective"
  | "summary"
  | "startedAt"
  | "finishedAt"
> {
  steps: RuntimeLifecycleExecutionPlanStepSummary[];
}

export type RuntimeLifecycleDelegationRunSummary = Pick<
  ChatDelegationRunRecord,
  | "runId"
  | "sessionId"
  | "taskId"
  | "objective"
  | "roles"
  | "mode"
  | "status"
  | "executionPlanId"
  | "startedAt"
  | "finishedAt"
>;

export type RuntimeLifecycleDelegationStepSummary = Pick<
  ChatDelegationStepRecord,
  | "stepId"
  | "runId"
  | "role"
  | "status"
  | "index"
  | "summary"
  | "error"
  | "childSessionId"
  | "childTurnId"
  | "durableRunId"
>;

export interface RuntimeLifecycleLinkedIds {
  sessionIds: string[];
  turnIds: string[];
  runIds: string[];
  proactiveRunIds: string[];
  approvalIds: string[];
  taskIds: string[];
  workspaceIds: string[];
}

export type RuntimeLifecycleFieldSource =
  | "query"
  | "turn_trace"
  | "execution_plan"
  | "delegation_step"
  | "approval_linkage"
  | "approval_wait_run"
  | "durable_payload"
  | "durable_metadata"
  | "task_context"
  | "proactive_run"
  | "fallback_payload"
  | "fallback_preview"
  | "fallback_metadata";

export interface RuntimeLifecycleResolution {
  sessionIdSource?: RuntimeLifecycleFieldSource;
  turnIdSource?: RuntimeLifecycleFieldSource;
  runIdSource?: RuntimeLifecycleFieldSource;
  approvalIdSource?: RuntimeLifecycleFieldSource;
  taskIdSource?: RuntimeLifecycleFieldSource;
  fallbackSources: RuntimeLifecycleFieldSource[];
}

export interface RuntimeLifecycleCanonicalIds {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
}

export interface RuntimeLifecycleResponse {
  query: RuntimeLifecycleQuery;
  canonical: RuntimeLifecycleCanonicalIds;
  linked: RuntimeLifecycleLinkedIds;
  resolution?: RuntimeLifecycleResolution;
  session?: SessionMeta;
  sessionSummary?: SessionSummary;
  task?: TaskRecord;
  approval?: ApprovalRequest;
  durableRun?: DurableRunRecord;
  proactiveDurableRun?: DurableRunRecord;
  approvalWaitDurableRun?: DurableRunRecord;
  proactiveRuns?: ProactiveRunRecord[];
  approvalEffects?: ApprovalEffectRecord[];
  turns: RuntimeLifecycleTurnSummary[];
  toolRuns: RuntimeLifecycleToolRunSummary[];
  executionPlans?: RuntimeLifecycleExecutionPlanSummary[];
  delegationRuns?: RuntimeLifecycleDelegationRunSummary[];
  delegationSteps?: RuntimeLifecycleDelegationStepSummary[];
}

export interface RuntimeLifecycleExportBundleStats {
  linkedSessionCount: number;
  linkedTurnCount: number;
  linkedRunCount: number;
  linkedApprovalCount: number;
  linkedTaskCount: number;
  turnCount: number;
  toolRunCount: number;
  executionPlanCount: number;
  delegationRunCount: number;
  delegationStepCount: number;
  proactiveRunCount: number;
  approvalEffectCount: number;
  transcriptEventCount: number;
  timelineEventCount: number;
}

export interface RuntimeLifecycleExportBundle extends RuntimeLifecycleResponse {
  export: {
    version: "runtime.lifecycle.export.v1";
    exportedAt: string;
    includeTranscript: boolean;
    includeTimeline: boolean;
    timelineLimit: number;
  };
  transcript?: TranscriptEvent[];
  timeline?: SessionTimelineItem[];
  stats: RuntimeLifecycleExportBundleStats;
}

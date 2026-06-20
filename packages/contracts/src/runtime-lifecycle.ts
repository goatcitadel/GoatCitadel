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
import type { RuntimeDecisionTraceRecord } from "./runtime-decision-trace.js";
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
  format?: "bundle" | "trust_report" | "siem_ndjson";
}

export interface RuntimeLifecycleTurnSummary extends Pick<
  ChatTurnTraceRecord,
  "turnId" | "sessionId" | "parentTurnId" | "status" | "mode" | "startedAt" | "finishedAt"
> {
  userMessageId: string;
  assistantMessageId?: string;
  durableRunId?: string;
  model?: ChatTurnTraceRecord["model"];
  routing?: ChatTurnTraceRecord["routing"];
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

export type RuntimeLifecycleLinkRel =
  | "self"
  | "export_bundle"
  | "export_trust_report"
  | "export_siem_ndjson";

export interface RuntimeLifecycleLink {
  rel: RuntimeLifecycleLinkRel;
  label: string;
  href: string;
  method: "GET";
  contentType: "application/json" | "application/x-ndjson";
  format?: RuntimeLifecycleExportQuery["format"];
}

export interface RuntimeLifecycleResponse {
  query: RuntimeLifecycleQuery;
  canonical: RuntimeLifecycleCanonicalIds;
  links?: RuntimeLifecycleLink[];
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
  decisionTrace?: RuntimeDecisionTraceRecord[];
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
  decisionTraceCount: number;
  transcriptEventCount: number;
  timelineEventCount: number;
}

export interface RuntimeLifecycleTrustReport {
  version: "runtime.trust_report.v1";
  generatedAt: string;
  title: string;
  summary: string;
  source: RuntimeLifecycleCanonicalIds;
  modelProvider: {
    requestedProviderId?: string;
    requestedModel?: string;
    effectiveProviderId?: string;
    effectiveModel?: string;
    fallbackUsed: boolean;
    fallbackReason?: string;
  };
  activity: {
    turnCount: number;
    toolRunCount: number;
    executionPlanCount: number;
    delegationRunCount: number;
    delegationStepCount: number;
    approvalEffectCount: number;
  };
  tools: Array<{
    toolRunId: string;
    toolName?: string;
    status?: string;
    approvalId?: string;
    reused?: boolean;
  }>;
  approvals: Array<{
    approvalId: string;
    status?: string;
    kind?: string;
    riskLevel?: string;
  }>;
  evidence: string[];
  failures: string[];
  openRisks: string[];
  shareableMarkdown: string;
}

export interface RuntimeLifecycleExportBundle extends RuntimeLifecycleResponse {
  export: {
    version: "runtime.lifecycle.export.v1";
    exportedAt: string;
    includeTranscript: boolean;
    includeTimeline: boolean;
    timelineLimit: number;
    format: "bundle" | "trust_report" | "siem_ndjson";
  };
  transcript?: TranscriptEvent[];
  timeline?: SessionTimelineItem[];
  stats: RuntimeLifecycleExportBundleStats;
  trustReport?: RuntimeLifecycleTrustReport;
}

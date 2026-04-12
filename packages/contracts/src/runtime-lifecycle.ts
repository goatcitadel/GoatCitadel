import type { ApprovalEffectRecord, ApprovalRequest } from "./approvals.js";
import type { ChatToolRunRecord, ChatTurnTraceRecord } from "./chat.js";
import type { DurableRunRecord } from "./durable.js";
import type { SessionMeta, SessionSummary } from "./session.js";
import type { TaskRecord } from "./tasks.js";
import type { ProactiveRunRecord } from "./proactive.js";

export interface RuntimeLifecycleQuery {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
}

export interface RuntimeLifecycleTurnSummary extends Pick<
  ChatTurnTraceRecord,
  "turnId" | "sessionId" | "parentTurnId" | "status" | "mode" | "startedAt" | "finishedAt"
> {
  userMessageId: string;
  assistantMessageId?: string;
  durableRunId?: string;
}

export type RuntimeLifecycleToolRunSummary = Pick<
  ChatToolRunRecord,
  "toolRunId" | "turnId" | "sessionId" | "toolName" | "status" | "approvalId" | "startedAt" | "finishedAt"
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
  | "approval_linkage"
  | "approval_wait_run"
  | "turn_trace"
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

export interface RuntimeLifecycleResponse {
  query: RuntimeLifecycleQuery;
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
}

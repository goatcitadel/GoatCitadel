import type { ApprovalRequest } from "./approvals.js";
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

export interface RuntimeLifecycleToolRunSummary extends Pick<
  ChatToolRunRecord,
  "toolRunId" | "turnId" | "sessionId" | "toolName" | "status" | "approvalId" | "startedAt" | "finishedAt"
> {}

export interface RuntimeLifecycleLinkedIds {
  sessionIds: string[];
  turnIds: string[];
  runIds: string[];
  approvalIds: string[];
  taskIds: string[];
  workspaceIds: string[];
}

export interface RuntimeLifecycleResponse {
  query: RuntimeLifecycleQuery;
  linked: RuntimeLifecycleLinkedIds;
  session?: SessionMeta;
  sessionSummary?: SessionSummary;
  task?: TaskRecord;
  approval?: ApprovalRequest;
  durableRun?: DurableRunRecord;
  proactiveRuns?: ProactiveRunRecord[];
  turns: RuntimeLifecycleTurnSummary[];
  toolRuns: RuntimeLifecycleToolRunSummary[];
}

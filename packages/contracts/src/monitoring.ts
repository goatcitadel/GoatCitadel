import type { SessionMeta } from "./session.js";

export type RealtimeEventType =
  | "session_event"
  | "tool_invoked"
  | "approval_created"
  | "approval_resolved"
  | "approval_explained"
  | "auth_device_request_created"
  | "auth_device_request_resolved"
  | "task_created"
  | "task_updated"
  | "task_deleted"
  | "activity_logged"
  | "deliverable_added"
  | "subagent_registered"
  | "subagent_updated"
  | "orchestration_event"
  | "system";

export type RealtimeEventClass = "domain_fact" | "operational_signal" | "ui_notification";
export type RealtimeEventAuthority = "retained_stream" | "durable_history" | "derived_projection";

export interface RealtimeEventLinks {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  durableRunId?: string;
  proactiveRunId?: string;
  approvalId?: string;
  taskId?: string;
  workspaceId?: string;
  connectorId?: string;
  tokenId?: string;
  messageId?: string;
}

export interface RealtimeEvent {
  eventId: string;
  sequence: number;
  eventType: RealtimeEventType | string;
  source: string;
  timestamp: string;
  eventClass?: RealtimeEventClass;
  eventAuthority?: RealtimeEventAuthority;
  links?: RealtimeEventLinks;
  correlationId?: string;
  traceId?: string;
  originSurface?: string;
  payload: Record<string, unknown>;
}

export interface TaskStatusCount {
  status: string;
  count: number;
}

export interface SystemVitals {
  hostname: string;
  platform: string;
  release: string;
  uptimeSeconds: number;
  loadAverage: number[];
  cpuCount: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  memoryUsedBytes: number;
  processRssBytes: number;
  processHeapUsedBytes: number;
}

export interface DashboardState {
  timestamp: string;
  sessions: SessionMeta[];
  pendingApprovals: number;
  activeSubagents: number;
  taskStatusCounts: TaskStatusCount[];
  recentEvents: RealtimeEvent[];
  dailyCostUsd: number;
}

export type CronJobAction =
  | "task"
  | "improvement"
  | "curator"
  | "backup"
  | "memory_flush"
  | "memory_consolidation"
  | "cost_report"
  | "update_review"
  | "watchdog"
  | "no_agent"
  | "agent_turn";

export type CronWatchdogCheckId = "runtime_health" | "durable_dead_letters" | "channel_delivery_queue" | "mcp_posture";
export type CronWatchdogStatus = "ok" | "warning" | "error";

export interface CronWatchdogConfig {
  checkId?: CronWatchdogCheckId;
  severityThreshold?: Extract<CronWatchdogStatus, "warning" | "error">;
  notifyHomeChannel?: boolean;
}

export interface CronNoAgentDeliveryChannel {
  channelKey: string;
  target?: string;
}

export interface CronNoAgentConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
  deliveryChannel?: CronNoAgentDeliveryChannel;
}

/** How a scheduled `agent_turn` job delivers its assistant output to a channel. */
export type CronAgentTurnDeliverMode = "always" | "on_notify";

export interface CronAgentTurnConfig {
  /**
   * Optional stable session id to run the scheduled turn in. When omitted, a
   * deterministic per-job cron session is created/reused.
   */
  sessionId?: string;
  /** Prompt sent to the model as the scheduled user message. Required, non-empty. */
  prompt: string;
  /** Channel the assistant reply is routed to after the turn completes. */
  deliveryChannel?: CronNoAgentDeliveryChannel;
  /**
   * `always` (default) delivers the assistant reply unconditionally; `on_notify`
   * only delivers when the turn output signals `{ notify: true }`.
   */
  deliverMode?: CronAgentTurnDeliverMode;
  /**
   * When true (or when autonomy is disabled via the master kill switch), the job
   * falls back to the legacy inert-inbox `task` behavior instead of waking the
   * model.
   */
  inertInboxFallback?: boolean;
  /**
   * Creator provenance, stamped when a job is created via the model-callable
   * `schedule.manage` tool (P1-F2). Carries the creating operator/actor and their
   * permission profile for ownership, anti-recursion, and audit. Fired turns still
   * use the restricted scheduled profile; profile intersection is not claimed.
   * Absent for system/operator-seeded cron jobs.
   */
  createdBy?: {
    /** Operator id of the creator (or system actor for autonomous creators). */
    operatorId?: string;
    /** Auth actor id of the creator, for the audit trail. */
    authActorId?: string;
    /** Permission profile the creator held, retained for audit and future profile-intersection support. */
    permissionProfileId?: string;
    /**
     * Job id of the turn that created this job, when created from inside another
     * scheduled turn. Used to enforce the depth-1 anti-recursion chain cap.
     */
    createdByJobId?: string;
    /** Chain depth (0 = created interactively; 1 = created by a scheduled turn). */
    depth?: number;
  };
}

export interface CronJobActionConfig {
  watchdog?: CronWatchdogConfig;
  noAgent?: CronNoAgentConfig;
  agentTurn?: CronAgentTurnConfig;
}

export interface CronWatchdogRunResult {
  status: CronWatchdogStatus;
  checkId: CronWatchdogCheckId;
  summary: string;
  details?: Record<string, unknown>;
  notifyHomeChannel?: boolean;
}

export interface CronJobRecord {
  jobId: string;
  name: string;
  action: CronJobAction;
  actionConfig?: CronJobActionConfig;
  description?: string;
  schedule: string;
  enabled: boolean;
  endAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  updatedAt?: string;
  workdir?: string;
  contextFrom?: string;
  lastRunOutput?: string;
  lastRunId?: string;
  lastRunStatus?: "ok" | "failed";
  /** Signed evidence envelope recorded for the last run (cronEvidenceV1Enabled). */
  lastRunEvidenceEnvelopeId?: string;
  lastFailureAt?: string;
  lastFailure?: {
    message: string;
    code?: string;
  };
  failureCount?: number;
  backoffUntil?: string;
}

export interface OperatorSummary {
  operatorId: string;
  sessionCount: number;
  activeSessions: number;
  lastActivityAt?: string;
}

export interface CronReviewItem {
  itemId: string;
  jobId: string;
  runId: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "resolved" | "retrying" | "ignored";
  summary: Record<string, unknown>;
  diff?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface CronRunDiff {
  diffId: string;
  runId: string;
  previousRunId?: string;
  diff: Record<string, unknown>;
  createdAt: string;
}

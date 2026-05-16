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
  | "backup"
  | "memory_flush"
  | "cost_report"
  | "update_review"
  | "watchdog"
  | "no_agent";

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

export interface CronJobActionConfig {
  watchdog?: CronWatchdogConfig;
  noAgent?: CronNoAgentConfig;
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

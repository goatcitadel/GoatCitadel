import type { TaskRetryBudget, TaskDistressSignal, TaskArtifactVerification } from "./task-distress.js";

export type TaskStatus = "planning" | "inbox" | "assigned" | "in_progress" | "testing" | "review" | "done" | "blocked";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface TaskProactiveContext {
  sessionId?: string;
  originSurface?: import("./proactive.js").ProactiveOriginSurface;
  proactiveRunId?: string;
  durableRunId?: string;
  approvalId?: string;
  nextWakeAt?: string;
  stopReason?: import("./proactive.js").ProactiveStopReason;
  externalReferenceRoots?: import("./proactive.js").ProactiveReferenceRootRecord[];
}

export interface TaskRecord {
  taskId: string;
  revision: number;
  workspaceId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId?: string;
  createdBy?: string;
  dueAt?: string;
  proactiveContext?: TaskProactiveContext;
  agenticContext?: import("./agentic-runtime.js").AgenticTaskContext;
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
  retryBudget?: TaskRetryBudget;
  distressSignals?: TaskDistressSignal[];
  artifactVerification?: TaskArtifactVerification[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateInput {
  workspaceId?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedAgentId?: string;
  createdBy?: string;
  dueAt?: string;
  proactiveContext?: TaskProactiveContext;
  agenticContext?: import("./agentic-runtime.js").AgenticTaskContext;
  retryBudget?: TaskRetryBudget;
  distressSignals?: TaskDistressSignal[];
  artifactVerification?: TaskArtifactVerification[];
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedAgentId?: string | null;
  dueAt?: string;
  proactiveContext?: TaskProactiveContext | null;
  agenticContext?: import("./agentic-runtime.js").AgenticTaskContext | null;
  retryBudget?: TaskRetryBudget | null;
  distressSignals?: TaskDistressSignal[] | null;
  artifactVerification?: TaskArtifactVerification[] | null;
}

export type TaskActivityType =
  | "spawned"
  | "updated"
  | "completed"
  | "file_created"
  | "status_changed"
  | "comment"
  | "diagnostic"
  | "heartbeat"
  | "control"
  | "handoff"
  | "delivery";

export interface TaskActivityRecord {
  activityId: string;
  taskId: string;
  agentId?: string;
  activityType: TaskActivityType;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface TaskActivityCreateInput {
  agentId?: string;
  activityType: TaskActivityType;
  message: string;
  metadata?: Record<string, unknown>;
}

export type TaskDeliverableType = "file" | "url" | "artifact";

export interface TaskDeliverableRecord {
  deliverableId: string;
  taskId: string;
  deliverableType: TaskDeliverableType;
  title: string;
  path?: string;
  description?: string;
  createdAt: string;
}

export interface TaskDeliverableCreateInput {
  deliverableType: TaskDeliverableType;
  title: string;
  path?: string;
  description?: string;
}

export type SubagentSessionStatus = "active" | "paused" | "completed" | "failed" | "killed" | "stale";

export interface TaskSubagentSession {
  subagentSessionId: string;
  taskId: string;
  agentSessionId: string;
  agentName?: string;
  status: SubagentSessionStatus;
  metadata?: import("./agentic-runtime.js").AgenticSubagentMetadata;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface TaskSubagentCreateInput {
  agentSessionId: string;
  agentName?: string;
  metadata?: import("./agentic-runtime.js").AgenticSubagentMetadata;
}

export interface TaskSubagentUpdateInput {
  status?: SubagentSessionStatus;
  metadata?: import("./agentic-runtime.js").AgenticSubagentMetadata | null;
  endedAt?: string;
}

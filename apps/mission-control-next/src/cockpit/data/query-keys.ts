import type { RefreshTopic } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

type TopicKey = readonly [RefreshTopic, ...unknown[]];

/** An owner topic is the first segment so its realtime signals can invalidate it. */
export const queryKeys = {
  /** Workspace and Citadel listings share one prefix so directory events refresh them together. */
  directory: (): TopicKey => ["system", "directory"],
  workspaces: (citadelId?: string): TopicKey => ["system", "directory", "workspaces", citadelId ?? "all"],
  citadels: (): TopicKey => ["system", "directory", "citadels"],
  capabilities: (): TopicKey => ["skills", "capabilities"],
  pendingApprovals: (): TopicKey => ["approvals", "pending"],
  inboxAll: (): TopicKey => ["approvals", "operator-inbox"],
  inbox: (workspaceId: string): TopicKey => ["approvals", "operator-inbox", workspaceId],
  health: (workspaceId: string): TopicKey => ["system", "health", workspaceId],
  healthAll: (): TopicKey => ["system", "health"],
  memory: (): TopicKey => ["memory"],
  improvement: (): TopicKey => ["improvement"],
  costs: (): TopicKey => ["system", "costs", "day"],
  durableRuns: (): TopicKey => ["tasks", "durable-runs"],
  durableRunHistory: (workspaceId: string): TopicKey => [
    "tasks",
    "durable-runs",
    "history",
    workspaceId,
    getGatewayApiBaseUrl(),
  ],
  workTasks: (workspaceId: string): TopicKey => ["tasks", "work-tasks", workspaceId, getGatewayApiBaseUrl()],
  runTrace: (runId: string): TopicKey => ["tasks", "durable-run", runId],
  workSessions: (workspaceId: string): TopicKey => ["chat", "work-history", workspaceId],
  workActivity: (workspaceId: string): TopicKey => ["system", "work-activity", workspaceId],
  schedules: (): TopicKey => ["tasks", "schedules"],
  systemActivity: (): TopicKey => ["system", "retained-activity"],
  systemQuality: (): TopicKey => ["quality", "eval-proof-runs"],
  systemDiagnostics: (): TopicKey => ["system", "diagnostics"],
  systemBoards: (workspaceId: string): TopicKey => ["surface", "saved-boards", workspaceId],
};

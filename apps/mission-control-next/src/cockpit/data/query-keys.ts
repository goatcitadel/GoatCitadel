import type { RefreshTopic } from "@goatcitadel/mission-control-shared/state/refresh-bus";

type TopicKey = readonly [RefreshTopic, ...unknown[]];

/** An owner topic is the first segment so its realtime signals can invalidate it. */
export const queryKeys = {
  workspaces: (citadelId?: string): TopicKey => ["system", "workspaces", citadelId ?? "all"],
  citadels: (): TopicKey => ["system", "citadels"],
  capabilities: (): TopicKey => ["skills", "capabilities"],
  pendingApprovals: (): TopicKey => ["approvals", "pending"],
  inbox: (workspaceId: string): TopicKey => ["approvals", "operator-inbox", workspaceId],
  health: (workspaceId: string): TopicKey => ["system", "health", workspaceId],
  costs: (): TopicKey => ["system", "costs", "day"],
  durableRuns: (): TopicKey => ["tasks", "durable-runs"],
  durableRunHistory: (workspaceId: string): TopicKey => ["tasks", "durable-runs", "history", workspaceId],
  workTasks: (workspaceId: string): TopicKey => ["tasks", "work-tasks", workspaceId],
  runTrace: (runId: string): TopicKey => ["tasks", "durable-run", runId],
  workSessions: (workspaceId: string): TopicKey => ["chat", "work-history", workspaceId],
  workActivity: (workspaceId: string): TopicKey => ["system", "work-activity", workspaceId],
  schedules: (): TopicKey => ["tasks", "schedules"],
  systemActivity: (): TopicKey => ["system", "retained-activity"],
  systemQuality: (): TopicKey => ["quality", "eval-proof-runs"],
  systemDiagnostics: (): TopicKey => ["system", "diagnostics"],
  systemBoards: (workspaceId: string): TopicKey => ["surface", "saved-boards", workspaceId],
};

import type { QueryKey } from "@tanstack/react-query";
import type { RefreshTopic } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { getGatewayApiBaseUrl, getGatewayAccessRevision } from "@goatcitadel/mission-control-shared/api/client-core";

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
  inbox: (workspaceId: string): TopicKey => [
    "approvals",
    "operator-inbox",
    workspaceId,
    getGatewayApiBaseUrl(),
    getGatewayAccessRevision(),
  ],
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
  workActivityAll: (): TopicKey => ["system", "work-activity"],
  workActivity: (workspaceId: string): TopicKey => ["system", "work-activity", workspaceId],
  schedules: (): TopicKey => ["tasks", "schedules"],
  systemActivity: (): TopicKey => ["system", "retained-activity"],
  systemQuality: (): TopicKey => ["quality", "eval-proof-runs"],
  systemDiagnostics: (): TopicKey => ["system", "diagnostics"],
  systemBoards: (workspaceId: string): TopicKey => ["surface", "saved-boards", workspaceId],
};

/**
 * Prefixes of every cockpit query whose reader calls `fetchSettings`. A settings save publishes no settings
 * event of its own, so these refresh from its change plan (see `event-map.ts`). Kept complete by
 * `settings-readers.inventory.test.ts`.
 */
export const SETTINGS_READER_KEYS: readonly QueryKey[] = [
  ["system", "managed-runtime-settings"],
  ["system", "settings-budget-mode"],
  ["system", "settings-approval-mode"],
  ["system", "first-run-defaults"],
  ["settings", "gateway-auth"],
  ["settings", "permission-selection"],
  ["settings", "local-operator-overrides"],
  // Library panels that read settings (engineering learnings; memory editor and proposals).
  ["library", "engineering-settings"],
  ["library", "memory-settings"],
  // Device continuity checks read the Gateway settings too.
  ["settings", "continuity", "settings"],
];

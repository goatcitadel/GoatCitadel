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
  capabilityConnectors: (workspaceId: string): TopicKey => ["mcp", "capability-connectors", workspaceId],
  /** One saved server's own record, read by a connector panel to check it can be switched on. */
  capabilityConnectorServer: (serverId: string): TopicKey => ["mcp", "capability-connector-server", serverId],
  /** One saved server's tool list, shown in its connector panel. */
  capabilityConnectorTools: (serverId: string): TopicKey => ["mcp", "capability-connector-tools", serverId],
  /** The Capabilities tool groups for one workspace. Tool and policy events and Settings change plans refresh it. */
  capabilityTools: (workspaceId: string): TopicKey => ["tools", "capability-tools", workspaceId],
  /**
   * A year of tool call counts. No tool or policy event refreshes it; only a replay gap (which re-reads every `tools`
   * query) and the Tools tab's own refresh do.
   */
  capabilityToolUsage: (): TopicKey => ["tools", "capability-tool-usage"],
  /** The Capabilities installed skills for one workspace. Skill events and Settings change plans refresh it. */
  capabilitySkills: (workspaceId: string): TopicKey => ["skills", "capability-skills", workspaceId],
  /**
   * A year of skill use counts. No event refreshes it; only a replay gap (which re-reads every `skills` query) and the
   * Skills tab's own refresh do.
   */
  capabilitySkillUsage: (): TopicKey => ["skills", "capability-skill-usage"],
  /** One skill's details for its panel. Every workspace's and skill's details share the prefix, so a skill event refreshes them. */
  capabilitySkillDetail: (workspaceId: string, skillId: string): TopicKey => [
    "skills",
    "capability-skill-detail",
    workspaceId,
    skillId,
  ],
  /**
   * The skills on offer to install, for one workspace and one search term (empty without one). Every workspace's and
   * term's read shares the prefix, so a skill event refreshes whichever is open.
   */
  capabilitySkillDiscover: (workspaceId: string, q: string): TopicKey => [
    "skills",
    "capability-skill-discover",
    workspaceId,
    q,
  ],
  /** The installs still on their way in, for one workspace. Skill events and the skip setting refresh it. */
  capabilitySkillInstalls: (workspaceId: string): TopicKey => ["skills", "capability-skill-installs", workspaceId],
  /** One checked skill at whatever step its install is on. It sits under the installs' prefix, so it refreshes with them. */
  capabilitySkillInstall: (workspaceId: string, snapshotId: string): TopicKey => [
    "skills",
    "capability-skill-installs",
    workspaceId,
    snapshotId,
  ],
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
  /** Chat's Messaging area: channel conversations by connection. Every workspace's overview shares the prefix. */
  chatMessagingAll: (): TopicKey => ["chat", "messaging"],
  chatMessaging: (workspaceId: string): TopicKey => ["chat", "messaging", workspaceId],
  /** A channel page's live reads share the Messaging prefix, so connection and channel events refresh them too. */
  chatChannelRuntime: (connectionId: string): TopicKey => ["chat", "messaging", "runtime", connectionId],
  chatChannelSenders: (connectionId: string, revision: string | undefined): TopicKey => [
    "chat",
    "messaging",
    "senders",
    connectionId,
    revision ?? "",
  ],
  /** The channel catalogue the add-channel pages read. It is fixed for a GoatCitadel version, so no event refreshes it. */
  channelSetupDefinitions: () => ["channel-setup", "definitions"] as const,
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
  ["system", "settings-claude-cli-tool-bridge"],
  ["system", "settings-claude-cli-warm-continuation"],
  ["system", "settings-chat-thinking-stream"],
  ["system", "settings-claude-cli-background-jobs"],
  ["system", "settings-web-search"],
  ["system", "settings-approval-mode"],
  ["system", "settings-approval-skip"],
  ["system", "settings-browser-errands"],
  ["system", "settings-filesystem-write-access"],
  ["system", "first-run-defaults"],
  ["settings", "gateway-auth"],
  ["settings", "permission-selection"],
  ["settings", "local-operator-overrides"],
  // Work > Schedules reads the cron review-queue flag before requesting the queue.
  ["work", "schedules-settings"],
  // Library panels that read settings (engineering learnings; memory editor and proposals).
  ["library", "engineering-settings"],
  ["library", "memory-settings"],
  // Device continuity checks read the Gateway settings too.
  ["settings", "continuity", "settings"],
  // The MCP template catalog reads the network allowlist to show which hosts are allowed.
  ["settings", "mcp-template-allowlist"],
  // The Capabilities connector list shows web search keys and Firecrawl, and whether Chat can reach MCP.
  ["mcp", "capability-connectors"],
  // The Capabilities tool list shows which tool groups are switched off, and a group's switch saves through Settings.
  ["tools", "capability-tools"],
  // The Capabilities skill list carries `operatorApprovalSkip`, which decides whether switching a skill on asks the operator.
  ["skills", "capability-skills"],
  // The installs list carries `operatorApprovalSkip` too, which decides whether an install step asks the operator.
  ["skills", "capability-skill-installs"],
];

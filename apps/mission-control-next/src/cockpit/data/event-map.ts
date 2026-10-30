import type { QueryKey } from "@tanstack/react-query";
import type { RealtimeEvent } from "@goatcitadel/mission-control-shared/api/shell-client";
import { deriveRealtimeRefresh } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import type { RefreshTopic } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { queryKeys, SETTINGS_READER_KEYS } from "./query-keys";

/** The cockpit query prefixes an event changes, and the shared refresh-bus topics it signals. */
export interface EventEffect {
  keys: readonly QueryKey[];
  refresh: readonly RefreshTopic[];
}
export type EventResolution =
  | { kind: "mapped"; effect: EventEffect }
  | { kind: "ignored" }
  | { kind: "unmapped"; topics: RefreshTopic[] };

type Rule = (event: RealtimeEvent) => EventEffect | "ignore" | undefined;
const effect = (keys: readonly QueryKey[], refresh: readonly RefreshTopic[]): EventEffect => ({ keys, refresh });

/** Many owners publish `eventType: "system"` and name the real signal in `payload.type`. */
export function realtimeEventKind(event: RealtimeEvent): string {
  const payloadType = event.payload?.type;
  return event.eventType === "system" && typeof payloadType === "string" ? payloadType : event.eventType;
}

/** llama.cpp is allowlisted: process output and unknown future types never refresh health (GL-01, T3-M1). */
const LLAMACPP_STATUS_TYPES = new Set([
  "llamacpp_refreshed",
  "llamacpp_starting",
  "llamacpp_started",
  "llamacpp_stopping",
  "llamacpp_stopped",
  "llamacpp_exited",
  "llamacpp_spawn_error",
  "llamacpp_spawn_cleanup_error",
  "llamacpp_state_persist_failed",
  "llamacpp_idle_shutdown_failed",
]);
const IGNORED_TYPES = new Set([
  "llamacpp_stdout",
  "llamacpp_stderr",
  "mobile_capability_heartbeat",
  "proactive_tick_started",
  "proactive_no_action",
]);

/** A governed settings save moves through a change plan on `runtime_settings`; no settings event exists. */
function changesRuntimeSettings(event: RealtimeEvent): boolean {
  const owner = event.payload?.targetOwnerId;
  return typeof owner === "string" && (owner === "runtime_settings" || owner.startsWith("runtime_settings."));
}

const DIRECTORY_KEYS: readonly QueryKey[] = [
  queryKeys.directory(),
  ["settings", "workspaces"],
  ["settings", "workspace-citadels"],
  ["settings", "citadels"],
];
const TOOL_KEYS: readonly QueryKey[] = [
  queryKeys.capabilities(),
  ["settings", "tool-grants"],
  ["settings", "local-operator-overrides"],
  ["settings", "permission-selection"],
  ["approvals", "workspace-tools-profile"],
  // The Capabilities tool list shows each tool's rules (grants, profile, Ward). The prefix covers every workspace's list
  // but not the call counts, which sit under their own key.
  ["tools", "capability-tools"],
];
// The Capabilities connector list merges MCP servers, integrations, channels and web search, so each owner refreshes it.
// The prefix covers every workspace's list.
const CAPABILITY_CONNECTOR_KEYS: readonly QueryKey[] = [["mcp", "capability-connectors"]];
const MCP_KEYS: readonly QueryKey[] = [
  ...CAPABILITY_CONNECTOR_KEYS,
  // What a connector panel reads about one saved server: its tool list and its own record.
  ["mcp", "capability-connector-tools"],
  ["mcp", "capability-connector-server"],
  queryKeys.capabilities(),
  ["settings", "mcp-servers"],
  ["settings", "mcp-inspection"],
  ["settings", "mcp-requests"],
];
const INTEGRATION_KEYS: readonly QueryKey[] = [
  ...CAPABILITY_CONNECTOR_KEYS,
  ["settings", "integration-connections"],
  queryKeys.healthAll(),
];
/** Connections and inbound channel messages also change Chat's Messaging overview (channels, status, counts). */
const MESSAGING_INTEGRATION_KEYS: readonly QueryKey[] = [...INTEGRATION_KEYS, queryKeys.chatMessagingAll()];
// The Capabilities skill list and a skill's details. The prefixes cover every workspace's list and every skill's details,
// but not the use counts, which sit under their own key.
const CAPABILITY_SKILL_KEYS: readonly QueryKey[] = [
  ["skills", "capability-skills"],
  ["skills", "capability-skill-detail"],
];
// Discover marks a source installed or on its way in, and the installs list holds the installs between their steps;
// a skill change moves both. Hub installs publish no event of their own: the install flow polls.
const CAPABILITY_SKILL_INSTALL_KEYS: readonly QueryKey[] = [
  ["skills", "capability-skill-discover"],
  ["skills", "capability-skill-installs"],
];
const CAPABILITY_KEYS: readonly QueryKey[] = [
  queryKeys.capabilities(),
  ...CAPABILITY_SKILL_KEYS,
  ["capability"],
  queryKeys.inboxAll(),
];

const SYSTEM_SOURCE_TYPES = new Map<string, EventEffect | "ignore">([
  ["workspace_created", effect(DIRECTORY_KEYS, ["system"])],
  ["workspace_updated", effect(DIRECTORY_KEYS, ["system"])],
  ["workspace_archived", effect(DIRECTORY_KEYS, ["system"])],
  ["workspace_restored", effect(DIRECTORY_KEYS, ["system"])],
  ["backup_created", effect([queryKeys.healthAll(), queryKeys.inboxAll()], ["system"])],
  ["guidance_updated", "ignore"],
  ["self_improvement_review", effect([queryKeys.improvement(), queryKeys.inboxAll()], ["improvement"])],
  // The bare contract type with no payload discriminator: signal shared listeners, refetch nothing.
  ["system", effect([], ["system"])],
]);

/** Owner sources. Keys are cockpit query prefixes; owners that feed the Inbox also refresh the Inbox. */
const SOURCE_RULES = new Map<string, Rule>([
  ["operator_inbox", () => undefined], // inbox.changed is handled before the map (needs workspace scope)
  // An approval tied to a conversation changes the status the Chat rail shows for it.
  ["approvals", (e) => effect([["approvals"]], e.links?.sessionId ? ["approvals", "chat"] : ["approvals"])],
  ["auth", () => effect([["approvals"], ["settings", "device-grants"]], ["approvals"])],
  ["chat", () => effect([["chat"]], ["chat"])],
  ["chat.timer", () => effect([["chat"]], ["chat"])],
  [
    "gateway",
    (e) =>
      e.eventType === "shared_host_lifecycle"
        ? effect([queryKeys.healthAll()], ["system"])
        : effect([["chat"]], ["chat"]),
  ],
  ["llm", () => effect([["system", "onboarding"]], ["system", "chat"])],
  ["onboarding", () => effect([["system", "onboarding"]], ["system"])],
  ["tasks", () => effect([["tasks"]], ["tasks"])],
  ["durable", () => effect([["tasks"], queryKeys.inboxAll()], ["tasks"])],
  ["orchestration", () => effect([["tasks"]], ["tasks"])],
  ["assembly", () => effect([["tasks"]], ["tasks"])],
  ["cron", () => effect([queryKeys.schedules(), ["cockpit", "schedule"]], ["tasks"])],
  ["connectors", () => effect([["tasks"]], ["tasks"])],
  ["memory", () => effect([queryKeys.memory(), ["library", "resources", "memory"], queryKeys.inboxAll()], ["memory"])],
  ["improvement", () => effect([queryKeys.improvement(), queryKeys.inboxAll()], ["improvement"])],
  ["curator", () => effect(CAPABILITY_KEYS, ["skills"])],
  [
    "evolution_control_plane",
    (e) =>
      effect(
        [queryKeys.inboxAll(), ["change-plan"], ...(changesRuntimeSettings(e) ? SETTINGS_READER_KEYS : [])],
        ["approvals"],
      ),
  ],
  ["capabilities", () => effect(CAPABILITY_KEYS, ["skills"])],
  // A switch asking for approval and a change applying both publish here, so they refresh the list and the details,
  // and the Inbox, where a skill approval waits in every workspace (its creation publishes no `approvals` event).
  [
    "skills",
    () =>
      effect(
        [queryKeys.capabilities(), ...CAPABILITY_SKILL_KEYS, ...CAPABILITY_SKILL_INSTALL_KEYS, queryKeys.inboxAll()],
        ["skills"],
      ),
  ],
  // A tool call inside a turn changes no catalog or grant; the turn's own chat events carry it.
  ["tools", (e) => (e.eventType === "tool_invoked" ? effect([], ["tools"]) : effect(TOOL_KEYS, ["tools"]))],
  ["policy", (e) => (e.eventType === "tool_invoked" ? effect([], ["tools"]) : effect(TOOL_KEYS, ["tools"]))],
  ["mcp", (e) => (e.eventType === "tool_invoked" ? effect([], ["mcp"]) : effect(MCP_KEYS, ["mcp"]))],
  ["agents", () => effect([queryKeys.capabilities(), ["work", "active-agents"]], ["agents"])],
  [
    "files",
    () =>
      effect(
        [
          ["library", "resources", "files"],
          ["library", "resources", "artifacts"],
        ],
        ["files"],
      ),
  ],
  // A connection created, updated or deleted in Settings is published here (payload.type integration_connection_*).
  // It changes a channel's status and the channel list in Chat's Messaging area.
  ["integrations", () => effect(MESSAGING_INTEGRATION_KEYS, ["integrations"])],
  // The channels source carries inbound messages (channel_message_ingested), which change a conversation's time and
  // new-message count in Messaging. Other conversation updates arrive as `chat` events, whose ["chat"] prefix
  // already covers the Messaging overview.
  ["channels", () => effect(MESSAGING_INTEGRATION_KEYS, ["integrations"])],
  ["hooks", () => effect([["settings", "integration-connections"]], ["integrations"])],
  ["mesh", () => effect([queryKeys.capabilities()], ["system"])],
  ["voice", () => effect([["settings", "voice-runtime"]], ["system"])],
  ["npu", () => effect([queryKeys.healthAll()], ["npu"])],
  [
    "llamacpp",
    (e) =>
      LLAMACPP_STATUS_TYPES.has(realtimeEventKind(e)) ? effect([queryKeys.healthAll()], ["llamaCpp"]) : undefined,
  ],
  ["promptLab", () => effect([["quality"]], ["quality"])],
  [
    "ops_saved_boards",
    () =>
      effect(
        [
          ["surface", "saved-boards"],
          ["surface", "saved-board"],
        ],
        ["dashboard"],
      ),
  ],
  ["remote_workers", () => effect([queryKeys.healthAll()], ["system"])],
  [
    "system",
    (e) => {
      const kind = realtimeEventKind(e);
      if (kind.startsWith("addon_")) return effect([queryKeys.capabilities()], ["skills"]);
      return SYSTEM_SOURCE_TYPES.get(kind) ?? SYSTEM_SOURCE_TYPES.get(e.eventType);
    },
  ],
]);
export const IGNORED_SOURCES: ReadonlySet<string> = new Set(["notifications", "mobile"]);
export const MAPPED_SOURCES: ReadonlySet<string> = new Set(SOURCE_RULES.keys());

/** Every topic the shared stream refreshes after a replay gap ("surface" is the removed catch-all). */
const REPLAY_GAP_TOPICS: readonly RefreshTopic[] = [
  "chat",
  "approvals",
  "tasks",
  "system",
  "skills",
  "memory",
  "improvement",
  "integrations",
  "files",
  "quality",
  "tools",
  "mcp",
  "agents",
  "npu",
  "llamaCpp",
  "dashboard",
];
const REPLAY_GAP_EFFECT = effect(
  [
    ...REPLAY_GAP_TOPICS.map((topic): QueryKey => [topic]),
    ["capability"],
    ["change-plan"],
    ["library"],
    ["settings"],
    ["surface"],
    ["cockpit"],
    ["work"],
  ],
  REPLAY_GAP_TOPICS,
);

/** Resolves a live event to what it changes. Unknown sources fall back to keyword topics, never a catch-all. */
export function resolveRealtimeEvent(event: RealtimeEvent): EventResolution {
  if (event.payload?.kind === "replay_gap") return { kind: "mapped", effect: REPLAY_GAP_EFFECT };
  if (event.eventAuthority === "durable_history") return { kind: "ignored" };
  if (IGNORED_TYPES.has(realtimeEventKind(event)) || IGNORED_SOURCES.has(event.source)) return { kind: "ignored" };
  const result = SOURCE_RULES.get(event.source)?.(event);
  if (result === "ignore") return { kind: "ignored" };
  if (result) return { kind: "mapped", effect: result };
  const topics = deriveRealtimeRefresh(event).topics.filter((topic) => topic !== "surface");
  return { kind: "unmapped", topics };
}

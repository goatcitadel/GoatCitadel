import {
  CAPABILITY_CONNECTOR_GROUP_ORDER,
  capMcpApprovalPosture,
  type McpApprovalPosture,
  type CapabilityConnectorCategory,
  type CapabilityConnectorChatBlock,
  type CapabilityConnectorGroup,
  type CapabilityConnectorItem,
  type CapabilityConnectorKind,
  type CapabilityConnectorReason,
  type CapabilityConnectorState,
} from "@goatcitadel/contracts";
import type { StatusPresentation, StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { CategoryOption } from "../CategoryFilter";
import { isActiveInstallState, type ConnectorInstallState } from "./connector-install-store";

// Wording and ordering for the list the Gateway already built. Nothing here decides what a row is.

const GROUP_LABELS: Readonly<Record<CapabilityConnectorGroup, string>> = {
  connected: "Connected",
  on_this_device: "On this device",
  available: "Available",
  turned_off: "Turned off",
};

const KIND_LABELS: Readonly<Record<CapabilityConnectorKind, string>> = {
  built_in: "Built in",
  mcp: "MCP",
  channel: "Channel",
};

const CATEGORY_LABELS: Readonly<Record<CapabilityConnectorCategory, string>> = {
  development: "Development",
  browser: "Browser",
  automation: "Automation",
  research: "Research",
  data: "Data",
  creative: "Creative",
  messaging: "Messaging",
  search: "Search",
  orchestration: "Orchestration",
  other: "Other",
};

/** The order of the category buttons. Only categories that have rows are shown. */
const CATEGORY_ORDER: readonly CapabilityConnectorCategory[] = [
  "development",
  "browser",
  "automation",
  "research",
  "data",
  "creative",
  "messaging",
  "search",
  "orchestration",
  "other",
];

/** The search suggestion when nothing is connected yet. */
const FALLBACK_SUGGESTION = "automation";

const STATE_LABELS: Readonly<Record<CapabilityConnectorState, string>> = {
  connected: "Connected",
  needs_sign_in: "Needs sign-in",
  sign_in_expired: "Sign-in expired",
  broken: "Not working",
  available: "Available",
  turned_off: "Turned off",
};

const STATE_TONES: Readonly<Record<CapabilityConnectorState, StatusTone>> = {
  connected: "done",
  needs_sign_in: "waiting",
  sign_in_expired: "waiting",
  broken: "failed",
  available: "neutral",
  turned_off: "neutral",
};

const REASON_LINES: Readonly<Record<CapabilityConnectorReason, string>> = {
  ready: "Ready to use",
  not_connected: "Not connected yet",
  sign_in_needed: "Sign in to finish setup",
  sign_in_expired: "Sign in again to keep using it",
  error: "Stopped working; open it to see why",
  turned_off: "Switched off",
  not_installed: "Not installed",
  needs_api_key: "Needs an API key",
  missing_sign_in_setup: "Sign-in isn't set up for this app yet",
};

/** What the panel says instead of the row's line. The row's "open it to see why" would send the panel back to itself. */
const PANEL_REASON_LINES: Readonly<Partial<Record<CapabilityConnectorReason, string>>> = {
  error: "Stopped working.",
};

/** Why a hidden row's AI can't use it, said in place of its reason. */
const HIDDEN_REASON = "The AI can't use it in this workspace";

/** Added to the panel's broken line only when Technical details is on the page and holds the error. */
const LAST_ERROR_POINTER = " The last error is under Technical details.";

const CHAT_BLOCK_LINES: Readonly<Record<CapabilityConnectorChatBlock, string>> = {
  mcp_in_chat_off: "Chat can't use connectors yet.",
  background_runs_off: "Chat can't use connectors while background runs are off.",
};

/**
 * The "what asks first" setting the Gateway decides a saved server's calls by, read from fields it already sent. None
 * (so everything asks) where the setting can never apply: on an install that never lets a call run on its own, or for
 * a server whose tools are listed per chat. A connector that can move money has a saved "Nothing asks" counted as
 * "Reading is free".
 */
export function approvalPostureInEffect(
  item: CapabilityConnectorItem,
  reliefAvailable: boolean,
): McpApprovalPosture | undefined {
  if (!reliefAvailable || item.requesterScoped === true) return undefined;
  return capMcpApprovalPosture(item.approvalPosture, item.movesMoney === true);
}

/** Why Chat can't use connectors, as a sentence. Without a named cause it is the general one. */
export function chatBlockLine(blockedBy: CapabilityConnectorChatBlock | undefined): string {
  return CHAT_BLOCK_LINES[blockedBy ?? "mcp_in_chat_off"];
}

export function connectorKindLabel(kind: CapabilityConnectorKind): string {
  return KIND_LABELS[kind];
}

export function connectorCategoryLabel(category: CapabilityConnectorCategory): string {
  return CATEGORY_LABELS[category];
}

/** The category buttons for the rows loaded, in a fixed order. */
export function connectorCategoryOptions(items: readonly CapabilityConnectorItem[]): CategoryOption[] {
  const present = new Set<string>(items.map((entry) => entry.category));
  return CATEGORY_ORDER.filter((category) => present.has(category)).map((category) => ({
    id: category,
    label: CATEGORY_LABELS[category],
  }));
}

/** What the search box suggests: the first connected row's category, or "automation" when there is none. */
export function connectorSearchSuggestion(items: readonly CapabilityConnectorItem[]): string {
  // A connected search row (Firecrawl) would suggest "Search", which says nothing about what to type.
  const first = items.find((entry) => entry.state === "connected" && entry.category !== "search");
  return first ? CATEGORY_LABELS[first.category] : FALLBACK_SUGGESTION;
}

/**
 * Keeps the rows that match the search text (name, description, category and kind as they are shown, ignoring case)
 * and, when any category is chosen, one of the chosen categories.
 */
export function filterConnectors(
  items: readonly CapabilityConnectorItem[],
  filters: { query: string; categories: readonly string[] },
): CapabilityConnectorItem[] {
  const needle = filters.query.trim().toLowerCase();
  return items.filter((entry) => {
    if (filters.categories.length > 0 && !filters.categories.includes(entry.category)) return false;
    if (!needle) return true;
    const haystack = [entry.name, entry.description, CATEGORY_LABELS[entry.category], KIND_LABELS[entry.kind]]
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** The groups in their fixed order, without the empty ones. Rows keep the order the Gateway sent them in. */
export function groupConnectors(
  items: readonly CapabilityConnectorItem[],
): { group: CapabilityConnectorGroup; label: string; items: CapabilityConnectorItem[] }[] {
  return CAPABILITY_CONNECTOR_GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: items.filter((entry) => entry.group === group),
  })).filter((entry) => entry.items.length > 0);
}

/**
 * The state badge and the reason line under it. A row never reads as plainly usable when the AI can't use it: a
 * connected MCP row that Chat can't reach says so, and a row hidden in this workspace says that instead of its reason
 * ("Ready to use" beside "Hidden in this workspace" would contradict itself). A hidden row that is connected reads as
 * hidden alone; one that is not connected keeps its state word beside the note, so "Not working" is not lost.
 * `where` is the surface: the panel words the broken reason without pointing at itself, and points at Technical details
 * only when the operator shows them (`technicalDetailsShown`) and there is an error to read there.
 */
export function presentConnectorState(
  item: CapabilityConnectorItem,
  where: "row" | "panel" = "row",
  { technicalDetailsShown = false }: { technicalDetailsShown?: boolean } = {},
): StatusPresentation & { reason: string } {
  const chatBlocked = item.state === "connected" && !item.chat.available;
  const hiddenOnly = item.hiddenInWorkspace && item.state === "connected";
  const label = hiddenOnly
    ? "Hidden in this workspace"
    : item.hiddenInWorkspace
      ? `${STATE_LABELS[item.state]} · hidden in this workspace`
      : STATE_LABELS[item.state];
  // Green says "usable". A connection Chat can't use yet asks for a look, and a hidden connected row is neither good
  // nor bad. Any other state keeps its own tone.
  const tone: StatusTone = hiddenOnly ? "neutral" : chatBlocked ? "waiting" : STATE_TONES[item.state];
  const panelLine = where === "panel" ? PANEL_REASON_LINES[item.reason] : undefined;
  const pointer = panelLine && technicalDetailsShown && item.lastError ? LAST_ERROR_POINTER : "";
  const reason = item.hiddenInWorkspace
    ? HIDDEN_REASON
    : chatBlocked
      ? "Connected · not available in Chat"
      : panelLine
        ? `${panelLine}${pointer}`
        : REASON_LINES[item.reason];
  return { label, tone, reason };
}

/**
 * What a finished connect announces (M10): connected, and whether the AI can use it, as the row reads once the list
 * catches up, so a Chat or workspace limit is never left out of a plain "Connected.".
 */
export function connectedAnnouncement(item: Pick<CapabilityConnectorItem, "hiddenInWorkspace" | "chat">): string {
  if (item.hiddenInWorkspace) return `Connected. ${HIDDEN_REASON}.`;
  if (!item.chat.available) return "Connected. Not available in Chat.";
  return `Connected. ${REASON_LINES.ready}.`;
}

/**
 * A row whose install flow is running says so instead of its own reason (R87), read from the flow, never moving it.
 * A flow that waits on the operator says so in the waiting tone: "Waiting on you in Inbox" for its approval, "Waiting
 * on you to sign in" while its sign-in page is open (M6). Any other running phase reads "Installing" on a template row
 * and "Connecting" on a saved server, whose flow may be its own sign-in or connect rather than an install; both in the
 * running tone, so the row never looks ready while it isn't. The badge keeps the row's own state word, and a finished,
 * failed or stopped flow leaves the row as the list has it.
 */
export function withInstallProgress(
  item: CapabilityConnectorItem,
  state: StatusPresentation & { reason: string },
  flow: ConnectorInstallState,
): StatusPresentation & { reason: string } {
  if (flow.phase === "waiting_inbox") return { ...state, tone: "waiting", reason: "Waiting on you in Inbox" };
  if (flow.phase === "signing_in") return { ...state, tone: "waiting", reason: "Waiting on you to sign in" };
  if (!isActiveInstallState(flow)) return state;
  return { ...state, tone: "running", reason: item.source === "mcp_server" ? "Connecting" : "Installing" };
}

/** Said under an on-device program's command: it runs outside the Gateway's own network rules. */
export const ON_DEVICE_NETWORK_WARNING = "This program's own internet access isn't limited by your network allowlist.";

export interface ConnectionDescription {
  /** Plain sentences, for example "Signs in at mcp.linear.app". */
  lines: string[];
  /** The exact command line, only for a program that runs on this computer. */
  command?: string;
  warning?: string;
}

/**
 * "How it connects": where it signs in, what key it needs, or that it runs here. The sign-in host is the first host
 * the Gateway lists for the app.
 */
export function describeConnection(item: CapabilityConnectorItem): ConnectionDescription {
  if (item.runsOnThisDevice) {
    return {
      lines: ["Runs on this computer", ...(item.auth === "api_key" ? ["Needs an API key"] : [])],
      ...(item.command ? { command: item.command } : {}),
      warning: ON_DEVICE_NETWORK_WARNING,
    };
  }
  // A web search row that is on, off or failing is set up in the web search settings. Self-hosted Firecrawl works with
  // no key, so "Needs an API key" is true only for the row that is still waiting on one.
  if (item.source === "web_search" && item.state !== "available") {
    return { lines: ["Uses your web search settings"] };
  }
  const host = item.networkHosts[0];
  switch (item.auth) {
    case "api_key":
      return { lines: ["Needs an API key"] };
    case "bot_token":
      return { lines: ["Needs a bot token"] };
    case "oauth":
      return { lines: [host ? `Signs in at ${host}` : "Signs in with your account"] };
    case "google":
      return { lines: ["Signs in with your Google account"] };
    case "none":
      return { lines: [host ? `Connects to ${host}` : "Needs no sign-in"] };
  }
}

export type ConnectorActionKind =
  | "install"
  | "set_up"
  | "connect"
  | "reconnect"
  | "try_again"
  | "turn_back_on"
  | "manage";

/**
 * The one button on a row. Every action opens the row's panel, where the action itself runs. Only an MCP template that
 * isn't installed yet offers Install: one that needs an API key or a sign-in setup is set up in Advanced setup, and
 * other available rows (services, web search keys) have no install of their own.
 */
export function connectorAction(item: CapabilityConnectorItem): { kind: ConnectorActionKind; label: string } {
  switch (item.state) {
    case "connected":
      return { kind: "manage", label: "Manage" };
    case "broken":
      return { kind: "try_again", label: "Try again" };
    case "sign_in_expired":
      return { kind: "reconnect", label: "Reconnect" };
    case "needs_sign_in":
      return { kind: "connect", label: "Connect" };
    case "turned_off":
      return { kind: "turn_back_on", label: "Turn back on" };
    case "available":
      return item.source === "mcp_template" && item.reason === "not_installed"
        ? { kind: "install", label: "Install" }
        : { kind: "set_up", label: "Set up" };
  }
}

// The letter icon's colour pick moved to a file both tabs share (so the Tools tab doesn't load the install store).
export { LETTER_ICON_TONE_COUNT, letterIconTone } from "../letter-icon-tone";

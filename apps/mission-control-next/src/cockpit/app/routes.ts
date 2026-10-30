export type CockpitArea = "chat" | "inbox" | "work" | "capabilities" | "library" | "system" | "settings" | "gallery";

export const COCKPIT_AREAS = [
  { area: "chat", label: "Chat", path: "/chat", shortcut: "c" },
  { area: "inbox", label: "Inbox", path: "/inbox", shortcut: "i" },
  { area: "work", label: "Work", path: "/work", shortcut: "w" },
  { area: "capabilities", label: "Capabilities", path: "/capabilities", shortcut: "a" },
  { area: "library", label: "Library", path: "/library", shortcut: "l" },
  { area: "system", label: "System", path: "/system", shortcut: "s" },
] as const satisfies readonly { area: CockpitArea; label: string; path: string; shortcut: string }[];

export const COCKPIT_AREA_SHORTCUTS = [
  ...COCKPIT_AREAS,
  { area: "settings", label: "Settings", path: "/settings", shortcut: "t" },
] as const;

const AREA_BY_SEGMENT: Readonly<Record<string, CockpitArea>> = {
  chat: "chat",
  projects: "chat",
  inbox: "inbox",
  work: "work",
  capabilities: "capabilities",
  library: "library",
  system: "system",
  ops: "system",
  settings: "settings",
  __gallery: "gallery",
};

export function parseCockpitLocation(pathname: string): { area: CockpitArea; rest: string[] } {
  const segments = pathname.split("/").filter(Boolean);
  return { area: AREA_BY_SEGMENT[segments[0] ?? ""] ?? "chat", rest: segments.slice(1) };
}

const CHANNEL_PAGE_SEGMENT = "messaging";

/** The page for one connected channel, shown in Chat beside its Messaging list. */
export function channelPageHref(connectionId: string): string {
  return `/chat/${CHANNEL_PAGE_SEGMENT}/${encodeURIComponent(connectionId)}`;
}

/** The segment after `messaging` that opens the add-channel views instead of naming a connection. */
const ADD_SEGMENT = "add";
/** The segment after `messaging` that opens Advanced channel setup instead of naming a connection. */
const ADVANCED_SEGMENT = "advanced";
const KEY_SEGMENT = "key";
/** A channel's catalog key: lowercase letters, digits and hyphens, starting with a letter. */
const CHANNEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

/** The views Chat's Messaging area can show in place of a conversation. */
export type MessagingView =
  | { kind: "channel"; connectionId: string }
  | { kind: "picker" }
  | { kind: "setup"; channelKey: string; draftId?: string }
  | { kind: "change_key"; connectionId: string }
  | { kind: "advanced" };

/** The query parameter naming the unfinished setup a channel's setup page goes on with. */
const SETUP_DRAFT_PARAM = "draft";

/** The page for choosing a channel to add. */
export function channelPickerHref(): string {
  return `/chat/${CHANNEL_PAGE_SEGMENT}/${ADD_SEGMENT}`;
}

/** The setup page for one channel, named by its catalog key; given a draft, the page goes on with that setup. */
export function channelSetupHref(channelKey: string, draftId?: string): string {
  const page = `/chat/${CHANNEL_PAGE_SEGMENT}/${ADD_SEGMENT}/${encodeURIComponent(channelKey)}`;
  return draftId ? `${page}?${new URLSearchParams({ [SETUP_DRAFT_PARAM]: draftId })}` : page;
}

/** The page for replacing one connected channel's key. */
export function channelKeyChangeHref(connectionId: string): string {
  return `/chat/${CHANNEL_PAGE_SEGMENT}/${encodeURIComponent(connectionId)}/${KEY_SEGMENT}`;
}

/** The query parameter Advanced channel setup reads to open a new setup of that channel (its catalog id). */
const ADVANCED_CHANNEL_PARAM = "channel";

/**
 * Advanced channel setup: every channel's full settings and the public web address. Given a channel's catalog id, it
 * opens with a new setup of that channel chosen.
 */
export function channelAdvancedSetupHref(catalogId?: string): string {
  const page = `/chat/${CHANNEL_PAGE_SEGMENT}/${ADVANCED_SEGMENT}`;
  return catalogId ? `${page}?${new URLSearchParams({ [ADVANCED_CHANNEL_PARAM]: catalogId })}` : page;
}

/** Capabilities › Connectors › Advanced setup: the full editors for MCP servers, integrations and web search. */
export const CONNECTOR_SETUP_PATH = "/capabilities/connectors/advanced";

/** The sections of Advanced setup, by the Settings section id each editor kept. */
export type ConnectorSetupSection = "mcp" | "integrations" | "web-search";

const CONNECTOR_SETUP_ANCHORS: Readonly<Record<ConnectorSetupSection, string>> = {
  mcp: "mcp-servers",
  integrations: "integration-connections",
  "web-search": "web-search",
};

/** Advanced setup, opened on one section when one is named. */
export function connectorSetupHref(section?: ConnectorSetupSection): string {
  return section ? `${CONNECTOR_SETUP_PATH}#${CONNECTOR_SETUP_ANCHORS[section]}` : CONNECTOR_SETUP_PATH;
}

/** An id that is not blank, padded or holding control characters. */
function readableId(id: string): string | null {
  // eslint-disable-next-line no-control-regex -- ids with control characters are never a record this page can name.
  return id && id.trim() === id && !/[\u0000-\u001f\u007f]/u.test(id) ? id : null;
}

/** A connection id read from a path segment: not blank, padded or holding control characters. */
function readableConnectionId(segment: string): string | null {
  try {
    return readableId(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** The one readable draft a setup address names, if it names exactly one. */
function setupDraftId(search: string): string | undefined {
  const named = new URLSearchParams(search).getAll(SETUP_DRAFT_PARAM);
  return named.length === 1 ? (readableId(named[0]!) ?? undefined) : undefined;
}

/**
 * The Messaging view a Chat route names, or null when it names none:
 * - `messaging/<connectionId>` is that channel's page, with the id readable;
 * - `messaging/add` is the picker, and `messaging/add/<channelKey>` that channel's setup, with a well-formed key
 *   (and, when `?draft=` names one readable setup, that setup to go on with);
 * - `messaging/<connectionId>/key` is the page for changing that channel's key;
 * - `messaging/advanced` is Advanced channel setup (so, like `add`, it never names a connection).
 * Anything else, including extra segments, is not a Messaging view.
 */
export function messagingView(rest: readonly string[], search = ""): MessagingView | null {
  if (rest[0] !== CHANNEL_PAGE_SEGMENT) return null;
  const [, second, third] = rest;
  if (second === undefined || rest.length > 3) return null;
  if (second === ADVANCED_SEGMENT) return rest.length === 2 ? { kind: "advanced" } : null;
  if (second === ADD_SEGMENT) {
    if (rest.length === 2) return { kind: "picker" };
    if (third === undefined || !CHANNEL_KEY_PATTERN.test(third)) return null;
    const draftId = setupDraftId(search);
    return { kind: "setup", channelKey: third, ...(draftId ? { draftId } : {}) };
  }
  const connectionId = readableConnectionId(second);
  if (connectionId === null) return null;
  if (rest.length === 2) return { kind: "channel", connectionId };
  return third === KEY_SEGMENT ? { kind: "change_key", connectionId } : null;
}

/**
 * The connection a Chat route names as a channel page: exactly `messaging/<connectionId>`, with the id readable (not
 * blank, padded or holding control characters). Anything else is not a channel page, including `messaging/add`,
 * which opens the picker.
 */
export function channelPageConnectionId(rest: readonly string[]): string | null {
  const view = messagingView(rest);
  return view?.kind === "channel" ? view.connectionId : null;
}

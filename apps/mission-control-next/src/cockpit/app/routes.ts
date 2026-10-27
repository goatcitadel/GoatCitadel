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
const KEY_SEGMENT = "key";
/** A channel's catalog key: lowercase letters, digits and hyphens, starting with a letter. */
const CHANNEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

/** The views Chat's Messaging area can show in place of a conversation. */
export type MessagingView =
  | { kind: "channel"; connectionId: string }
  | { kind: "picker" }
  | { kind: "setup"; channelKey: string }
  | { kind: "change_key"; connectionId: string };

/** The page for choosing a channel to add. */
export function channelPickerHref(): string {
  return `/chat/${CHANNEL_PAGE_SEGMENT}/${ADD_SEGMENT}`;
}

/** The setup page for one channel, named by its catalog key. */
export function channelSetupHref(channelKey: string): string {
  return `/chat/${CHANNEL_PAGE_SEGMENT}/${ADD_SEGMENT}/${encodeURIComponent(channelKey)}`;
}

/** The page for replacing one connected channel's key. */
export function channelKeyChangeHref(connectionId: string): string {
  return `/chat/${CHANNEL_PAGE_SEGMENT}/${encodeURIComponent(connectionId)}/${KEY_SEGMENT}`;
}

/** A connection id read from a path segment: not blank, padded or holding control characters. */
function readableConnectionId(segment: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- ids with control characters are never a record this page can name.
  return id && id.trim() === id && !/[\u0000-\u001f\u007f]/u.test(id) ? id : null;
}

/**
 * The Messaging view a Chat route names, or null when it names none:
 * - `messaging/<connectionId>` is that channel's page, with the id readable;
 * - `messaging/add` is the picker, and `messaging/add/<channelKey>` that channel's setup, with a well-formed key;
 * - `messaging/<connectionId>/key` is the page for changing that channel's key.
 * Anything else, including extra segments, is not a Messaging view.
 */
export function messagingView(rest: readonly string[]): MessagingView | null {
  if (rest[0] !== CHANNEL_PAGE_SEGMENT) return null;
  const [, second, third] = rest;
  if (second === undefined || rest.length > 3) return null;
  if (second === ADD_SEGMENT) {
    if (rest.length === 2) return { kind: "picker" };
    return third !== undefined && CHANNEL_KEY_PATTERN.test(third) ? { kind: "setup", channelKey: third } : null;
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

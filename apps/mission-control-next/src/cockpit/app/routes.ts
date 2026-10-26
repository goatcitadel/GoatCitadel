export type CockpitArea = "chat" | "inbox" | "work" | "library" | "system" | "settings" | "gallery";

export const COCKPIT_AREAS = [
  { area: "chat", label: "Chat", path: "/chat", shortcut: "c" },
  { area: "inbox", label: "Inbox", path: "/inbox", shortcut: "i" },
  { area: "work", label: "Work", path: "/work", shortcut: "w" },
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

/**
 * The connection a Chat route names as a channel page: exactly `messaging/<connectionId>`, with the id readable (not
 * blank, padded or holding control characters). Anything else is not a channel page.
 */
export function channelPageConnectionId(rest: readonly string[]): string | null {
  if (rest.length !== 2 || rest[0] !== CHANNEL_PAGE_SEGMENT) return null;
  let id: string;
  try {
    id = decodeURIComponent(rest[1]!);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- ids with control characters are never a record this page can name.
  return id && id.trim() === id && !/[\u0000-\u001f\u007f]/u.test(id) ? id : null;
}

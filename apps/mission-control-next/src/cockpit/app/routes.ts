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

export type CockpitArea = "chat" | "inbox" | "work" | "library" | "system" | "settings" | "gallery";

export const COCKPIT_AREAS = [
  { area: "chat", label: "Chat", path: "/chat", shortcut: "1" },
  { area: "inbox", label: "Inbox", path: "/inbox", shortcut: "2" },
  { area: "work", label: "Work", path: "/work", shortcut: "3" },
  { area: "library", label: "Library", path: "/library", shortcut: "4" },
  { area: "system", label: "System", path: "/system", shortcut: "5" },
] as const satisfies readonly { area: CockpitArea; label: string; path: string; shortcut: string }[];

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

import { navigationRailItems, RAIL_GROUPS, RAIL_ITEMS } from "../../app/route-model";

type RouteModelArea = "settings" | "library" | "ops";

/** Cockpit areas whose sections the route model names; Work's compatibility slugs (kanban) use the Ops labels. */
const ROUTE_MODEL_AREAS: Readonly<Record<string, { area: RouteModelArea }>> = {
  settings: { area: "settings" },
  library: { area: "library" },
  work: { area: "ops" },
};

/**
 * The cockpit's own tab labels (SystemArea and WorkArea VIEWS), so the title matches the tab the operator clicked:
 * System › Spend is "Spend", not the Classic "Costs", and Browser sessions is not Sessions. Keep in step with those tabs.
 */
const COCKPIT_TAB_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  system: {
    health: "Health",
    runtime: "Runtime",
    spend: "Spend",
    quality: "Quality",
    diagnostics: "Diagnostics",
    activity: "Activity",
    sessions: "Sessions",
    dashboards: "Dashboards",
    "browser-sessions": "Browser sessions",
    improvement: "Improvement",
  },
  work: {
    board: "Board",
    history: "History",
    schedules: "Schedules",
    archive: "Archived tasks",
    automation: "Automation designer",
  },
};

/** "GoatCitadel Inbox", "GoatCitadel Settings · Get started": the same prefix and labels the classic shell uses. */
export function cockpitDocumentTitle(areaLabel: string, section?: string, area?: string): string {
  const slug = section ? decodeSection(section) : "";
  const sectionLabel = slug ? (routeModelLabel(area, slug) ?? humanizeSection(slug)) : "";
  return sectionLabel ? `GoatCitadel ${areaLabel} · ${sectionLabel}` : `GoatCitadel ${areaLabel}`;
}

function routeModelLabel(area: string | undefined, section: string): string | undefined {
  const tabs = area ? COCKPIT_TAB_LABELS[area] : undefined;
  if (tabs && Object.hasOwn(tabs, section)) return tabs[section];
  const mapping = area ? ROUTE_MODEL_AREAS[area] : undefined;
  if (!mapping) return undefined;
  // Settings URLs name a page (rail group) first: `/settings/citadel` is the Citadel page, not the Mason section.
  if (mapping.area === "settings") {
    const page = RAIL_GROUPS.settings?.find((group) => group.id === `settings-${section}`);
    if (page) return page.label;
  }
  const items = mapping.area === "settings" ? navigationRailItems("settings") : RAIL_ITEMS[mapping.area];
  return items.find((item) => item.section === section)?.label;
}

function decodeSection(section: string): string {
  try {
    return decodeURIComponent(section);
  } catch {
    return section;
  }
}

function humanizeSection(section: string): string {
  const words = section.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

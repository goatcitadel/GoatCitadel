import { navigationRailItems, RAIL_GROUPS, RAIL_ITEMS } from "../../app/route-model";

type RouteModelArea = "settings" | "library" | "ops";

/** Cockpit areas whose sections the route model names; cockpit-only System views map onto their Ops sections. */
const ROUTE_MODEL_AREAS: Readonly<
  Record<string, { area: RouteModelArea; aliases?: Readonly<Record<string, string>> }>
> = {
  settings: { area: "settings" },
  library: { area: "library" },
  system: { area: "ops", aliases: { spend: "costs", dashboards: "boards", "browser-sessions": "sessions" } },
  work: { area: "ops" },
};

/** "GoatCitadel Inbox", "GoatCitadel Settings · Get started": the same prefix and labels the classic shell uses. */
export function cockpitDocumentTitle(areaLabel: string, section?: string, area?: string): string {
  const slug = section ? decodeSection(section) : "";
  const sectionLabel = slug ? (routeModelLabel(area, slug) ?? humanizeSection(slug)) : "";
  return sectionLabel ? `GoatCitadel ${areaLabel} · ${sectionLabel}` : `GoatCitadel ${areaLabel}`;
}

function routeModelLabel(area: string | undefined, section: string): string | undefined {
  const mapping = area ? ROUTE_MODEL_AREAS[area] : undefined;
  if (!mapping) return undefined;
  // Settings URLs name a page (rail group) first: `/settings/citadel` is the Citadel page, not the Mason section.
  if (mapping.area === "settings") {
    const page = RAIL_GROUPS.settings?.find((group) => group.id === `settings-${section}`);
    if (page) return page.label;
  }
  const target = mapping.aliases?.[section] ?? section;
  const items = mapping.area === "settings" ? navigationRailItems("settings") : RAIL_ITEMS[mapping.area];
  return items.find((item) => item.section === target)?.label;
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

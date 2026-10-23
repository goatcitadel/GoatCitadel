import { navigationRailItems, RAIL_GROUPS, RAIL_ITEMS } from "../../app/route-model";
import { SYSTEM_IMPROVEMENT_VIEW, SYSTEM_VIEWS } from "../areas/system/system-views";
import { WORK_VIEWS } from "../areas/work/work-views";

type RouteModelArea = "settings" | "library" | "ops";

/** Cockpit areas whose sections the route model names; Work's compatibility slugs (kanban) use the Ops labels. */
const ROUTE_MODEL_AREAS: Readonly<Record<string, { area: RouteModelArea }>> = {
  settings: { area: "settings" },
  library: { area: "library" },
  work: { area: "ops" },
};

const labelsById = (views: ReadonlyArray<{ id: string; label: string }>) =>
  Object.fromEntries(views.map((view) => [view.id, view.label]));

/**
 * The cockpit's own tab labels, read from the same lists the System and Work tab rows use, so the title matches the
 * tab the operator clicked: System › Spend is "Spend", not the Classic "Costs", and Browser sessions is not Sessions.
 */
const COCKPIT_TAB_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  system: labelsById([...SYSTEM_VIEWS, SYSTEM_IMPROVEMENT_VIEW]),
  work: labelsById(WORK_VIEWS),
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

import {
  getRouteReleaseStatus,
  isPrimaryRailRoute,
  RAIL_ITEMS,
  type AppRoute,
  type ReleaseSurfaceStatus,
} from "../../../app/route-model";
import { CONNECTOR_SETUP_SECTIONS, cockpitSettingsGroups, settingsSectionHref } from "./settings-route-homes";
export { CONNECTOR_SETUP_SECTIONS } from "./settings-route-homes";

export interface SettingsDestinationEntry {
  section: string;
  anchor: string;
  tabLabel?: string;
  completeNative?: boolean;
  label: string;
  description: string;
  href: string;
  discoverable: boolean;
  releaseStatus: ReleaseSurfaceStatus;
}

export interface SettingsDestinationPage {
  id: string;
  label: string;
  entries: SettingsDestinationEntry[];
}

const NATIVE_SECTIONS = new Set([
  "general",
  "personalities",
  "trust-policy",
  "tools",
  "providers",
  "citadel-blueprint",
  "citadel-overview",
  "channels",
  "local-ai",
  "integrations",
  "permissions",
  "hooks",
  "budget",
  "workspaces",
  "citadel",
  "citadel-wards",
  "citadel-council",
  "citadel-vault",
  "workspace-capabilities",
  "citadel-capabilities",
  "access",
  "runtime",
  "mcp",
  "web-search",
  "onboarding",
]);

/** One rail section's destination; undefined when the rail has no such section, or discovery leaves it out. */
function destinationEntry(
  section: NonNullable<AppRoute["section"]>,
  discovery: boolean,
): SettingsDestinationEntry | undefined {
  const item =
    RAIL_ITEMS.settings.find((entry) => entry.section === section) ??
    RAIL_ITEMS.library.find((entry) => entry.section === section);
  if (!item) return undefined;
  const discoverable = isPrimaryRailRoute(item);
  if (discovery && !discoverable) return undefined;
  const href = settingsSectionHref(section, item);
  return {
    section,
    discoverable,
    releaseStatus: getRouteReleaseStatus(item),
    anchor: href.split("#")[1] ?? section,
    tabLabel: section === "general" ? "Appearance" : undefined,
    completeNative: NATIVE_SECTIONS.has(section),
    label: item.label,
    description: item.description,
    href,
  };
}

/** A destination describes the Cockpit settings page and anchor that own one rail section. */
export function buildSettingsDestinations({
  discovery = false,
}: { discovery?: boolean } = {}): SettingsDestinationPage[] {
  return cockpitSettingsGroups()
    .map((group) => ({
      id: group.id.replace(/^settings-/, ""),
      label: group.label,
      entries: group.sections.flatMap((section) => destinationEntry(section, discovery) ?? []),
    }))
    .filter((page) => page.entries.length > 0);
}

/** The destinations of Capabilities › Connectors › Advanced setup's sections, in its tab order. */
export function buildConnectorSetupDestinations(): SettingsDestinationEntry[] {
  return CONNECTOR_SETUP_SECTIONS.flatMap((section) => destinationEntry(section, false) ?? []);
}

import {
  buildAppHref,
  getRouteReleaseStatus,
  isPrimaryRailRoute,
  RAIL_GROUPS,
  RAIL_ITEMS,
  type AppRoute,
  type RailGroup,
  type RailItem,
  type ReleaseSurfaceStatus,
} from "../../../app/route-model";
import { channelAdvancedSetupHref, connectorSetupHref, type ConnectorSetupSection } from "../../app/routes";

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
  "addons",
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

/** The sections Capabilities › Connectors › Advanced setup shows, in its tab order. */
export const CONNECTOR_SETUP_SECTIONS: readonly ConnectorSetupSection[] = ["mcp", "integrations", "web-search"];

/**
 * The Cockpit's Settings pages. Settings › Connections was retired (2026-10-30): MCP servers, Integrations and Web &
 * Search moved to Capabilities › Connectors › Advanced setup, Channels to Chat › Messaging › Advanced channel setup,
 * and Capability packs to Settings › Advanced until the Plugins tab replaces them. Classic keeps the shared rail groups.
 */
function cockpitSettingsGroups(): RailGroup[] {
  return (RAIL_GROUPS.settings ?? []).flatMap((group) =>
    group.id === "settings-connections"
      ? []
      : group.id === "settings-advanced"
        ? [{ ...group, sections: [...group.sections, "addons"] }]
        : [group],
  );
}

type SettingsSection = NonNullable<AppRoute["section"]>;

function sectionHref(section: SettingsSection, item: RailItem): string {
  return section === "general"
    ? "/settings/general#appearance"
    : section === "providers"
      ? "/settings/models#providers"
      : section === "tools"
        ? "/settings/safety#approval-mode"
        : section === "budget"
          ? "/settings/safety#budget-mode"
          : section === "local-ai"
            ? "/settings/models#local-ai"
            : section === "trust-policy"
              ? "/settings/safety#trust-policy"
              : section === "permissions"
                ? "/settings/safety#permission-profile"
                : section === "hooks"
                  ? "/settings/safety#hooks"
                  : section === "onboarding"
                    ? "/settings/first-run"
                    : section === "personalities"
                      ? "/settings/general#work-personality"
                      : section === "access"
                        ? "/settings/access#device-access"
                        : section === "workspaces"
                          ? "/settings/citadel#workspace-directory"
                          : section === "citadel-blueprint"
                            ? "/settings/citadel#citadel-blueprint"
                            : section === "citadel-overview"
                              ? "/settings/citadel#citadel-overview"
                              : section === "citadel"
                                ? "/settings/citadel#citadel-mason"
                                : section === "citadel-wards"
                                  ? "/settings/citadel#citadel-wards"
                                  : section === "citadel-council"
                                    ? "/settings/citadel#citadel-council"
                                    : section === "citadel-vault"
                                      ? "/settings/citadel#citadel-vault"
                                      : section === "citadel-capabilities"
                                        ? "/settings/citadel#citadel-capabilities"
                                        : section === "workspace-capabilities"
                                          ? "/settings/citadel#workspace-capabilities"
                                          : section === "integrations" || section === "mcp" || section === "web-search"
                                            ? connectorSetupHref(section)
                                            : section === "channels"
                                              ? channelAdvancedSetupHref()
                                              : section === "addons"
                                                ? "/settings/advanced#addons"
                                                : section === "runtime"
                                                  ? "/settings/advanced#managed-runtime"
                                                  : buildAppHref({ area: item.area, section });
}

/** One rail section's destination; undefined when the rail has no such section, or discovery leaves it out. */
function destinationEntry(section: SettingsSection, discovery: boolean): SettingsDestinationEntry | undefined {
  const item =
    RAIL_ITEMS.settings.find((entry) => entry.section === section) ??
    RAIL_ITEMS.library.find((entry) => entry.section === section);
  if (!item) return undefined;
  const discoverable = isPrimaryRailRoute(item);
  if (discovery && !discoverable) return undefined;
  const href = sectionHref(section, item);
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

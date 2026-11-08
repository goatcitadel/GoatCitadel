import type { AppRoute, RailGroup, RailItem } from "../../../app/route-model";
import { buildAppHref } from "../../../app/route-address";
import { RAIL_GROUPS, readRouteSectionLabel } from "../../../app/route-navigation-metadata";
import { channelAdvancedSetupHref, connectorSetupHref, type ConnectorSetupSection } from "../../app/routes";

/** The sections Capabilities › Connectors › Advanced setup shows, in its tab order. */
export const CONNECTOR_SETUP_SECTIONS: readonly ConnectorSetupSection[] = ["mcp", "integrations", "web-search"];

/**
 * The Cockpit's Settings pages. Settings › Connections was retired (2026-10-30): MCP servers, Integrations and Web &
 * Search moved to Capabilities › Connectors › Advanced setup and Channels to Chat › Messaging › Advanced channel
 * setup. Capability packs were retired; plugins live on Capabilities › Plugins. Classic keeps the shared rail groups.
 */
export function cockpitSettingsGroups(): RailGroup[] {
  return (RAIL_GROUPS.settings ?? []).filter((group) => group.id !== "settings-connections");
}

type SettingsSection = NonNullable<AppRoute["section"]>;

export function settingsSectionHref(section: SettingsSection, item: Pick<RailItem, "area">): string {
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
                                              : section === "runtime"
                                                ? "/settings/advanced#managed-runtime"
                                                : buildAppHref({ area: item.area, section });
}

export interface SettingsRouteHome {
  section: string;
  href: string;
}
export interface SettingsRoutePage {
  id: string;
  label: string;
  entries: SettingsRouteHome[];
}

function routeHome(section: SettingsSection): SettingsRouteHome | undefined {
  const area =
    readRouteSectionLabel("settings", section) !== undefined
      ? "settings"
      : readRouteSectionLabel("library", section) !== undefined
        ? "library"
        : undefined;
  return area ? { section, href: settingsSectionHref(section, { area }) } : undefined;
}

/** Routing uses page, section and address metadata without loading descriptions or release evidence. */
export function buildSettingsRouteHomes(): SettingsRoutePage[] {
  return cockpitSettingsGroups()
    .map((group) => ({
      id: group.id.replace(/^settings-/, ""),
      label: group.label,
      entries: group.sections.flatMap((section) => routeHome(section) ?? []),
    }))
    .filter((page) => page.entries.length > 0);
}

export function buildConnectorSetupRouteHomes(): SettingsRouteHome[] {
  return CONNECTOR_SETUP_SECTIONS.flatMap((section) => routeHome(section) ?? []);
}

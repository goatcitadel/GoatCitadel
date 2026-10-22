import {
  buildAppHref,
  getRouteReleaseStatus,
  isPrimaryRailRoute,
  RAIL_GROUPS,
  RAIL_ITEMS,
  type ReleaseSurfaceStatus,
} from "../../../app/route-model";

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

/** A destination describes the Cockpit settings page and anchor that own one rail section. */
export function buildSettingsDestinations({
  discovery = false,
}: { discovery?: boolean } = {}): SettingsDestinationPage[] {
  return (RAIL_GROUPS.settings ?? [])
    .map((group) => ({
      id: group.id.replace(/^settings-/, ""),
      label: group.label,
      entries: group.sections.flatMap((section) => {
        const item =
          RAIL_ITEMS.settings.find((entry) => entry.section === section) ??
          RAIL_ITEMS.library.find((entry) => entry.section === section);
        if (!item) return [];
        const discoverable = isPrimaryRailRoute(item);
        if (discovery && !discoverable) return [];
        const href =
          section === "general"
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
                                                  : section === "integrations"
                                                    ? "/settings/connections#integration-connections"
                                                    : section === "channels"
                                                      ? "/settings/connections#channels"
                                                      : section === "mcp"
                                                        ? "/settings/connections#mcp-servers"
                                                        : section === "web-search"
                                                          ? "/settings/connections#web-search"
                                                          : section === "addons"
                                                            ? "/settings/connections#addons"
                                                            : section === "runtime"
                                                              ? "/settings/advanced#managed-runtime"
                                                              : buildAppHref({ area: item.area, section });
        return [
          {
            section,
            discoverable,
            releaseStatus: getRouteReleaseStatus(item),
            anchor: href.split("#")[1] ?? section,
            tabLabel: section === "general" ? "Appearance" : undefined,
            completeNative: NATIVE_SECTIONS.has(section),
            label: item.label,
            description: item.description,
            href,
          },
        ];
      }),
    }))
    .filter((page) => page.entries.length > 0);
}

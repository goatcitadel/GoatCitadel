import { buildAppHref, getRouteReleaseScope, isPrimaryRailRoute, RAIL_GROUPS, RAIL_ITEMS, type ReleaseSurfaceStatus } from "../../../app/route-model";

export interface SettingsIndexEntry {
  section: string;
  anchor: string;
  tabLabel?: string;
  completeNative?: boolean;
  label: string;
  description: string;
  href: string;
  searchTerms: string;
  destination: "cockpit" | "detailed";
  discoverable: boolean;
  releaseStatus: ReleaseSurfaceStatus;
  releaseNote: string;
}

export interface SettingsIndexPage {
  id: string;
  label: string;
  entries: SettingsIndexEntry[];
}

const CONTROL_TERMS: Record<string, string> = {
  general:
    "theme color appearance light dark density guided expert technical details notifications notification routing desktop system permission sound unfocused updates download installer",
  personalities: "tone style overlay create edit delete work default personality",
  onboarding: "first run setup choose model test message safety network allowlist safe demo",
  providers: "provider api key credential secret endpoint base url oauth login model catalog routing default llm guided expert diagnostics connection ollama openai compatible",
  "local-ai": "hardware memory model fit download serve endpoint jobs local inference llama.cpp llamacpp gguf gpu cpu npu",
  channels: "channel setup draft connect discord telegram slack oauth validate test finalize delivery disconnect disable remove delete",
  integrations:
    "add create edit delete enable disable integration connection diagnostics operator actions external connector routing meet",
  mcp: "register create edit delete server enable disable connect disconnect oauth tools health elicitation templates model context protocol stdio http sse transport",
  addons: "install update uninstall enable disable launch stop addon extension capability pack import export",
  permissions:
    "permission profile select activate chat effective policy create edit archive default override autonomy grant revoke",
  tools: "approval prompt mode allow deny scoped tool grant create revoke expiry",
  "trust-policy": "trust source provenance blocker callability last use",
  hooks: "register delete webhook signing lifecycle event delivery test history redrive",
  budget: "budget preference cost posture spend",
  "citadel-overview": "charter purpose chambers gatehouse template archive restore brief",
  workspaces: "workspace create edit metadata name description archive restore citadel directory",
  citadel: "setup mason questions blueprint draft review stage",
  "citadel-wards": "ward rule create delete allow deny approval action evaluate test",
  "citadel-council": "council agent seat remove assignment",
  "citadel-vault": "vault secret store replace reveal hide delete",
  "citadel-blueprint": "blueprint export import validate secret scan apply",
  "workspace-capabilities": "workspace skills plugins mcp selection reset inheritance",
  "citadel-capabilities": "citadel skills plugins mcp selection reset inheritance",
  access: "gateway authentication auth token basic password loopback install token device revoke",
  runtime: "managed llama cpp command path alias enabled auto start daemon voice transcription install runtime",
};

const NATIVE_SECTIONS = new Set([
  "general", "personalities", "trust-policy", "tools", "providers", "citadel-blueprint", "citadel-overview", "channels",
  "local-ai", "integrations", "addons", "permissions", "hooks", "budget", "workspaces", "citadel",
  "citadel-wards", "citadel-council", "citadel-vault", "workspace-capabilities", "citadel-capabilities", "access", "runtime", "mcp", "onboarding",
]);

/** A destination describes the page opened, including its explicit detailed-owner links. */
export function buildSettingsIndex({ discovery = false }: { discovery?: boolean } = {}): SettingsIndexPage[] {
  return (RAIL_GROUPS.settings ?? []).map((group) => ({
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
                            : section === "addons"
                              ? "/settings/connections#addons"
                              : section === "runtime"
                                ? "/settings/advanced#managed-runtime"
                                : `${buildAppHref({ area: item.area, section })}?shell=classic`;
      return [
        {
          section,
          discoverable,
          releaseStatus: getRouteReleaseScope(item).status,
          releaseNote: getRouteReleaseScope(item).note,
          anchor: href.split("#")[1] ?? section,
          tabLabel: section === "general" ? "Appearance" : undefined,
          completeNative: NATIVE_SECTIONS.has(section),
          label: item.label,
          description: item.description,
          href,
          searchTerms: CONTROL_TERMS[section] ?? "",
          destination: href.includes("shell=classic") ? ("detailed" as const) : ("cockpit" as const),
        },
      ];
    }),
  })).filter((page) => page.entries.length > 0);
}

export function searchSettingsPages(pages: SettingsIndexPage[], query: string): SettingsIndexPage[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return pages;
  return pages.flatMap((page) => {
    const pageMatches = page.label.toLowerCase().includes(needle);
    const entries = pageMatches
      ? page.entries
      : page.entries.filter((entry) =>
          `${entry.label} ${entry.description} ${entry.searchTerms}`.toLowerCase().includes(needle),
        );
    return entries.length ? [{ ...page, entries }] : [];
  });
}

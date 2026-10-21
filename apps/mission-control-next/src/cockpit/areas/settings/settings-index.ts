import { getRouteReleaseScope, RAIL_ITEMS, type ReleaseSurfaceStatus } from "../../../app/route-model";
import { buildSettingsDestinations } from "./settings-destinations";

export interface SettingsIndexEntry {
  section: string;
  anchor: string;
  tabLabel?: string;
  completeNative?: boolean;
  label: string;
  description: string;
  href: string;
  searchTerms: string;
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
    "theme color appearance light dark match system density guided expert technical details saved automatically notifications notification routing destination rule webhook test delivery desktop system permission sound unfocused updates download installer",
  personalities: "tone style overlay create edit delete work default personality",
  onboarding: "first run setup choose model test message safety network allowlist safe demo",
  providers:
    "provider api key credential secret endpoint base url oauth login model catalog routing default llm guided expert diagnostics connection ollama openai compatible claude code cli let it use goatcitadel tools tool bridge",
  "local-ai":
    "hardware memory model fit download serve endpoint jobs local inference llama.cpp llamacpp gguf gpu cpu npu",
  channels:
    "channel setup draft connect discord telegram slack oauth validate test finalize delivery disconnect disable remove delete",
  integrations:
    "add create edit delete enable disable integration connection diagnostics operator actions external connector meet",
  mcp: "register create edit delete server enable disable connect disconnect oauth tools health elicitation templates model context protocol stdio http sse transport",
  addons: "install update uninstall enable disable launch stop addon extension capability pack import export",
  permissions:
    "permission profile select activate chat effective policy create edit archive default override autonomy grant revoke",
  tools:
    "approval prompt mode allow deny scoped tool grant create revoke expiry filesystem write root folder temp cleanup delete fs.write fs.delete fs.copy fs.move fs.patch",
  "trust-policy": "trust source provenance blocker callability last use",
  hooks: "register delete webhook signing lifecycle event delivery test history redrive",
  budget: "budget preference cost saver balanced power spend",
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
  runtime: "managed command path alias enabled auto start daemon voice transcription install runtime",
};

/** A destination describes the Cockpit settings page and anchor that own one rail section. */
export function buildSettingsIndex({ discovery = false }: { discovery?: boolean } = {}): SettingsIndexPage[] {
  return buildSettingsDestinations({ discovery }).map((page) => ({
    ...page,
    entries: page.entries.map((entry) => {
      const item =
        RAIL_ITEMS.settings.find((candidate) => candidate.section === entry.section) ??
        RAIL_ITEMS.library.find((candidate) => candidate.section === entry.section);
      return {
        section: entry.section,
        discoverable: entry.discoverable,
        releaseStatus: entry.releaseStatus,
        releaseNote: getRouteReleaseScope(item!).note,
        anchor: entry.anchor,
        tabLabel: entry.tabLabel,
        completeNative: entry.completeNative,
        label: entry.label,
        description: entry.description,
        href: entry.href,
        searchTerms: CONTROL_TERMS[entry.section] ?? "",
      };
    }),
  }));
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

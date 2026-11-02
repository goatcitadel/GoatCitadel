import type {
  CapabilityPluginIgnoredKind,
  CapabilityPluginIgnoredPart,
  PluginSourceFormat,
  PluginTrust,
} from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { PLUGIN_TRUST_LABELS } from "./plugin-view";

// How the panel words a plugin's format. The Gateway decides the format, the coverage and every left-out part with
// its reason; nothing here counts parts, groups by reason or decides.

export const CLAUDE_CODE_FORMAT_LABEL = "Claude Code format";
/** A neutral label, never a warning: the import is experimental, not unsafe. */
export const EXPERIMENTAL_LABEL = "Experimental";
export const CLAUDE_CODE_READING_LINE =
  "GoatCitadel reads this Claude Code plugin in its own way. It takes the skills and the apps it already knows, and leaves out the rest.";
export const LEFT_OUT_TITLE = "What it leaves out";
export const GIT_SOURCE_HINT = "A GoatCitadel plugin, or a Claude Code plugin whose repository is the plugin itself.";

/** Each kind of left-out part as its group's heading, in the order the groups come; plugin.json's own keys last. */
export const LEFT_OUT_KIND_LABELS: Readonly<Record<CapabilityPluginIgnoredKind, string>> = {
  command: "Commands",
  agent: "Subagents",
  hook: "Hooks",
  mcp_server: "Apps and servers",
  skill: "Skills",
  output_style: "Output styles",
  lsp_server: "Language servers",
  monitor: "Background commands",
  executable: "Programs",
  settings: "Settings",
  manifest_field: "Other plugin details",
};

/** Whether the Gateway read the plugin from a Claude Code plugin.json. Absent reads as GoatCitadel's own. */
export function isClaudeCodeFormat(plugin: { sourceFormat?: PluginSourceFormat }): boolean {
  return plugin.sourceFormat === "claude_code";
}

/** The trust line: "Claude Code format · Unverified" for a Claude Code plugin, else the trust label alone. */
export function pluginTrustLine(plugin: { trust: PluginTrust; sourceFormat?: PluginSourceFormat }): string {
  const trust = PLUGIN_TRUST_LABELS[plugin.trust];
  return isClaudeCodeFormat(plugin) ? `${CLAUDE_CODE_FORMAT_LABEL} · ${trust}` : trust;
}

/** "GoatCitadel can use 3 of this plugin's 11 parts.", from the Gateway's own count. */
export function coverageLine(coverage: { usable: number; total: number }): string {
  return `GoatCitadel can use ${coverage.usable.toLocaleString()} of this plugin's ${plural(coverage.total, "part")}.`;
}

export interface LeftOutGroup {
  kind: CapabilityPluginIgnoredKind;
  label: string;
  parts: CapabilityPluginIgnoredPart[];
}

/** The left-out parts by the kind the Gateway wrote, in the groups' fixed order, each part in the order it came. */
export function leftOutGroups(ignored: readonly CapabilityPluginIgnoredPart[]): LeftOutGroup[] {
  return (Object.keys(LEFT_OUT_KIND_LABELS) as CapabilityPluginIgnoredKind[]).flatMap((kind) => {
    const parts = ignored.filter((part) => part.kind === kind);
    return parts.length > 0 ? [{ kind, label: LEFT_OUT_KIND_LABELS[kind], parts }] : [];
  });
}

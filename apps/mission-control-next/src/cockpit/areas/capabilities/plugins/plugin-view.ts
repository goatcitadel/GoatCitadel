import type {
  CapabilityPluginListItem,
  CapabilityPluginState,
  PluginPieceKind,
  PluginTrust,
} from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { StatusPresentation, StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { CategoryOption } from "../CategoryFilter";

// Wording and ordering for the list the Gateway already built. Nothing here decides what a plugin is or can do.

/** Where a plugin comes from, as its row and the filter name it. */
export const PLUGIN_TRUST_LABELS: Readonly<Record<PluginTrust, string>> = {
  built_in: "Built in",
  unverified: "Unverified",
};

/**
 * Each kind of piece as a count names it, singular. The key order is the order a summary lists them in (the install
 * panel's: skills, connectors, tool rules, hooks, prompt packs), never the manifest's.
 */
export const PLUGIN_PIECE_NOUNS: Readonly<Record<PluginPieceKind, string>> = {
  skill: "skill",
  connector: "connector",
  tool_group_off: "tool rule",
  hook: "hook",
  prompt_pack: "prompt pack",
};

const STATE_LABELS: Readonly<Record<CapabilityPluginState, string>> = {
  installed: "Installed",
  install_not_finished: "Install not finished",
  uninstalling: "Removing…",
  available: "Ready to install",
};

// A stopped install or removal keeps its state for good, so neither reads as running work: each waits for the
// operator (Continue, or finishing the removal from the plugin's panel).
const STATE_TONES: Readonly<Record<CapabilityPluginState, StatusTone>> = {
  installed: "done",
  install_not_finished: "waiting",
  uninstalling: "waiting",
  available: "neutral",
};

/** The one thing a row offers. */
export type PluginRowAction = "install" | "view" | "continue";

const ROW_ACTIONS: Readonly<Record<CapabilityPluginState, PluginRowAction>> = {
  available: "install",
  installed: "view",
  install_not_finished: "continue",
  // Its panel says how to finish removing it.
  uninstalling: "view",
};

/**
 * What an installed plugin's pieces are, such as "2 skills, 1 connector": every kind the Gateway counted, in a fixed
 * order, through `plural()`. A kind it didn't send, or counted 0, is left out; with none, the summary is empty.
 */
export function pluginPiecesSummary(counts: Partial<Record<PluginPieceKind, number>>): string {
  return (Object.keys(PLUGIN_PIECE_NOUNS) as PluginPieceKind[])
    .flatMap((kind) => {
      const count = counts[kind] ?? 0;
      return count > 0 ? [plural(count, PLUGIN_PIECE_NOUNS[kind])] : [];
    })
    .join(", ");
}

/** A row's state line and the tone it reads in. An installed plugin's line says what it added. */
export function presentPluginState(item: Pick<CapabilityPluginListItem, "state" | "pieceCounts">): StatusPresentation {
  const label = STATE_LABELS[item.state];
  const summary = item.state === "installed" ? pluginPiecesSummary(item.pieceCounts) : "";
  return { label: summary ? `${label} · ${summary}` : label, tone: STATE_TONES[item.state] };
}

export function pluginRowAction(state: CapabilityPluginState): PluginRowAction {
  return ROW_ACTIONS[state];
}

/** What the search box suggests: the first plugin's name, lower-cased, or what the box searches when there is none. */
export function pluginSearchPlaceholder(plugins: readonly Pick<CapabilityPluginListItem, "name">[]): string {
  const name = plugins[0]?.name.trim();
  return name ? `Try "${name.toLowerCase()}"` : "Search plugins";
}

/** The "Where it comes from" buttons for the plugins loaded: only labels that have a plugin, Built in first. */
export function pluginTrustOptions(plugins: readonly Pick<CapabilityPluginListItem, "trust">[]): CategoryOption[] {
  const present = new Set<PluginTrust>(plugins.map((entry) => entry.trust));
  return (Object.keys(PLUGIN_TRUST_LABELS) as PluginTrust[])
    .filter((trust) => present.has(trust))
    .map((trust) => ({ id: trust, label: PLUGIN_TRUST_LABELS[trust] }));
}

/**
 * Keeps the plugins that match the search text (name, description and label as they are shown, ignoring case) and,
 * when any label is chosen, one of the chosen labels.
 */
export function filterPlugins<T extends CapabilityPluginListItem>(
  plugins: readonly T[],
  filters: { query: string; trusts: readonly string[] },
): T[] {
  const needle = filters.query.trim().toLowerCase();
  return plugins.filter(
    (entry) =>
      (filters.trusts.length === 0 || filters.trusts.includes(entry.trust)) &&
      (!needle ||
        [entry.name, entry.description, PLUGIN_TRUST_LABELS[entry.trust]].join("\n").toLowerCase().includes(needle)),
  );
}

/**
 * What the empty state says to do: install from each place this install offers. The built-in list is named only when
 * it has a plugin, and a folder only when one may be added.
 */
export function noPluginsDescription(offers: { builtIn: boolean; folders: boolean }): string {
  if (offers.builtIn && offers.folders) return "Install one from the built-in list, a Git repository or a folder.";
  if (offers.builtIn) return "Install one from the built-in list or a Git repository.";
  if (offers.folders) return "Install one from a Git repository or a folder.";
  return "Install one from a Git repository.";
}

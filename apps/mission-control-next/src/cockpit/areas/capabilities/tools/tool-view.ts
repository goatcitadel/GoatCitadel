import {
  ESSENTIAL_TOOL_GROUP_IDS,
  type CapabilityToolBlock,
  type CapabilityToolGroupItem,
  type CapabilityToolGroupState,
  type CapabilityToolGroupUsage,
  type CapabilityToolItem,
  type CapabilityToolUsageResponse,
} from "@goatcitadel/contracts";
import { formatRelativeTime, plural } from "@goatcitadel/mission-control-shared/content/format";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

// Wording and ordering for the list the Gateway already built. Nothing here decides a group's risk, what blocks it or
// which groups are used most (mc-next AGENTS.md, Frontend Authority Boundary).

/**
 * The calls line of a group. A count is never made up: with no read, a failed read, or a read that has no row for the
 * group, the line says the count is unknown rather than "No calls yet".
 */
export function presentGroupCalls(usage: CapabilityToolGroupUsage | undefined, status: "ready" | "unknown"): string {
  if (status === "unknown" || !usage) return "Calls unknown";
  return usage.calls === 0 ? "No calls yet" : `${plural(usage.calls, "call")} in the last year`;
}

const UNCHECKED_LINE = "Some tools can't be checked before they're used";

/**
 * The lines under a group about its rules, the most important first: how many of its tools other rules block, then
 * whether some can't be checked before they're used. A tool in a group that is off reads "unknown" only because it is
 * switched off, so an unchecked line belongs to groups that are on or always on.
 */
export function presentGroupBlockLines(group: CapabilityToolGroupItem): string[] {
  const lines: string[] = [];
  const total = group.tools.length;
  if (group.blockedToolCount > 0) {
    lines.push(
      group.blockedToolCount >= total
        ? "Blocked by other rules"
        : `${plural(group.blockedToolCount, "tool")} blocked by other rules`,
    );
  }
  if (group.state !== "off" && group.tools.some((entry) => entry.asks === "unknown" && !entry.blockedBy)) {
    lines.push(UNCHECKED_LINE);
  }
  return lines;
}

/** The first line `presentGroupBlockLines` gives, or undefined when a group has none. */
export function presentGroupBlock(group: CapabilityToolGroupItem): string | undefined {
  return presentGroupBlockLines(group)[0];
}

/**
 * The cards of the Most used row and its heading. The Gateway names the groups: the four most called once four have
 * calls, the starter set before that. With no counts, or none named, the starter set shows under "Essentials".
 */
export function presentMostUsed(
  groups: readonly CapabilityToolGroupItem[],
  usage: CapabilityToolUsageResponse | undefined,
): { heading: "Most used" | "Essentials"; groups: CapabilityToolGroupItem[] } {
  const named = usage?.mostUsed.groupIds ?? [];
  const mostUsed = usage?.mostUsed.kind === "most_used" && named.length > 0;
  const ids = named.length > 0 ? named : ESSENTIAL_TOOL_GROUP_IDS;
  return {
    heading: mostUsed ? "Most used" : "Essentials",
    groups: ids.flatMap((id) => groups.filter((group) => group.groupId === id)),
  };
}

/**
 * Keeps the groups that match the search text: their label, description or any of their tools' descriptions, ignoring
 * case. Tool ids are not searched, because the page never shows them.
 */
export function filterToolGroups(groups: readonly CapabilityToolGroupItem[], query: string): CapabilityToolGroupItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  return groups.filter((group) =>
    [group.label, group.description, ...group.tools.map((entry) => entry.description)]
      .join("\n")
      .toLowerCase()
      .includes(needle),
  );
}

/** What the search box suggests: the first Most used group's name, lower-cased. */
export function toolSearchSuggestion(mostUsed: readonly CapabilityToolGroupItem[]): string {
  const first = mostUsed[0];
  return first ? `Try "${first.label.toLowerCase()}"` : "Search tool groups";
}

/** The state word of a group and the tone it reads in. */
export function presentToolGroupState(state: CapabilityToolGroupState): StatusPresentation {
  switch (state) {
    case "on":
      return { label: "On", tone: "done" };
    case "off":
      return { label: "Off", tone: "neutral" };
    case "always_on":
      return { label: "Always on", tone: "done" };
  }
}

/**
 * What each rule that blocks a tool is called. A sixth block fails to compile here, so a new rule can't show as nothing
 * (P2-R27).
 */
export const TOOL_BLOCK_LINES: Readonly<Record<CapabilityToolBlock, string>> = {
  safety_rules: "Blocked by your safety rules",
  permission_profile: "Blocked by a permission profile",
  citadel_ward: "Blocked by a Citadel Ward",
  grant: "Blocked by a grant",
  install_profile: "Blocked by how this install is set up",
};

const ASKS_LINES = {
  asks_first: "Asks first",
  runs_freely: "Runs freely",
  unknown: "Can't tell before it's used",
} as const satisfies Record<CapabilityToolItem["asks"], string>;

/** The asks line of one tool. `block` is set when a rule blocks the tool, so the line can link to that rule. */
export interface ToolAsksLine {
  text: string;
  block?: CapabilityToolBlock;
}

/**
 * The line that says whether the AI asks before using a tool: the rule that blocks it, else that its group is off,
 * else whether it asks first or runs freely. A tool in a group that is off reads "unknown" only because it is switched
 * off, so it never says it can't be told. An "unknown" in a group that is on is a check that couldn't be made.
 */
export function presentToolAsks(
  group: Pick<CapabilityToolGroupItem, "state">,
  tool: Pick<CapabilityToolItem, "asks" | "blockedBy">,
): ToolAsksLine {
  if (tool.blockedBy) return { text: TOOL_BLOCK_LINES[tool.blockedBy], block: tool.blockedBy };
  if (group.state === "off") return { text: "Switched off" };
  return { text: ASKS_LINES[tool.asks] };
}

/**
 * When a tool was last used. "Not used yet" is said only when the counts loaded and don't name the tool; without
 * counts (still loading, or failed) the line says it doesn't know, because a count is never made up.
 */
export function presentToolLastUse(
  usage: CapabilityToolUsageResponse | undefined,
  toolName: string,
  now = Date.now(),
): string {
  if (!usage) return "Last use unknown";
  const entry = usage.tools.find((candidate) => candidate.toolName === toolName);
  if (!entry) return "Not used yet";
  const at = Date.parse(entry.lastCalledAt);
  // A clock a little ahead of this one still reads as just now, not as a time to come.
  return Number.isNaN(at) ? "Last use unknown" : `Last used ${formatRelativeTime(Math.min(at, now), now)}`;
}

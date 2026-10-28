import {
  ESSENTIAL_TOOL_GROUP_IDS,
  type CapabilityToolGroupItem,
  type CapabilityToolGroupUsage,
  type CapabilityToolUsageResponse,
} from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

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

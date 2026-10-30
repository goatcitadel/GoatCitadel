import type { CapabilitySkillDiscoverItem, CapabilitySkillDiscoverState } from "@goatcitadel/contracts";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { CategoryOption } from "../CategoryFilter";

// Wording and ordering for the list the Gateway already built. Nothing here decides whether a source can be installed
// or is installed already: the cockpit only reads `state`, `install` and `installedSkillId` and says what they mean
// (mc-next AGENTS.md, Frontend Authority Boundary).

/** How long the search box waits for typing to stop before the Gateway is asked. */
export const SEARCH_PAUSE_MS = 400;

/** The Gateway searches from this many characters, and refuses more than the second number. */
const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 100;

/** The line of a listing that can only be looked at. */
export const VIEW_ONLY_NOTE = "Can't be installed from here";

/**
 * The search text the Gateway is asked for: the typed text without the spaces around it, or nothing under two
 * characters. Text longer than the Gateway accepts is cut, so a pasted paragraph searches rather than fails.
 */
export function discoverTerm(search: string): string {
  const term = search.trim().slice(0, MAX_TERM_LENGTH).trim();
  return term.length >= MIN_TERM_LENGTH ? term : "";
}

/** What the buttons narrow the list by. An empty list of names means every one. */
export interface DiscoverFilters {
  categories: readonly string[];
  providers: readonly string[];
}

/**
 * Keeps the skills that are in a chosen category and come from a chosen provider. The search is not applied here: the
 * Gateway answers it. The list comes back as a new array, in the order it was given.
 */
export function filterDiscoverItems(
  items: readonly CapabilitySkillDiscoverItem[],
  filters: DiscoverFilters,
): CapabilitySkillDiscoverItem[] {
  return items.filter(
    (item) =>
      (filters.categories.length === 0 || filters.categories.includes(item.category)) &&
      (filters.providers.length === 0 || filters.providers.includes(item.providerLabel)),
  );
}

/** The "Where it came from" buttons in Discover: each provider's name once, in the order the items name them. */
export function discoverProviderOptions(items: readonly CapabilitySkillDiscoverItem[]): CategoryOption[] {
  const labels = [...new Set(items.map((item) => item.providerLabel))];
  return labels.map((label) => ({ id: label, label }));
}

/** Names in plain English: "A", "A and B", "A, B and C". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** The one line that names the sites that couldn't be searched, or undefined when every one answered. */
export function unavailableProvidersLine(labels: readonly string[]): string | undefined {
  return labels.length > 0 ? `${joinLabels(labels)} couldn't be searched right now.` : undefined;
}

const STATES: Readonly<Record<CapabilitySkillDiscoverState, StatusPresentation>> = {
  available: { label: "Not installed", tone: "neutral" },
  installed: { label: "Installed", tone: "done" },
  // An install on its way in or stopped on the way: the install panel says which.
  installing: { label: "Install not finished", tone: "waiting" },
  view_only: { label: "View only", tone: "neutral" },
};

/** The state word of a row and the tone it reads in. */
export function presentDiscoverState(state: CapabilitySkillDiscoverState): StatusPresentation {
  return STATES[state];
}

/** The one thing a row offers. */
export type DiscoverAction =
  | { kind: "install" }
  | { kind: "continue" }
  | { kind: "view"; skillId: string }
  | { kind: "listing"; href: string }
  | { kind: "none" };

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The action of a row, from the state the Gateway gave it. An installed source that can't name its skill has nothing
 * to open, and a listing is only linked when it is an https address (the Gateway sends no other, and a link is never
 * built from one that is not).
 */
export function discoverAction(item: CapabilitySkillDiscoverItem): DiscoverAction {
  switch (item.state) {
    case "available":
      return { kind: "install" };
    case "installing":
      return { kind: "continue" };
    case "installed":
      return item.installedSkillId ? { kind: "view", skillId: item.installedSkillId } : { kind: "none" };
    case "view_only":
      return item.listingUrl && isHttps(item.listingUrl)
        ? { kind: "listing", href: item.listingUrl }
        : { kind: "none" };
  }
}

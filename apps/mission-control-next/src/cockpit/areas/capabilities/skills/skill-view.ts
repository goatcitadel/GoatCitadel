import {
  SKILL_CATEGORIES,
  SKILL_ORIGIN_LABELS,
  type CapabilitySkillItem,
  type CapabilitySkillState,
  type CapabilitySkillUsageEntry,
  type SkillCategoryId,
  type SkillLifecycleState,
  type SkillOrigin,
} from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { StatusPresentation, StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { CategoryOption } from "../CategoryFilter";
import { WORKSPACE_CAPABILITIES_HREF } from "../connectors/connector-links";
import type { SkillSwitch } from "./use-skill-switch";

// Wording and ordering for the list the Gateway already built. Nothing here decides whether a skill is usable: the
// cockpit only reads `callable`, `leftOutOfWorkspace` and `lifecycleState` and says what they mean (mc-next AGENTS.md,
// Frontend Authority Boundary).

/** The line of a skill whose switch can't reach it (a workspace's own skill): there is no switch, so it says why. */
export const CANT_SWITCH_NOTE = "Can't be switched from here";

/** The line under the disabled switch of a pinned skill. It is the route's own sentence. */
export const PINNED_NOTE = "Pinned. Change it through a proposal in Library.";

/**
 * The uses line of a skill. A count is never made up: with no read, a failed read, or a read still running the line
 * says the count is unknown. "Not used yet" is said only when the counts loaded and don't name the skill (a skill that
 * isn't listed has no use in the year) or name it with none.
 */
export function presentSkillUses(entry: CapabilitySkillUsageEntry | undefined, status: "ready" | "unknown"): string {
  if (status === "unknown") return "Uses unknown";
  return !entry || entry.uses === 0 ? "Not used yet" : `Used ${plural(entry.uses, "time")} in the last year`;
}

/** A link that goes with a state's reason, in the same line. */
export interface SkillStateLink {
  label: string;
  href: string;
}

/**
 * Which row of `presentSkillState`'s order a skill matched. Only `on` and `paused` mean the AI can use the skill here,
 * so only they take the panel's note about what the state does.
 */
export type SkillStateKind = "waiting" | "off" | "left_out" | "not_usable" | "paused" | "on";

/**
 * The state word of a skill, the tone it reads in, and the line that says why, with the link that goes with it, and the
 * row of the order it matched.
 */
export type SkillStatePresentation = StatusPresentation & {
  reason: string;
  link?: SkillStateLink;
  kind: SkillStateKind;
};

/**
 * The colour of the line that says why a skill reads as it does. Only the states that warn take a colour, the text
 * colour `StatusBadge` gives their tone, so a revoked or left-out skill reads apart from a paused one without leaning
 * on the words alone. Every other line keeps the secondary text colour, an On skill's uses line included: how often a
 * skill was used is not a success to celebrate.
 */
export const SKILL_TONE_TEXT: Readonly<Record<StatusTone, string>> = {
  running: "text-fg-secondary",
  waiting: "text-status-waiting",
  done: "text-fg-secondary",
  failed: "text-status-failed",
  neutral: "text-fg-secondary",
};

type NotUsablePresentation = Omit<SkillStatePresentation, "kind">;

const NOT_USABLE: Readonly<Partial<Record<SkillLifecycleState, NotUsablePresentation>>> = {
  candidate: { label: "Not usable yet", tone: "waiting", reason: "It hasn't been reviewed, so the AI can't use it" },
  draft: { label: "Not usable yet", tone: "waiting", reason: "It's a draft, so the AI can't use it" },
  deprecated: { label: "Retired", tone: "neutral", reason: "It's retired, so the AI can't use it" },
  revoked: { label: "Revoked", tone: "failed", reason: "It was revoked, so the AI can't use it" },
};

const NOT_USABLE_OTHERWISE: NotUsablePresentation = {
  label: "Not usable yet",
  tone: "waiting",
  reason: "The AI can't use it yet",
};

/**
 * What one skill reads as, the first match winning: a change waiting on your approval, off, left out of this workspace
 * by its skill choices, not usable (said by its review state), paused, and on. A paused skill is usable when it is
 * approved or trusted, which is why the not-usable rows come before Paused.
 *
 * `uses` is the uses line. It is the reason of a skill that is on and usable, the only row that has no other reason.
 *
 * A wait has no link: a skill change is approved in the skill's panel, where it was asked for. It also waits in the
 * Inbox, but nothing here sends the operator there.
 */
export function presentSkillState(
  item: CapabilitySkillItem,
  sw: Pick<SkillSwitch, "waiting">,
  uses = "",
): SkillStatePresentation {
  if (sw.waiting) {
    return {
      label: "Waiting for your approval",
      tone: "waiting",
      reason: "The change applies once you approve it.",
      kind: "waiting",
    };
  }
  if (item.state === "off") return { label: "Off", tone: "neutral", reason: "The AI can't use it", kind: "off" };
  if (item.leftOutOfWorkspace === true) {
    return {
      label: "Left out of this workspace",
      tone: "waiting",
      reason: "This workspace's skill choices leave it out, so the AI can't use it here.",
      link: { label: "Change this workspace's skills", href: WORKSPACE_CAPABILITIES_HREF },
      kind: "left_out",
    };
  }
  if (!item.callable) {
    const notUsable = (item.lifecycleState && NOT_USABLE[item.lifecycleState]) || NOT_USABLE_OTHERWISE;
    return { ...notUsable, kind: "not_usable" };
  }
  if (item.state === "paused") {
    return {
      label: "Paused",
      tone: "neutral",
      reason: "Used when you name it, or on a close match if you allow it",
      kind: "paused",
    };
  }
  return { label: "On", tone: "done", reason: uses, kind: "on" };
}

/**
 * The change a skill's approval asks for, in the words of the click that asked: "Turn Planner on", "Resume Planner",
 * "Turn Planner off", "Pause Planner". It only names the change for the operator; the approval's own review says
 * exactly what it applies. `target` is unknown for a wait found when the list loaded, which reads "Change Planner".
 */
export function presentSkillChange(
  name: string,
  target: CapabilitySkillState | undefined,
  from: CapabilitySkillState,
): string {
  if (target === "on") return from === "paused" ? `Resume ${name}` : `Turn ${name} on`;
  if (target === "off") return `Turn ${name} off`;
  if (target === "paused") return `Pause ${name}`;
  return `Change ${name}`;
}

const CATEGORY_LABELS: ReadonlyMap<SkillCategoryId, string> = new Map(
  SKILL_CATEGORIES.map((category) => [category.id, category.label]),
);

/** The plain label of a category. */
export function skillCategoryLabel(category: SkillCategoryId): string {
  return CATEGORY_LABELS.get(category) ?? "Other";
}

/** What the filter buttons and the search box narrow the list by. An empty list of ids means every one. */
export interface SkillFilters {
  query: string;
  categories: readonly string[];
  origins: readonly string[];
}

/**
 * Keeps the skills that match the search text, which is looked for in the name, the description, the tags and the
 * category's label (ignoring case), and that are in a chosen category and a chosen origin. Skill ids are not searched,
 * because the page never shows them. The list comes back as a new array, in the order it was given.
 */
export function filterSkills(items: readonly CapabilitySkillItem[], filters: SkillFilters): CapabilitySkillItem[] {
  const needle = filters.query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filters.categories.length === 0 || filters.categories.includes(item.category)) &&
      (filters.origins.length === 0 || filters.origins.includes(item.origin)) &&
      (!needle ||
        [item.name, item.description, ...item.tags, skillCategoryLabel(item.category)]
          .join("\n")
          .toLowerCase()
          .includes(needle)),
  );
}

/** Anything the Gateway sorted into a category: an installed skill, or a skill on offer in Discover. */
export interface CategorizedSkill {
  category: SkillCategoryId;
}

/** The category buttons for the skills loaded: only categories that have a skill, in the contract's order. */
export function skillCategoryOptions(items: readonly CategorizedSkill[]): CategoryOption[] {
  const present = new Set<string>(items.map((item) => item.category));
  return SKILL_CATEGORIES.filter((category) => present.has(category.id)).map(({ id, label }) => ({ id, label }));
}

/** The "Where it came from" buttons for the skills loaded: only origins that have a skill, in the label table's order. */
export function skillOriginOptions(items: readonly CapabilitySkillItem[]): CategoryOption[] {
  const present = new Set<string>(items.map((item) => item.origin));
  return (Object.keys(SKILL_ORIGIN_LABELS) as SkillOrigin[])
    .filter((origin) => present.has(origin))
    .map((origin) => ({ id: origin, label: SKILL_ORIGIN_LABELS[origin] }));
}

/**
 * What the search box suggests: the label of the most common category, lower-cased. A tie goes to the category that
 * comes first in the contract's order.
 */
export function skillSearchSuggestion(items: readonly CategorizedSkill[]): string {
  let best: { label: string; count: number } | undefined;
  for (const category of SKILL_CATEGORIES) {
    const count = items.filter((item) => item.category === category.id).length;
    if (count > 0 && (!best || count > best.count)) best = { label: category.label, count };
  }
  return best ? `Try "${best.label.toLowerCase()}"` : "Search skills";
}

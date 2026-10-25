import type { CapabilityCatalogEntry, SkillListItem } from "@goatcitadel/contracts";
import { fetchCapabilityCatalog } from "@goatcitadel/mission-control-shared/api/capabilities";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchSkills } from "@goatcitadel/mission-control-shared/api/skills";
import {
  deriveCapabilityStatus,
  mergeCapabilities,
  presentCapabilityTitle,
  type CapabilityStatusFilter,
} from "@goatcitadel/mission-control-shared/content/capability-rows";

export interface CapabilityCatalogView {
  items: CapabilityCatalogEntry[];
  callableKnown: boolean;
  skillsKnown: boolean;
  skillsById: Record<string, Pick<SkillListItem, "skillId" | "name" | "revision" | "state" | "usageCount" | "lastUsedAt">>;
  issues: string[];
}

export async function loadCapabilityCatalog(): Promise<CapabilityCatalogView> {
  const [inspectable, callable, skills] = await Promise.allSettled([
    fetchCapabilityCatalog("inspectable"),
    fetchCapabilityCatalog("callable"),
    fetchSkills(),
  ]);
  if (inspectable.status === "rejected" && callable.status === "rejected") throw inspectable.reason;
  const issues: string[] = [];
  if (inspectable.status === "rejected") {
    issues.push(`The full catalog could not load. ${describeApiError(inspectable.reason).summary}`);
  }
  if (callable.status === "rejected") {
    issues.push(`Current callability could not be checked. ${describeApiError(callable.reason).summary}`);
  }
  if (skills.status === "rejected") {
    issues.push(`Skill state and usage could not be checked. ${describeApiError(skills.reason).summary}`);
  }
  return {
    items: mergeCapabilities(
      inspectable.status === "fulfilled" ? inspectable.value.items : [],
      callable.status === "fulfilled" ? callable.value.items : [],
    ),
    callableKnown: callable.status === "fulfilled",
    skillsKnown: skills.status === "fulfilled",
    skillsById: skills.status === "fulfilled"
      ? Object.fromEntries(skills.value.items.map((skill) => [skill.skillId, {
        skillId: skill.skillId, name: skill.name, revision: skill.revision, state: skill.state,
        usageCount: skill.usageCount, lastUsedAt: skill.lastUsedAt,
      }]))
      : {},
    issues,
  };
}

export type CapabilityUsage =
  | { status: "recorded"; usageCount?: number; lastUsedAt?: string }
  | { status: "not_recorded" }
  | { status: "unavailable" }
  | { status: "unsupported" };

export function capabilityUsage(item: CapabilityCatalogEntry, catalog: CapabilityCatalogView): CapabilityUsage {
  if (item.kind !== "skill" || !item.skillId) return { status: "unsupported" };
  if (!catalog.skillsKnown) return { status: "unavailable" };
  const usage = catalog.skillsById[item.skillId];
  if (!usage) return { status: "unavailable" };
  if (usage.usageCount === undefined && !usage.lastUsedAt) return { status: "not_recorded" };
  return { status: "recorded", usageCount: usage.usageCount, lastUsedAt: usage.lastUsedAt };
}

export interface CatalogFilters {
  search: string;
  kind: string;
  status: CapabilityStatusFilter;
  trust: string;
}

/** Lower-cased words with `_ . -` and spaces treated alike, so "browser cookies clear" finds browser_cookies_clear. */
function searchWords(text: string): string[] {
  return text.toLocaleLowerCase().split(/[\s_.-]+/u).filter(Boolean);
}

/** Every search word must appear (as a prefix or inside a word) somewhere in the text; order does not matter. */
export function matchesSearchWords(text: string, search: string): boolean {
  const wanted = searchWords(search);
  if (!wanted.length) return true;
  const haystack = searchWords(text).join(" ");
  return wanted.every((word) => haystack.includes(word));
}

export function filterCapabilities(items: readonly CapabilityCatalogEntry[], filters: CatalogFilters): CapabilityCatalogEntry[] {
  const search = filters.search;
  return items.filter((item) => {
    if (filters.kind !== "all" && item.kind !== filters.kind) return false;
    if (filters.status !== "all" && deriveCapabilityStatus(item).status !== filters.status) return false;
    if (filters.trust !== "all" && (item.trustLabel ?? "unlabeled") !== filters.trust) return false;
    return matchesSearchWords(`${item.title} ${presentCapabilityTitle(item)} ${item.summary} ${item.kind}`, search);
  });
}

/** The Skills tab, without a panel open. */
export const SKILLS_HREF = "/capabilities/skills";

/** The two views of the Skills tab. Installed is the default and has no parameter of its own. */
export type SkillsView = "installed" | "discover";

/** The Skills tab with a view open (Installed is the tab's address itself), without a panel. */
export function skillsHref(view: SkillsView = "installed"): string {
  return view === "discover" ? `${SKILLS_HREF}?view=discover` : SKILLS_HREF;
}

/** The view an address names with `?view=discover`; anything else is Installed. */
export function skillsViewFromSearch(search: string | undefined): SkillsView {
  return new URLSearchParams(search ?? "").get("view") === "discover" ? "discover" : "installed";
}

/** The part of `?item=` that names a skill. A Library skill record's id (`skill:<skillId>`) is already in this form. */
const ITEM_PREFIX = "skill:";

/** The address that opens one skill's panel. The view it was opened from is kept, so closing the panel returns to it. */
export function skillItemHref(skillId: string, view: SkillsView = "installed"): string {
  const item = `${SKILLS_HREF}?item=${encodeURIComponent(`${ITEM_PREFIX}${skillId}`)}`;
  return view === "discover" ? `${item}&view=discover` : item;
}

/**
 * The skill an address names with `?item=skill:<id>`, or undefined for anything else (another tab's item included).
 * Whether the loaded list holds the skill is for the list to say.
 */
export function skillIdFromSearch(search: string | undefined): string | undefined {
  const item = new URLSearchParams(search ?? "").get("item");
  const id = item?.startsWith(ITEM_PREFIX) ? item.slice(ITEM_PREFIX.length) : "";
  return id || undefined;
}

/** The skill id in a Library skill record id (`skill:<skillId>`). An id without the prefix is already a skill id. */
export function skillIdFromCapabilityId(capabilityId: string): string {
  return capabilityId.startsWith(ITEM_PREFIX) ? capabilityId.slice(ITEM_PREFIX.length) : capabilityId;
}

/**
 * The inspector source of a skill's panel. It must never start with the Connectors panel's `capabilities:`: the
 * Connectors tab reads every source that does as one of its connectors, and a Skills panel would be taken for one.
 */
export const SKILL_PANEL_SOURCE_PREFIX = "capabilities-skills:";

/** The inspector source of one skill's panel. */
export function skillPanelSource(skillId: string): string {
  return `${SKILL_PANEL_SOURCE_PREFIX}${skillId}`;
}

/** The skill inside an inspector source, or undefined when the source is another panel's (a connector's included). */
export function skillIdFromSource(source: string | undefined): string | undefined {
  const id = source?.startsWith(SKILL_PANEL_SOURCE_PREFIX) ? source.slice(SKILL_PANEL_SOURCE_PREFIX.length) : "";
  return id || undefined;
}

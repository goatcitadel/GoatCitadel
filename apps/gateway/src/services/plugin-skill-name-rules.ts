import { listBundledSkillLockEntries } from "@goatcitadel/skills";

// A plugin's skill may not take the name of a skill that ships with GoatCitadel: the two would read as one skill to the
// operator and to the model. The bundled list is the release's generated lock, so it is fixed for a release and needs no
// reader of its own.

const BUNDLED_PREFIX = "bundled:";

/** The install guard's code for a plugin skill whose name a bundled skill already has. */
export const BUNDLED_SKILL_NAME_TAKEN = "BUNDLED_SKILL_NAME_TAKEN" as const;
/** What the Plugins tab says about such a skill, in the style of "A skill with this name is already installed." */
export const BUNDLED_SKILL_NAME_TAKEN_MESSAGE = "GoatCitadel already has a built-in skill with this name.";

/** A skill name as the Skill Hub compares names: NFKC, trimmed and lower case, as `normalizeSkillId` reads them. */
function comparableName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

const BUNDLED_NAMES: ReadonlySet<string> = new Set(
  listBundledSkillLockEntries()
    .filter((entry) => entry.skillId.startsWith(BUNDLED_PREFIX))
    .map((entry) => comparableName(entry.skillId.slice(BUNDLED_PREFIX.length))),
);

/** The names of the skills that ship bundled with GoatCitadel: each `bundled:<name>` in `listBundledSkillLockEntries()`. */
export function bundledSkillNames(): ReadonlySet<string> {
  return BUNDLED_NAMES;
}

/**
 * Whether a plugin skill's name (the `<name>` of its `extra:<name>` id) is taken by a bundled skill. The whole name must
 * match; case is ignored, as the Skill Hub's own names ignore it, so a re-cased name can't slip past.
 */
export function isBundledSkillName(name: string): boolean {
  const comparable = comparableName(name);
  return comparable.length > 0 && BUNDLED_NAMES.has(comparable);
}

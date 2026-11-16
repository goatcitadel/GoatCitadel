import type { CapabilitySkillRemovalRead } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";

type Settlement = NonNullable<CapabilitySkillRemovalRead["settlement"]>;

const FOLDER_CHANGED =
  "Not removed. The skill's folder no longer matches the files GoatCitadel checked, so nothing was deleted. Put the checked files back or delete the folder yourself, then remove the skill again.";
/** The folder could not be proven the check's own (a link, an unreadable entry) or could not be moved aside. */
const FOLDER_UNPROVEN =
  "Not removed. GoatCitadel couldn't confirm the skill's folder holds only the files it checked, or couldn't move it aside, so nothing was deleted. Check the skill's folder: replace it with the checked files or delete it yourself, then remove the skill again.";
const NEEDS_A_LOOK =
  "Not removed. The skill's folder needs a look before it can be removed, and nothing was deleted. Check it, then remove the skill again.";

const BLOCKED_BY_REASON: Readonly<Record<string, string>> = {
  artifact_tamper:
    "Not removed. The files GoatCitadel checked for this skill have changed, so it won't act on them, and this skill can't be removed here.",
  plugin_still_installed: "Not removed. An installed plugin still lists this skill. Uninstall the plugin first.",
  bundled_skill:
    "Not removed. This skill has the same name as one that ships with GoatCitadel, so it can't be removed here.",
  // Its record is missing, switched on, or a version of it isn't revoked: none reads as a revoked skill.
  skill_not_revoked: "Not removed. The skill was switched on again or changed after you asked, so nothing was deleted.",
  candidate_not_revoked: "Not removed. Another version of this skill isn't revoked, so nothing was deleted.",
  lineage_too_large:
    "Not removed. This skill has more versions than GoatCitadel can check, so it can't be removed here.",
  runtime_not_from_check:
    "Not removed. The skill in use was installed from a different check than the one this removal names, so nothing was deleted.",
  runtime_record_present:
    "Not removed. This skill now has a record in Capabilities › Skills, so nothing was deleted. Remove it there.",
  runtime_folder_present:
    "Not removed. Something is in GoatCitadel's skills folder under this skill's name, so nothing was deleted. Move it out of the skills folder, then remove the skill again.",
  lineage_already_removed:
    "Not removed. This request was for a copy of the skill that was already removed, and the copy here was installed after that, so nothing was deleted. Remove it again to remove this copy.",
};
const BLOCKED_CHANGED = "Not removed. The skill changed after you asked. Remove it again if you still want it gone.";

/** Where an applied removal's left-over line waits for the panel once the skill has left the list. */
export function removalLeftoversKey(workspaceId: string, skillId: string) {
  return ["capability-skill-removal-leftovers", workspaceId, skillId] as const;
}

/**
 * The plain line for an applied removal that left temporary folders it couldn't confirm were its own, or nothing when it
 * left none (or did not apply).
 */
export function removalLeftoversNote(
  settlement: Pick<Settlement, "disposition" | "otherScratchFolders">,
): string | undefined {
  const count = settlement.otherScratchFolders ?? 0;
  if (settlement.disposition !== "applied" || count < 1) return undefined;
  const verb = count === 1 ? "was" : "were";
  return `Removed. GoatCitadel left ${plural(count, "temporary folder")} in the skills folder that it couldn't confirm ${verb} its own.`;
}

/**
 * The plain line for a removal that settled without removing the skill, from the effect's own settlement. Nothing for
 * an applied removal: the skill leaves the list. Every line says what happened and what the operator can do.
 */
export function removalOutcomeNote(settlement: Pick<Settlement, "disposition" | "reason">): string | undefined {
  if (settlement.disposition === "applied") return undefined;
  if (settlement.disposition === "manual_reconciliation") {
    if (settlement.reason === "runtime_projection_diverged") return FOLDER_CHANGED;
    if (settlement.reason === "runtime_removal_unverifiable") return FOLDER_UNPROVEN;
    return NEEDS_A_LOOK;
  }
  return (settlement.reason ? BLOCKED_BY_REASON[settlement.reason] : undefined) ?? BLOCKED_CHANGED;
}

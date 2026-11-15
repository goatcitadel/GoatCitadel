import type { SkillHubOperatorApprovalSummary } from "@goatcitadel/mission-control-shared/api/skill-hub";

type Settlement = NonNullable<SkillHubOperatorApprovalSummary["settlement"]>;

const FOLDER_CHANGED =
  "Not removed. The skill's folder no longer matches the files GoatCitadel checked, so nothing was deleted. Put the checked files back or delete the folder yourself, then remove the skill again.";
const FOLDER_UNPROVEN =
  "Not removed. GoatCitadel couldn't confirm the skill's folder holds only the files it checked, so nothing was deleted. Replace the folder with the checked files or delete it yourself, then remove the skill again.";
const NEEDS_A_LOOK =
  "Not removed. The skill's folder needs a look before it can be removed, and nothing was deleted. Check it, then remove the skill again.";

const BLOCKED_BY_REASON: Readonly<Record<string, string>> = {
  artifact_tamper: "Not removed. The files GoatCitadel checked for this skill have changed, so it won't act on them.",
  plugin_still_installed: "Not removed. An installed plugin still lists this skill. Uninstall the plugin first.",
  bundled_skill: "Not removed. This skill has the same name as one that ships with GoatCitadel.",
  skill_not_revoked: "Not removed. The skill was switched on again.",
  lineage_already_removed:
    "Not removed. This copy of the skill was installed after an earlier removal. Remove it again.",
};
const BLOCKED_CHANGED = "Not removed. The skill changed after you asked. Remove it again if you still want it gone.";

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

/** The settlement of one removal approval in the Skill Hub read, when the read lists it. */
export function findRemovalSettlement(
  items: ReadonlyArray<{ approvals: { remove?: SkillHubOperatorApprovalSummary } }>,
  approvalId: string,
): Settlement | undefined {
  return items.find((item) => item.approvals.remove?.approvalId === approvalId)?.approvals.remove?.settlement;
}

import type { SkillListItem } from "@goatcitadel/contracts";

export interface SkillImmunityResult {
  immune: boolean;
  reason?: "bundled" | "pinned";
}

export function computeSkillImmunity(skill: SkillListItem): SkillImmunityResult {
  if (skill.source === "bundled") {
    return { immune: true, reason: "bundled" };
  }
  if (skill.pinned === true) {
    return { immune: true, reason: "pinned" };
  }
  return { immune: false };
}

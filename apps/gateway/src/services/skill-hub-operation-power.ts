import type { SkillHubOperationKind } from "@goatcitadel/contracts";

/**
 * The Skill Hub steps that only take power away: they never need a trusted, current check, because they never
 * make anything callable. A revoke switches a skill off; a remove deletes one that was already revoked.
 */
export const TAKES_POWER_AWAY: ReadonlySet<SkillHubOperationKind> = new Set<SkillHubOperationKind>([
  "revoke",
  "remove",
]);

export function takesPowerAway(kind: SkillHubOperationKind): boolean {
  return TAKES_POWER_AWAY.has(kind);
}

import type { ChatTurnCapabilityProfileRecord, DesignAdvisory } from "@goatcitadel/contracts";
import { detectDesignAdvisories } from "@goatcitadel/skills";

const DESIGN_SKILL_NAMES = new Set(["impeccable", "design-intelligence"]);
const UI_FILE_EXTENSION = /\.(?:tsx|jsx|css|html|vue|svelte)$/iu;

/** True when the frozen profile admitted a design skill's instructions into this turn. */
export function hasDesignSkillReceipt(profile: ChatTurnCapabilityProfileRecord | undefined): boolean {
  return (profile?.selection.activatedSkills ?? []).some((skill) =>
    DESIGN_SKILL_NAMES.has(skill.skillId.slice(skill.skillId.lastIndexOf(":") + 1).toLowerCase()),
  );
}

/**
 * Advisories for a governed UI file write, computed from the text the tool wrote (never re-read from
 * disk): `content` for fs.write, `newText` for fs.patch. Undefined when the turn carries no design
 * receipt, the tool or extension is out of scope, or nothing fires. Informational only.
 */
export function buildToolResultDesignAdvisories(input: {
  capabilityProfile: ChatTurnCapabilityProfileRecord | undefined;
  toolName: string;
  args: Record<string, unknown> | undefined;
}): DesignAdvisory[] | undefined {
  if (!hasDesignSkillReceipt(input.capabilityProfile)) return undefined;
  const path = typeof input.args?.path === "string" ? input.args.path : "";
  if (!UI_FILE_EXTENSION.test(path)) return undefined;
  const scope: DesignAdvisory["scope"] =
    input.toolName === "fs.write" ? "file" : input.toolName === "fs.patch" ? "patch" : undefined;
  if (!scope) return undefined;
  const text = scope === "file" ? input.args?.content : input.args?.newText;
  if (typeof text !== "string" || text.length === 0) return undefined;
  // A patch's lines count within the replacement text, not the file; the scope says which.
  const advisories = detectDesignAdvisories(text).map((advisory) => ({ ...advisory, scope }));
  return advisories.length > 0 ? advisories : undefined;
}

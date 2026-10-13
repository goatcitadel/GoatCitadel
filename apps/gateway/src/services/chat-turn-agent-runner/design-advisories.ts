import type {
  ChatTurnCapabilityProfileRecord,
  ChatTurnFeatureReferences,
  DesignAdvisory,
} from "@goatcitadel/contracts";
import { DESIGN_ADVISORY_MAX_BYTES, detectDesignAdvisories } from "@goatcitadel/skills";

const DESIGN_SKILL_NAMES = new Set(["impeccable", "design-intelligence"]);
const UI_FILE_EXTENSION = /\.(?:tsx|jsx|css|html|vue|svelte)$/iu;

/** Informational selection evidence only; fresh admissions supersede historical profile receipts. */
export function hasDesignSkillReceipt(
  profile: ChatTurnCapabilityProfileRecord | undefined,
  featureReferences?: ChatTurnFeatureReferences,
): boolean {
  const activatedSkills = featureReferences
    ? (featureReferences.selectedSkills?.activatedSkills ?? [])
    : (profile?.selection.activatedSkills ?? []);
  return activatedSkills.some((skill) =>
    DESIGN_SKILL_NAMES.has(skill.skillId.slice(skill.skillId.lastIndexOf(":") + 1).toLowerCase()),
  );
}

/**
 * Advisories for a governed UI write, computed from the text the tool wrote (never re-read from
 * disk): `content` for fs.write, `newText` for fs.patch, `html` for a model-authored
 * documents.create page. Undefined when the turn carries no design receipt, the tool or extension
 * is out of scope, or nothing fires. Informational only.
 */
export function buildToolResultDesignAdvisories(input: {
  capabilityProfile: ChatTurnCapabilityProfileRecord | undefined;
  featureReferences?: ChatTurnFeatureReferences;
  toolName: string;
  args: Record<string, unknown> | undefined;
}): DesignAdvisory[] | undefined {
  if (!hasDesignSkillReceipt(input.capabilityProfile, input.featureReferences)) return undefined;
  const path = typeof input.args?.path === "string" ? input.args.path : "";
  if (!UI_FILE_EXTENSION.test(path)) return undefined;
  const scope: DesignAdvisory["scope"] =
    input.toolName === "fs.write" || input.toolName === "documents.create"
      ? "file"
      : input.toolName === "fs.patch"
        ? "patch"
        : undefined;
  if (!scope) return undefined;
  const text =
    input.toolName === "documents.create"
      ? input.args?.html
      : scope === "file"
        ? input.args?.content
        : input.args?.newText;
  if (typeof text !== "string" || text.length === 0) return undefined;
  // A patch's lines count within the replacement text, not the file; the scope says which.
  const advisories = detectDesignAdvisories(text).map((advisory) => ({ ...advisory, scope }));
  // The detector capped its own JSON; the scope field adds bytes, so re-apply the cap to what ships.
  while (advisories.length > 0 && Buffer.byteLength(JSON.stringify(advisories), "utf8") > DESIGN_ADVISORY_MAX_BYTES) {
    advisories.pop();
  }
  return advisories.length > 0 ? advisories : undefined;
}

import { ValidationError, redactSecretText } from "@goatcitadel/contracts";
import { validateSkillContent } from "./skill-content-validation.js";

/** Shared pure checks. Passing these grants no author, tool or activation authority. */
export function sanitizeWorkflowSkillText(value: string): string {
  return redactSecretText(value, { env: process.env })
    .value.replace(/\b[A-Z]:[\\/][^\s<>"']+/giu, "[workspace path]")
    .replace(/(?:^|(?<=[\s(]))\/(?:home|Users|tmp|private\/tmp|var\/tmp|mnt)\/[^\s<>"']+/gmu, "[workspace path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]");
}
export function validateWorkflowSkillDraft(markdown: string) {
  if (Buffer.byteLength(markdown) > 64 * 1024 || sanitizeWorkflowSkillText(markdown) !== markdown)
    throw new ValidationError({
      message:
        "Skill draft contains private values or machine-specific paths. Replace them with named inputs and review the revised draft.",
    });
  const validation = validateSkillContent({ skillMarkdown: markdown });
  const missing = [
    "When to use",
    "Inputs",
    "Instructions",
    "Failure handling",
    "Output",
    "Verification",
    "Boundaries",
  ].filter((section) => !new RegExp(`^## ${section}\\s*$`, "imu").test(markdown));
  if (!validation.valid || missing.length)
    throw new ValidationError({
      message: `Skill draft needs revision: ${[...validation.errors, ...missing.map((section) => `missing ${section} section`)].join("; ")}`,
    });
  return validation;
}

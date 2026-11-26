import type { SkillHubBlockerCode, SkillImportValidationResult, SkillScanFindingCode } from "@goatcitadel/contracts";

export const SCAN_BLOCKER_MESSAGES: Partial<Record<SkillHubBlockerCode, string>> = {
  PROMPT_INJECTION_DETECTED: "Skill source contains prompt-injection instructions.",
  HIDDEN_TEXT_DETECTED: "Skill source contains hidden or disguised text.",
  SUSPICIOUS_SCRIPT_INDICATOR: "Skill source contains unsafe script commands.",
  UNREADABLE_SKILL_FILE: "Skill source contains files that could not be read and checked.",
};

/** The shared content scan's dangerous findings, as the blocker codes the Skills tab explains. */
export function scanVerdictBlockers(validation: SkillImportValidationResult): SkillHubBlockerCode[] {
  const codeFor: Partial<Record<SkillScanFindingCode, SkillHubBlockerCode>> = {
    prompt_injection: "PROMPT_INJECTION_DETECTED",
    hidden_text: "HIDDEN_TEXT_DETECTED",
    unsafe_script: "SUSPICIOUS_SCRIPT_INDICATOR",
    unreadable_file: "UNREADABLE_SKILL_FILE",
  };
  return (validation.scanVerdict?.findings ?? []).flatMap((finding) => {
    const code = finding.dangerous ? codeFor[finding.code] : undefined;
    return code ? [code] : [];
  });
}

/** Refuses a review with the first dangerous finding's own reason, ahead of the general validation failure. */
export function assertNoScanBlockers(
  validation: SkillImportValidationResult,
  reject: (code: string, message: string) => never,
): void {
  const [code] = scanVerdictBlockers(validation);
  if (code) reject(code, SCAN_BLOCKER_MESSAGES[code] ?? "Skill source failed the content scan.");
}

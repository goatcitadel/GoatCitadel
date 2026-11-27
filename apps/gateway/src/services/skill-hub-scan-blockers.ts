import type {
  SkillHubBlockerCode,
  SkillImportValidationResult,
  SkillScanFinding,
  SkillScanFindingCode,
} from "@goatcitadel/contracts";

export const SCAN_BLOCKER_MESSAGES: Partial<Record<SkillHubBlockerCode, string>> = {
  PROMPT_INJECTION_DETECTED: "Skill source contains prompt-injection instructions.",
  HIDDEN_TEXT_DETECTED: "Skill source contains hidden or disguised text.",
  SUSPICIOUS_SCRIPT_INDICATOR: "Skill source contains unsafe script commands.",
  UNREADABLE_SKILL_FILE: "Skill source contains files that could not be read and checked.",
};

const BLOCKER_FOR_FINDING: Partial<Record<SkillScanFindingCode, SkillHubBlockerCode>> = {
  prompt_injection: "PROMPT_INJECTION_DETECTED",
  hidden_text: "HIDDEN_TEXT_DETECTED",
  unsafe_script: "SUSPICIOUS_SCRIPT_INDICATOR",
  unreadable_file: "UNREADABLE_SKILL_FILE",
};

/** Dangerous findings, as the blocker codes the Skills tab explains, in finding order. */
export function findingBlockers(findings: readonly SkillScanFinding[]): SkillHubBlockerCode[] {
  return findings.flatMap((finding) => {
    const code = finding.dangerous ? BLOCKER_FOR_FINDING[finding.code] : undefined;
    return code ? [code] : [];
  });
}

/** The shared content scan's dangerous findings, as the blocker codes the Skills tab explains. */
export function scanVerdictBlockers(validation: SkillImportValidationResult): SkillHubBlockerCode[] {
  return findingBlockers(validation.scanVerdict?.findings ?? []);
}

/** Refuses a review with the first dangerous finding's own reason, ahead of the general validation failure. */
export function assertNoScanBlockers(
  validation: SkillImportValidationResult,
  reject: (code: string, message: string) => never,
): void {
  const [code] = scanVerdictBlockers(validation);
  if (code) reject(code, SCAN_BLOCKER_MESSAGES[code] ?? "Skill source failed the content scan.");
}

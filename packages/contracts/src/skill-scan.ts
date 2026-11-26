/** What a skill content scan can find. `dangerous` findings block untrusted sources and warn for the operator's own. */
export const SKILL_SCAN_FINDING_CODES = [
  "prompt_injection",
  "hidden_text",
  "unsafe_script",
  "risky_script",
  "network_use",
  "unreadable_file",
  "scan_incomplete",
] as const;

export type SkillScanFindingCode = (typeof SKILL_SCAN_FINDING_CODES)[number];

export interface SkillScanFinding {
  code: SkillScanFindingCode;
  /** The file's path inside the skill folder, with `/` separators; `.` for the folder as a whole. */
  path: string;
  line?: number;
  dangerous: boolean;
}

export type SkillScanVerdict = "clean" | "warn" | "block";

export interface SkillScanSummary {
  verdict: SkillScanVerdict;
  findings: SkillScanFinding[];
  scannerVersion: string;
  treeSha256?: string;
}

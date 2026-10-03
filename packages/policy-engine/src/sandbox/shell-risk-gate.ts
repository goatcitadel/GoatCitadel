import { compileBoundedRiskPattern, normalizeRiskText } from "./pattern-utils.js";
import { inspectWindowsShellRisk } from "./windows-shell-risk.js";

export interface ShellRiskDecision {
  risky: boolean;
  matchedPattern?: string;
}

const MAX_SHELL_RISK_PATTERN_LENGTH = 512;

export function classifyShellRisk(command: string, riskyPatterns: string[]): ShellRiskDecision {
  const validPatterns = riskyPatterns.filter((pattern) => {
    const normalized = normalizeRiskText(pattern);
    return normalized.length > 0 && normalized.length <= MAX_SHELL_RISK_PATTERN_LENGTH;
  });
  if (validPatterns.length > 0) {
    const windowsRisk = inspectWindowsShellRisk(command, validPatterns);
    if (windowsRisk) return { risky: true, matchedPattern: windowsRisk };
  }
  const normalizedCommand = normalizeRiskText(command);
  for (const pattern of riskyPatterns) {
    const normalizedPattern = normalizeRiskText(pattern);
    if (
      normalizedCommand.length === 0 ||
      normalizedPattern.length === 0 ||
      normalizedPattern.length > MAX_SHELL_RISK_PATTERN_LENGTH
    ) {
      continue;
    }
    if (compileBoundedRiskPattern(normalizedPattern).test(normalizedCommand)) {
      return {
        risky: true,
        matchedPattern: pattern,
      };
    }
  }

  return { risky: false };
}

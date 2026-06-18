export interface ShellRiskDecision {
  risky: boolean;
  matchedPattern?: string;
}

const MAX_SHELL_RISK_PATTERN_LENGTH = 512;
const SHELL_COMMAND_BOUNDARY = "(^|\\s|[;&|()])";
const SHELL_COMMAND_END_BOUNDARY = "($|\\s|[;&|()])";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyShellRisk(command: string, riskyPatterns: string[]): ShellRiskDecision {
  const normalizedCommand = normalizeShellRiskText(command);
  for (const pattern of riskyPatterns) {
    const normalizedPattern = normalizeShellRiskText(pattern);
    if (
      normalizedCommand.length === 0 ||
      normalizedPattern.length === 0 ||
      normalizedPattern.length > MAX_SHELL_RISK_PATTERN_LENGTH
    ) {
      continue;
    }
    if (compileShellRiskPattern(normalizedPattern).test(normalizedCommand)) {
      return {
        risky: true,
        matchedPattern: pattern,
      };
    }
  }

  return { risky: false };
}

function normalizeShellRiskText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function compileShellRiskPattern(pattern: string): RegExp {
  if (pattern.includes("*")) {
    const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*");
    const prefix = pattern.startsWith("*") ? "" : SHELL_COMMAND_BOUNDARY;
    const suffix = pattern.endsWith("*") ? "" : SHELL_COMMAND_END_BOUNDARY;
    return new RegExp(`${prefix}${escaped}${suffix}`, "i");
  }
  return new RegExp(`${SHELL_COMMAND_BOUNDARY}${escapeRegExp(pattern)}${SHELL_COMMAND_END_BOUNDARY}`, "i");
}

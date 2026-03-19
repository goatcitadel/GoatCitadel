export interface ShellRiskDecision {
  risky: boolean;
  matchedPattern?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyShellRisk(command: string, riskyPatterns: string[]): ShellRiskDecision {
  for (const pattern of riskyPatterns) {
    const re = new RegExp("\\b" + escapeRegExp(pattern) + "\\b", "i");
    if (re.test(command)) {
      return {
        risky: true,
        matchedPattern: pattern,
      };
    }
  }

  return { risky: false };
}
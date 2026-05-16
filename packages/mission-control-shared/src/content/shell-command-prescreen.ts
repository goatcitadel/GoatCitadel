export type ShellRiskLevel = "info" | "caution" | "danger";

export interface ShellRiskFinding {
  level: ShellRiskLevel;
  label: string;
  detail?: string;
}

interface PrescreenRule {
  pattern: RegExp;
  level: ShellRiskLevel;
  label: string;
}

const RULES: readonly PrescreenRule[] = [
  { pattern: /\|\s*(sh|bash|zsh|fish)\b/i, level: "danger", label: "Pipe-to-shell" },
  { pattern: /\brm\b[^|]*\s\/(\s|$)/, level: "danger", label: "Filesystem root" },
  { pattern: />>?\s*\/(etc|usr|bin|sbin|var|root)\b/, level: "danger", label: "System path write" },
];

export function prescreenShellRisks(rawCommand: string): readonly ShellRiskFinding[] {
  const out: ShellRiskFinding[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(rawCommand)) {
      out.push({ level: rule.level, label: rule.label });
    }
  }
  return out;
}

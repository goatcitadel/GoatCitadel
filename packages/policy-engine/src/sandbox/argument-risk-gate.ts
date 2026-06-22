import type { ToolRiskyArgumentPattern } from "@goatcitadel/contracts";
import { compileBoundedRiskPattern, normalizeRiskText } from "./pattern-utils.js";

export interface ArgumentRiskDecision {
  risky: boolean;
  matchedPattern?: string;
  toolNamePattern?: string;
}

const MAX_ARG_RISK_PATTERN_LENGTH = 512;
const MAX_ARG_VALUE_LENGTH = 8192;

/**
 * Generalizes the shell-risk gate to arbitrary tools: a tool is allowed in general
 * but a high-risk argument value (e.g. `terraform destroy`) is flagged so the engine
 * can require approval even under a bypass approval mode. Inert when patterns are empty.
 */
export function classifyArgumentRisk(
  toolName: string,
  args: Record<string, unknown> | undefined,
  patterns: ToolRiskyArgumentPattern[] | undefined,
): ArgumentRiskDecision {
  if (!patterns || patterns.length === 0) {
    return { risky: false };
  }
  for (const pattern of patterns) {
    if (!matchesToolName(toolName, pattern.toolNamePattern)) {
      continue;
    }
    const normalizedValue = normalizeRiskText(resolveArgumentValue(args, pattern.argumentPath)).slice(
      0,
      MAX_ARG_VALUE_LENGTH,
    );
    if (normalizedValue.length === 0) {
      continue;
    }
    for (const valuePattern of pattern.valuePatterns) {
      const normalizedPattern = normalizeRiskText(valuePattern);
      if (normalizedPattern.length === 0 || normalizedPattern.length > MAX_ARG_RISK_PATTERN_LENGTH) {
        continue;
      }
      if (compileBoundedRiskPattern(normalizedPattern).test(normalizedValue)) {
        return { risky: true, matchedPattern: valuePattern, toolNamePattern: pattern.toolNamePattern };
      }
    }
  }
  return { risky: false };
}

function matchesToolName(toolName: string, namePattern: string): boolean {
  const normalizedTool = toolName.trim();
  const normalizedPattern = namePattern.trim();
  if (!normalizedPattern || normalizedPattern === "*") {
    return true;
  }
  if (normalizedPattern.endsWith("*")) {
    return normalizedTool.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedTool === normalizedPattern;
}

function resolveArgumentValue(args: Record<string, unknown> | undefined, argumentPath: string | undefined): string {
  if (!args) {
    return "";
  }
  if (!argumentPath || !argumentPath.trim()) {
    return safeStringify(args);
  }
  let current: unknown = args;
  for (const segment of argumentPath.split(".")) {
    if (current && typeof current === "object" && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return "";
    }
  }
  if (typeof current === "string") {
    return current;
  }
  if (current === undefined || current === null) {
    return "";
  }
  return safeStringify(current);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

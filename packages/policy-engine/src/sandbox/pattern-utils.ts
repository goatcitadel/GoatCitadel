/**
 * Shared risk-pattern compilation used by both the shell-risk gate and the
 * generalized argument-risk gate. A pattern matches case-insensitively; `*` is a
 * wildcard, and (unless the pattern starts/ends with `*`) matches are word-bounded
 * by whitespace or shell punctuation so "destroy" does not match "destroyer".
 */
export const RISK_COMMAND_BOUNDARY_START = "(^|\\s|[;&|()])";
export const RISK_COMMAND_BOUNDARY_END = "($|\\s|[;&|()])";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeRiskText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function compileBoundedRiskPattern(
  pattern: string,
  startBoundary: string = RISK_COMMAND_BOUNDARY_START,
  endBoundary: string = RISK_COMMAND_BOUNDARY_END,
): RegExp {
  if (pattern.includes("*")) {
    const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*");
    const prefix = pattern.startsWith("*") ? "" : startBoundary;
    const suffix = pattern.endsWith("*") ? "" : endBoundary;
    return new RegExp(`${prefix}${escaped}${suffix}`, "i");
  }
  return new RegExp(`${startBoundary}${escapeRegExp(pattern)}${endBoundary}`, "i");
}

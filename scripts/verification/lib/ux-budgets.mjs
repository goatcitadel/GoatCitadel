export const CHAT_BUDGET_THRESHOLDS = Object.freeze({ desktop: 0.6, mobile: 0.55 });

const RAW_COPY_PATTERNS = Object.freeze([
  { kind: "enum", pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { kind: "api-path", pattern: /\/api\/v\d+\/[\w\-/.:?=&%]+/g },
  { kind: "uuid", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: "prefixed-id", pattern: /\b(?:sess|turn|run|appr|task|plan|evt|msg|ws)_[0-9a-z]{12,}\b/gi },
  { kind: "transport-error", pattern: /Network error (?:GET|POST|PUT|PATCH|DELETE)|Failed to fetch|API error \d{3}/g },
]);

export function findRawCopyTokens(text) {
  return RAW_COPY_PATTERNS.flatMap(({ kind, pattern }) =>
    [...text.matchAll(pattern)].map((match) => ({ kind, token: match[0] })),
  );
}

/** Owner-supplied text (tool registry, SKILL.md, MCP summaries) is shown verbatim, like
 * assistant output. Drop exact owner lines so the budget checks UI-authored copy only. */
export function withoutOwnerText(visibleText, ownerLines) {
  return visibleText
    .split("\n")
    .filter((line) => !ownerLines.has(line))
    .join("\n");
}

/** Classic Library rows show `truncateText(description, 140)` (LibraryCapabilitiesSection);
 * Cockpit rows show the full description. */
const CLASSIC_LIBRARY_PREVIEW_LIMIT = 140;

export function ownerDescriptionLines(description) {
  if (description.length <= CLASSIC_LIBRARY_PREVIEW_LIMIT) return [description];
  return [description, description.slice(0, CLASSIC_LIBRARY_PREVIEW_LIMIT).trimEnd()];
}

export function evaluateChatBudget({ viewportHeight, scrollerHeight }, variant) {
  const threshold = CHAT_BUDGET_THRESHOLDS[variant];
  if (threshold === undefined) throw new Error(`Unknown chat budget variant: ${variant}`);
  if (!(viewportHeight > 0)) throw new Error("viewportHeight must be positive");
  const ratio = Math.max(0, scrollerHeight) / viewportHeight;
  return { ratio: Math.round(ratio * 1000) / 1000, threshold, pass: ratio >= threshold };
}

export function evaluateToastBudget(count) {
  return { count, pass: count === 0 };
}

export function evaluateRailReach({ railVisible, railBottom, viewportHeight }) {
  if (!railVisible) return { gap: 0, pass: true };
  const gap = Math.round(viewportHeight - railBottom);
  return { gap, pass: Math.abs(gap) <= 1 };
}

export function evaluateHorizontalOverflow({ scrollWidth, clientWidth }) {
  const overflow = scrollWidth - clientWidth;
  return { overflow, pass: overflow <= 1 };
}

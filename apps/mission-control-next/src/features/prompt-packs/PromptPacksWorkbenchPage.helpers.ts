import type {
  PromptPackAutoScoreRecord,
  PromptPackExecutionStyle,
  PromptPackLatestAssessmentRecordV2,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackScoringSchemaVersion,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  classifyTestResultCategory,
  matchesTestResultFilter,
  type TestResultFilter,
} from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import type { ScoreDraft } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import type { AppRoute } from "@next/app/route-model";

export const DEFAULT_BENCHMARK_TEST_CODES = "TEST-03, TEST-06, TEST-10, TEST-12, TEST-15, TEST-28";

/**
 * Pass-readiness blockers for a pack report. Shared between the workbench
 * summary card and the Insights panel so both surfaces agree on what blocks
 * a full pass; the detail strings rendered next to it stay caller-local.
 */
export function computePassReadiness(
  summary: PromptPackReportRecord["summary"] | null | undefined,
): { blockers: string[]; complete: boolean } {
  if (!summary) {
    return { blockers: [], complete: false };
  }
  const notRunCount = Math.max(
    summary.totalTests - summary.completedRuns - summary.failedRuns - (summary.approvalPausedRuns ?? 0),
    0,
  );
  const completedValidLatestRuns = Math.max(summary.completedRuns - summary.invalidLatestRuns, 0);
  const scoredCoverageDenominator = Math.max(
    completedValidLatestRuns,
    summary.autoScoredRuns + summary.needsScoreCount,
  );
  const missingCurrentScores = Math.max(scoredCoverageDenominator - summary.autoScoredRuns, 0);
  const blockers = [
    summary.totalTests === 0 ? "No tests loaded" : undefined,
    notRunCount > 0 ? `${notRunCount} not run` : undefined,
    summary.failedRuns > 0 ? `${summary.failedRuns} failed run(s)` : undefined,
    summary.runFailureCount > 0 ? `${summary.runFailureCount} runtime failure(s)` : undefined,
    summary.invalidLatestRuns > 0 ? `${summary.invalidLatestRuns} invalid latest run(s)` : undefined,
    missingCurrentScores > 0 ? `${missingCurrentScores} completed run(s) without current auto-score` : undefined,
    summary.staleLatestAutoScoreCount > 0 ? `${summary.staleLatestAutoScoreCount} stale score row(s)` : undefined,
    summary.failCount > 0 ? `${summary.failCount} fail verdict(s)` : undefined,
    summary.reviewCount > 0 ? `${summary.reviewCount} review verdict(s)` : undefined,
    summary.judgeErrorCount > 0 ? `${summary.judgeErrorCount} judge error(s)` : undefined,
    summary.degradedScoreCount > 0 ? `${summary.degradedScoreCount} degraded score(s)` : undefined,
    summary.effectivePassRate < 1 ? "Scored pass rate below 100%" : undefined,
  ].filter((item): item is string => Boolean(item));
  return { blockers, complete: blockers.length === 0 };
}

const PROMPT_PACK_V2_DIMENSION_LABELS = [
  ["taskSuccess", "Task success"],
  ["honesty", "Honesty"],
  ["executionQuality", "Execution quality"],
  ["robustness", "Robustness"],
  ["usability", "Usability"],
] as const;

const PROMPT_PACK_V3_DIMENSION_LABELS = [
  ["taskSuccess", "Task success"],
  ["truthfulness", "Truthfulness"],
  ["evidenceGrounding", "Evidence grounding"],
  ["formatAdherence", "Format adherence"],
  ["operatorUsefulness", "Operator usefulness"],
  ["toolUseQuality", "Tool use quality"],
  ["orchestrationQuality", "Orchestration quality"],
  ["efficiency", "Efficiency"],
  ["recoveryQuality", "Recovery quality"],
] as const;

export function getPromptPackScoreDimensionLabels(schemaVersion: PromptPackScoringSchemaVersion) {
  return schemaVersion === "v3" ? PROMPT_PACK_V3_DIMENSION_LABELS : PROMPT_PACK_V2_DIMENSION_LABELS;
}

export function readPromptPackScoreDimension(
  scores: PromptPackAutoScoreRecord["finalScores"] | PromptPackAutoScoreRecord["ruleScores"] | undefined,
  dimension: string,
): string | number {
  if (!scores) {
    return "-";
  }
  const value = (scores as Record<string, number | undefined>)[dimension];
  return value ?? "-";
}

export function formatPromptPackAttribution(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const DIMENSION_ROWS: Array<{
  key: keyof Pick<ScoreDraft, "taskSuccess" | "honesty" | "executionQuality" | "robustness" | "usability">;
  label: string;
  weight: number;
}> = [
  { key: "taskSuccess", label: "Task success", weight: 25 },
  { key: "honesty", label: "Honesty", weight: 20 },
  { key: "executionQuality", label: "Execution quality", weight: 20 },
  { key: "robustness", label: "Robustness", weight: 20 },
  { key: "usability", label: "Usability", weight: 15 },
];

export interface PromptPackTestOutcomeSummary {
  approvalPausedCount: number;
  runFailureCount: number;
  scoreFailureCount: number;
  reviewCount: number;
  needsScoreCount: number;
  notRunCount: number;
  passingCount: number;
}

export const FILTER_OPTIONS: Array<{
  value: TestResultFilter;
  label: string;
  count: (summary: PromptPackTestOutcomeSummary, totalTests: number) => number;
}> = [
  { value: "all", label: "All", count: (_summary, total) => total },
  { value: "approval_paused", label: "Paused", count: (summary) => summary.approvalPausedCount },
  { value: "run_failed", label: "Run failed", count: (summary) => summary.runFailureCount },
  { value: "score_failed", label: "Score failed", count: (summary) => summary.scoreFailureCount },
  { value: "review", label: "Review", count: (summary) => summary.reviewCount },
  { value: "needs_score", label: "Needs score", count: (summary) => summary.needsScoreCount },
  { value: "not_run", label: "Not run", count: (summary) => summary.notRunCount },
  { value: "passing", label: "Passing", count: (summary) => summary.passingCount },
];

export function statusChipClass(status?: PromptPackRunRecord["status"]): string {
  if (!status) {
    return "run-not-run";
  }
  if (status === "completed") {
    return "run-completed";
  }
  if (status === "approval_paused") {
    return "run-paused";
  }
  if (status === "failed") {
    return "run-failed";
  }
  return "run-not-run";
}

export function resultCategoryClass(category: Exclude<TestResultFilter, "all">): string {
  if (category === "approval_paused") {
    return "result-run-paused";
  }
  if (category === "run_failed") {
    return "result-run-failed";
  }
  if (category === "score_failed") {
    return "result-score-failed";
  }
  if (category === "review") {
    return "result-review";
  }
  if (category === "needs_score") {
    return "result-needs-score";
  }
  if (category === "passing") {
    return "result-passing";
  }
  return "result-not-run";
}

export function formatPromptPackExecutionStyle(style?: PromptPackExecutionStyle): string {
  return style === "agentic_surface" ? "Agentic" : "Harness";
}

export function buildLatestPromptPackRunByTest(
  runs: PromptPackRunRecord[] | undefined,
): Map<string, PromptPackRunRecord> {
  const map = new Map<string, PromptPackRunRecord>();
  const orderedRuns = [...(runs ?? [])].sort((left, right) => {
    const leftTs = Date.parse(left.startedAt || left.finishedAt || "1970-01-01T00:00:00.000Z");
    const rightTs = Date.parse(right.startedAt || right.finishedAt || "1970-01-01T00:00:00.000Z");
    return rightTs - leftTs;
  });
  for (const run of orderedRuns) {
    if (!map.has(run.testId)) {
      map.set(run.testId, run);
    }
  }
  return map;
}

export function buildLatestPromptPackAssessmentByTest(
  assessments: PromptPackLatestAssessmentRecordV2[] | undefined,
): Map<string, PromptPackLatestAssessmentRecordV2> {
  return new Map((assessments ?? []).map((assessment) => [assessment.testId, assessment] as const));
}

export function summarizePromptPackTestOutcomes(
  tests: PromptPackTestRecord[],
  latestRunByTest: Map<string, PromptPackRunRecord>,
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>,
): PromptPackTestOutcomeSummary {
  const summary: PromptPackTestOutcomeSummary = {
    approvalPausedCount: 0,
    runFailureCount: 0,
    scoreFailureCount: 0,
    reviewCount: 0,
    needsScoreCount: 0,
    notRunCount: 0,
    passingCount: 0,
  };

  for (const test of tests) {
    const category = classifyTestResultCategory(
      latestRunByTest.get(test.testId),
      latestAssessmentByTest.get(test.testId),
    );
    if (category === "approval_paused") {
      summary.approvalPausedCount += 1;
    } else if (category === "run_failed") {
      summary.runFailureCount += 1;
    } else if (category === "score_failed") {
      summary.scoreFailureCount += 1;
    } else if (category === "review") {
      summary.reviewCount += 1;
    } else if (category === "needs_score") {
      summary.needsScoreCount += 1;
    } else if (category === "not_run") {
      summary.notRunCount += 1;
    } else if (category === "passing") {
      summary.passingCount += 1;
    }
  }

  return summary;
}

export function filterPromptPackTestsByResult(
  tests: PromptPackTestRecord[],
  filter: TestResultFilter,
  latestRunByTest: Map<string, PromptPackRunRecord>,
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>,
): PromptPackTestRecord[] {
  return tests.filter((test) =>
    matchesTestResultFilter(filter, latestRunByTest.get(test.testId), latestAssessmentByTest.get(test.testId)),
  );
}

export function chooseNextPromptPackTest(
  tests: PromptPackTestRecord[],
  latestRunByTest: Map<string, PromptPackRunRecord>,
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>,
): PromptPackTestRecord | undefined {
  const nextNotRun = tests.find((test) => !latestRunByTest.get(test.testId));
  const nextFailed = tests.find((test) => latestRunByTest.get(test.testId)?.status === "failed");
  const nextUnscoredCompleted = tests.find((test) => {
    const run = latestRunByTest.get(test.testId);
    const assessment = latestAssessmentByTest.get(test.testId);
    return run?.status === "completed" && !assessment?.autoScore;
  });
  return nextNotRun ?? nextFailed ?? nextUnscoredCompleted ?? tests[0];
}

export function buildPromptPackSelectedRunLink(selectedRunHref: string | null, origin?: string): string | null {
  if (!selectedRunHref || !origin) {
    return selectedRunHref;
  }
  return new URL(selectedRunHref, origin).toString();
}

export function computeDraftWeightedScore(scoreDraft: ScoreDraft): number | null {
  if (DIMENSION_ROWS.some((dimension) => scoreDraft[dimension.key] === null)) {
    return null;
  }
  const total = DIMENSION_ROWS.reduce(
    (sum, dimension) => sum + Number(scoreDraft[dimension.key]) * dimension.weight,
    0,
  );
  return total / 4;
}

export function computeDraftVerdict(
  scoreDraft: ScoreDraft,
  overrideVerdict: ScoreDraft["overrideVerdict"],
): "pass" | "review" | "fail" | "incomplete" {
  if (overrideVerdict) {
    return overrideVerdict;
  }
  const weighted = computeDraftWeightedScore(scoreDraft);
  if (weighted === null) {
    return "incomplete";
  }
  if (weighted >= 75) {
    return "pass";
  }
  if (weighted >= 60) {
    return "review";
  }
  return "fail";
}

export function buildPromptPackRunRoute(run?: PromptPackRunRecord): AppRoute | null {
  if (!run?.sessionId) {
    return null;
  }
  return {
    area: run.mode === "cowork" ? "cowork" : run.mode === "code" ? "code" : "chat",
    sessionId: run.sessionId,
  };
}

export function isPromptPackV2UiEnabled(): boolean {
  const raw = (import.meta.env.VITE_PROMPT_PACK_V2_UI_ENABLED as string | undefined)?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}

/**
 * Inline segments produced by {@link parsePromptForChips}.
 * - `text`: plain run of characters.
 * - `variable`: a `<PLACEHOLDER>` token rendered as an accessible chip.
 *   `declared` is `true` when the placeholder appears in the test's declared
 *   placeholder set (extracted via `extractPromptPlaceholders`).
 */
export type PromptInlineSegment =
  | { kind: "text"; value: string }
  | { kind: "variable"; name: string; raw: string; declared: boolean };

/**
 * Block-level rows produced by {@link parsePromptForChips}. Each row is one
 * visible line in the editor; preserved verbatim so the rendered output is
 * 1:1 with the source prompt (no whitespace or empty-line collapsing).
 *
 * - `comment`: line that begins with `#` (markdown header / comment).
 * - `role-marker`: line that begins with a role token like `System:`,
 *   `User:`, `Assistant:` followed by whitespace or end-of-line.
 * - `code-fence`: a triple-backtick fence marker line.
 * - `code`: a line inside a fenced code block.
 * - `line`: everything else; rendered with inline segments + chips.
 */
export type PromptBlockRow =
  | { kind: "line"; lineNumber: number; segments: PromptInlineSegment[] }
  | { kind: "comment"; lineNumber: number; value: string }
  | { kind: "role-marker"; lineNumber: number; role: string; rest: string; segments: PromptInlineSegment[] }
  | { kind: "code-fence"; lineNumber: number; value: string }
  | { kind: "code"; lineNumber: number; value: string };

const ROLE_MARKER_PATTERN = /^(System|User|Assistant|Tool|Function|Developer)\s*:\s*/i;
const VARIABLE_TOKEN_PATTERN = /<[^<>\n]{3,160}>/g;

function looksLikePromptPlaceholder(inner: string): boolean {
  if (!inner) {
    return false;
  }
  return /[A-Z]{2,}/.test(inner) || /[_ ]/.test(inner) || /\b(PASTE|LOCAL|URL|TOPIC|PATH|EXAMPLE|YOUR)\b/i.test(inner);
}

function splitLineIntoInlineSegments(line: string, declaredKeys: Set<string>): PromptInlineSegment[] {
  if (!line) {
    return [];
  }
  const segments: PromptInlineSegment[] = [];
  let cursor = 0;
  // Reset lastIndex defensively — VARIABLE_TOKEN_PATTERN is global.
  const matcher = new RegExp(VARIABLE_TOKEN_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(line)) !== null) {
    const inner = match[0].slice(1, -1).trim();
    if (!looksLikePromptPlaceholder(inner)) {
      continue;
    }
    if (match.index > cursor) {
      segments.push({ kind: "text", value: line.slice(cursor, match.index) });
    }
    const normalizedKey = inner.toLowerCase().replace(/\s+/g, " ").trim();
    segments.push({
      kind: "variable",
      name: inner,
      raw: match[0],
      declared: declaredKeys.has(normalizedKey),
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length) {
    segments.push({ kind: "text", value: line.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value: line }];
}

/**
 * Parse a prompt string into block rows for chip-aware rendering.
 *
 * Read-only by design — there is no caret/selection model. The flat
 * `<pre>{prompt}</pre>` is replaced with a line-numbered listing where
 * variable tokens become accessible chips, comment lines, role markers,
 * and fenced code blocks each get a distinct style.
 *
 * @param prompt        Raw prompt source. `undefined`/empty returns `[]`.
 * @param declaredVars  Optional list of placeholder tokens (e.g. the
 *                      `<PASTE_TOPIC>` strings returned by
 *                      `extractPromptPlaceholders`). When provided,
 *                      matching variables are flagged `declared: true`
 *                      so callers can tint them with the area color
 *                      instead of the caution color used for unknown
 *                      placeholders.
 */
export function parsePromptForChips(
  prompt: string | undefined,
  declaredVars: readonly string[] = [],
): PromptBlockRow[] {
  if (!prompt) {
    return [];
  }
  const declaredKeys = new Set<string>();
  for (const token of declaredVars) {
    const trimmed = (token ?? "").trim();
    if (!trimmed) {
      continue;
    }
    const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
    const normalized = inner.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalized) {
      declaredKeys.add(normalized);
    }
  }
  const rows: PromptBlockRow[] = [];
  // Split on \n so that the original string can be reproduced exactly when
  // joined with newlines (CRLF input is normalised at this seam).
  const lines = prompt.replace(/\r\n/g, "\n").split("\n");
  let insideFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    // `lines[index]` is guaranteed by the loop bound, but TS `noUncheckedIndexedAccess`
    // surfaces `string | undefined`; coalesce so the rest of the loop can treat the row
    // as a definite string without per-call narrowing.
    const raw = lines[index] ?? "";
    const lineNumber = index + 1;
    if (raw.trimStart().startsWith("```")) {
      rows.push({ kind: "code-fence", lineNumber, value: raw });
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      rows.push({ kind: "code", lineNumber, value: raw });
      continue;
    }
    if (raw.trimStart().startsWith("#")) {
      rows.push({ kind: "comment", lineNumber, value: raw });
      continue;
    }
    const roleMatch = raw.match(ROLE_MARKER_PATTERN);
    if (roleMatch) {
      const role = roleMatch[0].replace(/\s*:\s*$/, "").trim();
      const rest = raw.slice(roleMatch[0].length);
      rows.push({
        kind: "role-marker",
        lineNumber,
        role,
        rest,
        segments: splitLineIntoInlineSegments(rest, declaredKeys),
      });
      continue;
    }
    rows.push({
      kind: "line",
      lineNumber,
      segments: splitLineIntoInlineSegments(raw, declaredKeys),
    });
  }
  return rows;
}

import type {
  ChatMemoryMode,
  ChatMode,
  ChatThinkingLevel,
  ChatTurnTraceRecord,
  ChatWebMode,
  DecisionAutoTuneRecord,
  DecisionReplayCauseClass,
  DecisionReplayFindingRecord,
  DecisionReplayItemModelScores,
  DecisionReplayItemRecord,
  DecisionReplayItemRuleScores,
  DecisionReplayRunRecord,
  WeeklyImprovementReportRecord,
} from "@goatcitadel/contracts";
import { clampProbability, safeJsonParse } from "./improvement-common.js";

export const IMPROVEMENT_RUN_STATUS_VALUES = new Set(["queued", "running", "completed", "failed"]);
export const IMPROVEMENT_CAUSE_CLASSES = new Set<DecisionReplayCauseClass>([
  "false_refusal_tone",
  "weak_blocker_explanation",
  "tool_mismatch",
  "retrieval_miss",
  "incomplete_retry_repair",
  "other",
]);

export interface ImprovementReplayTriggerInput {
  sampleSize?: number;
}

export interface DecisionReplayCandidate {
  decisionType: "chat_turn" | "tool_run";
  sessionId?: string;
  turnId?: string;
  toolRunId?: string;
  status: string;
  occurredAt: string;
  model?: string;
  mode?: ChatMode;
  webMode?: ChatWebMode;
  memoryMode?: ChatMemoryMode;
  thinkingLevel?: ChatThinkingLevel;
  routing?: ChatTurnTraceRecord["routing"];
  retrieval?: ChatTurnTraceRecord["retrieval"];
  reflection?: ChatTurnTraceRecord["reflection"];
  toolName?: string;
  error?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  userMessageId?: string;
  assistantMessageId?: string;
}

export interface ReplayScoredItemResult {
  item: DecisionReplayItemRecord;
  judgeUsed: boolean;
}

export function mapDecisionReplayRunRow(row: {
  run_id: string;
  trigger_mode: "scheduled" | "manual";
  sample_size: number;
  window_start: string;
  window_end: string;
  status: string;
  report_id: string | null;
  total_candidates: number;
  total_scored: number;
  likely_wrong_count: number;
  model_judged_count: number;
  started_at: string;
  finished_at: string | null;
  error_text: string | null;
}): DecisionReplayRunRecord {
  return {
    runId: row.run_id,
    triggerMode: row.trigger_mode,
    sampleSize: row.sample_size,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    status: IMPROVEMENT_RUN_STATUS_VALUES.has(row.status)
      ? (row.status as DecisionReplayRunRecord["status"])
      : "failed",
    reportId: row.report_id ?? undefined,
    totalCandidates: row.total_candidates,
    totalScored: row.total_scored,
    likelyWrongCount: row.likely_wrong_count,
    modelJudgedCount: row.model_judged_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error_text ?? undefined,
  };
}

export function mapDecisionAutoTuneRow(row: {
  tune_id: string;
  run_id: string;
  finding_id: string | null;
  tune_class: DecisionAutoTuneRecord["tuneClass"];
  risk_level: DecisionAutoTuneRecord["riskLevel"];
  status: DecisionAutoTuneRecord["status"];
  description: string;
  patch_json: string;
  snapshot_json: string | null;
  result_json: string | null;
  created_at: string;
  applied_at: string | null;
  reverted_at: string | null;
}): DecisionAutoTuneRecord {
  return {
    tuneId: row.tune_id,
    runId: row.run_id,
    findingId: row.finding_id ?? undefined,
    tuneClass: row.tune_class,
    riskLevel: row.risk_level,
    status: row.status,
    description: row.description,
    patch: safeJsonParse<Record<string, unknown>>(row.patch_json, {}),
    snapshot: row.snapshot_json ? safeJsonParse<Record<string, unknown>>(row.snapshot_json, {}) : undefined,
    result: row.result_json ? safeJsonParse<Record<string, unknown>>(row.result_json, {}) : undefined,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
    revertedAt: row.reverted_at ?? undefined,
  };
}

export function mapImprovementReportRow(row: {
  report_id: string;
  run_id: string;
  week_start: string;
  week_end: string;
  summary_json: string;
  top_findings_json: string;
  applied_tunes_json: string;
  queued_tunes_json: string;
  week_over_week_json: string;
  previous_report_id: string | null;
  created_at: string;
}): WeeklyImprovementReportRecord {
  return {
    reportId: row.report_id,
    runId: row.run_id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    summary: safeJsonParse<WeeklyImprovementReportRecord["summary"]>(row.summary_json, {
      sampledDecisions: 0,
      likelyWrongCount: 0,
      wrongnessRate: 0,
      topCauseClasses: [],
      duplicateSuppressedCount: 0,
      improvedCount: 0,
      regressedCount: 0,
    }),
    topFindings: safeJsonParse<DecisionReplayFindingRecord[]>(row.top_findings_json, []),
    appliedAutoTunes: safeJsonParse<DecisionAutoTuneRecord[]>(row.applied_tunes_json, []),
    queuedRecommendations: safeJsonParse<DecisionAutoTuneRecord[]>(row.queued_tunes_json, []),
    weekOverWeek: safeJsonParse<WeeklyImprovementReportRecord["weekOverWeek"]>(row.week_over_week_json, {
      improved: [],
      regressed: [],
      unchanged: [],
    }),
    previousReportId: row.previous_report_id ?? undefined,
    createdAt: row.created_at,
  };
}

export function normalizeDecisionReplayCauseClass(value: string): DecisionReplayCauseClass {
  return IMPROVEMENT_CAUSE_CLASSES.has(value as DecisionReplayCauseClass)
    ? (value as DecisionReplayCauseClass)
    : "other";
}

export function sampleDecisionReplayCandidates(
  candidates: DecisionReplayCandidate[],
  sampleSize: number,
): DecisionReplayCandidate[] {
  const cap = Math.max(1, Math.min(sampleSize, candidates.length));
  const critical = candidates.filter(
    (c) => c.status === "failed" || c.status === "blocked" || c.status === "approval_required",
  );
  const normal = candidates.filter((c) => !critical.includes(c));
  const criticalTarget = Math.min(critical.length, Math.max(1, Math.floor(cap * 0.45)));
  const selected = [...critical.slice(0, criticalTarget), ...normal.slice(0, cap - criticalTarget)];
  if (selected.length < cap) {
    for (const c of [...critical.slice(criticalTarget), ...normal.slice(cap - criticalTarget)]) {
      if (selected.length >= cap) break;
      if (!selected.includes(c)) selected.push(c);
    }
  }
  return selected.slice(0, cap);
}

export function evaluateDecisionReplayRuleScores(
  candidate: DecisionReplayCandidate,
  turnTools: DecisionReplayCandidate[],
): { scores: DecisionReplayItemRuleScores; signals: string[] } {
  const signals: string[] = [];
  let honesty = 0.7,
    blockerQuality = 0.7,
    retryQuality = 0.7,
    toolEvidence = 0.65,
    actionability = 0.7;
  if (candidate.decisionType === "chat_turn") {
    const executedTools = turnTools.filter((i) => i.status === "executed");
    const failedTools = turnTools.filter((i) => i.status === "failed");
    const blockedTools = turnTools.filter((i) => i.status === "blocked" || i.status === "approval_required");
    if (candidate.status === "failed") {
      blockerQuality = 0.38;
      actionability = 0.35;
      signals.push("chat_turn_failed");
      if (failedTools.length > 0) {
        blockerQuality = 0.56;
        signals.push("failed_tools_present");
      }
    } else if (candidate.status === "approval_required") {
      blockerQuality = 0.82;
      actionability = 0.62;
      signals.push("approval_required_gate");
    }
    if ((candidate.routing?.liveDataIntent ?? false) && !(candidate.retrieval?.l2Used ?? false)) {
      honesty = 0.48;
      toolEvidence = Math.min(toolEvidence, 0.42);
      signals.push("live_data_without_l2");
    }
    if (executedTools.length > 0) {
      toolEvidence = 0.88;
      honesty = Math.max(honesty, 0.82);
      signals.push("tool_execution_evidence");
    } else if (
      (candidate.routing?.liveDataIntent ?? false) ||
      candidate.webMode === "quick" ||
      candidate.webMode === "deep"
    ) {
      toolEvidence = 0.44;
      signals.push("web_intent_without_execution");
    }
    const attemptedRepair = (candidate.reflection?.attemptCount ?? 0) > 0;
    if ((candidate.status === "failed" || failedTools.length > 0) && !attemptedRepair) {
      retryQuality = 0.32;
      signals.push("missing_reflection_retry");
    } else if (attemptedRepair) {
      retryQuality = 0.86;
      signals.push("reflection_retry_attempted");
    }
    if (blockedTools.length > 0 && blockerQuality < 0.7) {
      blockerQuality = 0.74;
      signals.push("blocked_with_reason");
    }
  } else {
    const status = candidate.status;
    if (status === "executed") {
      toolEvidence = 0.9;
      blockerQuality = 0.8;
      actionability = 0.8;
      signals.push("tool_executed");
    } else if (status === "failed") {
      honesty = 0.58;
      blockerQuality = candidate.error?.trim().length ? 0.62 : 0.34;
      retryQuality = 0.35;
      toolEvidence = 0.45;
      actionability = 0.42;
      signals.push("tool_failed");
    } else if (status === "blocked" || status === "approval_required") {
      blockerQuality = candidate.error?.trim().length ? 0.78 : 0.5;
      actionability = 0.55;
      signals.push("tool_blocked_or_approval");
    }
  }
  return {
    scores: {
      honesty: clampProbability(honesty) as number,
      blockerQuality: clampProbability(blockerQuality) as number,
      retryQuality: clampProbability(retryQuality) as number,
      toolEvidence: clampProbability(toolEvidence) as number,
      actionability: clampProbability(actionability) as number,
    },
    signals,
  };
}

export function computeDecisionWrongnessProbability(
  candidate: DecisionReplayCandidate,
  ruleScores: DecisionReplayItemRuleScores,
  modelScores?: DecisionReplayItemModelScores,
): number {
  const ruleQuality =
    ruleScores.honesty * 0.28 +
    ruleScores.blockerQuality * 0.2 +
    ruleScores.retryQuality * 0.2 +
    ruleScores.toolEvidence * 0.2 +
    ruleScores.actionability * 0.12;
  let ruleWrongness = 1 - ruleQuality;
  if (candidate.status === "failed") ruleWrongness += 0.18;
  else if (candidate.status === "blocked") ruleWrongness += 0.08;
  else if (candidate.status === "approval_required") ruleWrongness += 0.05;
  ruleWrongness = clampProbability(ruleWrongness) as number;
  if (!modelScores) return ruleWrongness;
  const modelWrongness =
    (1 - modelScores.correctnessLikelihood) * 0.55 +
    modelScores.missedToolProbability * 0.3 +
    modelScores.betterResponsePotential * 0.15;
  return clampProbability(ruleWrongness * 0.55 + modelWrongness * 0.45) as number;
}

export function inferDecisionReplayCauseClass(
  candidate: DecisionReplayCandidate,
  ruleScores: DecisionReplayItemRuleScores,
  wrongnessProbability: number,
): DecisionReplayCauseClass {
  if (wrongnessProbability < 0.45) return "other";
  if (candidate.decisionType === "chat_turn") {
    if ((candidate.routing?.liveDataIntent ?? false) && !(candidate.retrieval?.l2Used ?? false)) {
      return candidate.status === "completed" ? "false_refusal_tone" : "retrieval_miss";
    }
    if (candidate.status === "failed" && ruleScores.blockerQuality < 0.5) return "weak_blocker_explanation";
    if ((candidate.status === "failed" || candidate.status === "approval_required") && ruleScores.retryQuality < 0.45)
      return "incomplete_retry_repair";
    if (ruleScores.toolEvidence < 0.45) return "tool_mismatch";
    return "other";
  }
  if ((candidate.status === "blocked" || candidate.status === "approval_required") && ruleScores.blockerQuality < 0.66)
    return "weak_blocker_explanation";
  if (candidate.status === "failed" && ruleScores.retryQuality < 0.5) return "incomplete_retry_repair";
  if (candidate.status === "failed" && ruleScores.toolEvidence < 0.6) return "tool_mismatch";
  return "other";
}

export function buildDecisionReplayItemSummary(
  candidate: DecisionReplayCandidate,
  causeClass: DecisionReplayCauseClass,
): string {
  return candidate.decisionType === "chat_turn"
    ? `Chat turn ${candidate.turnId ?? "unknown"} was tagged ${causeClass} (${candidate.status}).`
    : `Tool ${candidate.toolName ?? "unknown"} run ${candidate.toolRunId ?? "unknown"} was tagged ${causeClass} (${candidate.status}).`;
}

export function titleForDecisionReplayCause(c: DecisionReplayCauseClass): string {
  if (c === "false_refusal_tone") return "False Refusal Tone";
  if (c === "weak_blocker_explanation") return "Weak Blocker Explanations";
  if (c === "tool_mismatch") return "Tool Selection Mismatch";
  if (c === "retrieval_miss") return "Retrieval Misses";
  if (c === "incomplete_retry_repair") return "Incomplete Retry/Repair";
  return "Other Replay Issues";
}

export function recommendationForDecisionReplayCause(c: DecisionReplayCauseClass): string {
  if (c === "false_refusal_tone")
    return "Tighten refusal wording contract and require explicit tool-attempt summary before refusal.";
  if (c === "weak_blocker_explanation")
    return "Improve blocker template with concrete cause, failing step, and next-step fallback fields.";
  if (c === "tool_mismatch")
    return "Re-rank tool selection heuristics and add tie-break preference for higher-evidence tools.";
  if (c === "retrieval_miss") return "Raise live-data intent sensitivity and escalate layered retrieval earlier.";
  if (c === "incomplete_retry_repair")
    return "Trigger one alternate-strategy retry for failed turns before final response.";
  return "Review trace samples and add targeted heuristics for this cluster.";
}

export function summarizeDecisionReplayFinding(group: DecisionReplayItemRecord[]): string {
  const example = group[0];
  if (!example) return "No sample data available.";
  return [
    `Observed ${group.length} similar items.`,
    `Example: ${example.summary ?? `${example.decisionType} ${example.turnId ?? example.toolRunId ?? "unknown"}`}`,
    `Average wrongness: ${(group.reduce((s, i) => s + i.wrongnessProbability, 0) / group.length).toFixed(2)}.`,
  ].join(" ");
}

export function severityRank(severity: DecisionReplayFindingRecord["severity"]): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

export function compareDecisionCauseCounts(
  current: Map<DecisionReplayCauseClass, number>,
  previous: Map<DecisionReplayCauseClass, number>,
): WeeklyImprovementReportRecord["weekOverWeek"] {
  const keys = new Set<DecisionReplayCauseClass>([...current.keys(), ...previous.keys()]);
  const improved: string[] = [],
    regressed: string[] = [],
    unchanged: string[] = [];
  for (const key of keys) {
    const c = current.get(key) ?? 0,
      p = previous.get(key) ?? 0;
    if (c < p) improved.push(`${key}: ${p} -> ${c}`);
    else if (c > p) regressed.push(`${key}: ${p} -> ${c}`);
    else unchanged.push(`${key}: ${c}`);
  }
  return { improved, regressed, unchanged };
}

export function getZonedDateParts(date: Date, timeZone: string): { weekday: number; hour: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const wd = read("weekday").toLowerCase();
  const weekday = wd.startsWith("sun")
    ? 0
    : wd.startsWith("mon")
      ? 1
      : wd.startsWith("tue")
        ? 2
        : wd.startsWith("wed")
          ? 3
          : wd.startsWith("thu")
            ? 4
            : wd.startsWith("fri")
              ? 5
              : 6;
  return { weekday, hour: Number.parseInt(read("hour"), 10) };
}

export function toWeekKeyForTimezone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateStr = formatter.format(date);
  const d = new Date(dateStr);
  const dayOfWeek = d.getDay();
  const diff = d.getDate() - dayOfWeek;
  const weekStart = new Date(d.setDate(diff));
  return `${weekStart.getFullYear()}-W${String(Math.ceil(weekStart.getDate() / 7)).padStart(2, "0")}`;
}

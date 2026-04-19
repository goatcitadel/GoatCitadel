/**
 * Pure, file-scope helpers extracted from PromptLabPage.tsx (Step 10 page slimming).
 *
 * These are stateless functions — no React, no hooks, no closures — so they
 * move cleanly out of the page component file. Keeping them here makes
 * PromptLabPage.tsx smaller and makes the helpers unit-testable in isolation.
 */

import type { PromptPackLatestAssessmentRecordV2, PromptPackRunRecord } from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "../../components/ChatModelPicker";

export type TestResultFilter =
  | "all"
  | "approval_paused"
  | "run_failed"
  | "score_failed"
  | "review"
  | "needs_score"
  | "not_run"
  | "passing";

export const PROMPT_PACK_PASS_THRESHOLD = 75;

export function dedupeStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolvePromptLabActiveProvider(
  providerOptions: ChatModelProviderOption[],
  input: {
    selectedProviderId?: string;
    runtimeActiveProviderId?: string | null;
    preferredProviderId?: string;
  },
): ChatModelProviderOption | undefined {
  if (providerOptions.length === 0) {
    return undefined;
  }

  const preferredProviderId = input.preferredProviderId?.trim() || "openai";
  const candidateProviderIds = [
    input.selectedProviderId,
    preferredProviderId,
    input.runtimeActiveProviderId ?? undefined,
  ];
  for (const providerId of candidateProviderIds) {
    const normalizedProviderId = providerId?.trim();
    if (!normalizedProviderId) {
      continue;
    }
    const match = providerOptions.find((provider) => provider.providerId === normalizedProviderId);
    if (match) {
      return match;
    }
  }
  return providerOptions[0];
}

export function extractPromptPlaceholders(prompt: string): string[] {
  const matches = prompt.match(/<[^<>\n]{3,160}>/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const trimmed = match.trim();
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      continue;
    }
    const looksLikePlaceholder =
      /[A-Z]{2,}/.test(inner) || /[_ ]/.test(inner) || /\b(PASTE|LOCAL|URL|TOPIC|PATH|EXAMPLE|YOUR)\b/i.test(inner);
    if (!looksLikePlaceholder) {
      continue;
    }
    unique.add(`<${inner}>`);
  }
  return Array.from(unique);
}

export function normalizePromptPlaceholderKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  return inner.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseBenchmarkTestCodes(value: string): string[] {
  return dedupeStrings(
    value
      .split(/[\s,]+/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function parseBenchmarkProviders(value: string): Array<{ providerId: string; model: string }> {
  const out: Array<{ providerId: string; model: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of value.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const slash = line.indexOf("/");
    if (slash < 1 || slash === line.length - 1) {
      continue;
    }
    const providerId = line.slice(0, slash).trim();
    const model = line.slice(slash + 1).trim();
    if (!providerId || !model) {
      continue;
    }
    const key = `${providerId}/${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ providerId, model });
  }
  return out;
}

export function formatRunStatus(status?: PromptPackRunRecord["status"]): string {
  if (!status) return "Not run";
  if (status === "completed") return "Run completed";
  if (status === "approval_paused") return "Waiting for approval";
  if (status === "failed") return "Run failed";
  return status;
}

export function resolvePromptPackRunModelUsage(
  run: Pick<PromptPackRunRecord, "providerId" | "model" | "trace"> | null | undefined,
): {
  requestedProviderId?: string;
  requestedModel?: string;
  requestedApiStyle?: string;
  actualProviderId?: string;
  actualModel?: string;
  actualApiStyle?: string;
  fallbackProviderId?: string;
  fallbackModel?: string;
  fallbackReason?: string;
  fallbackUsed: boolean;
} {
  const routing = run?.trace?.routing;
  return {
    requestedProviderId: run?.providerId ?? routing?.primaryProviderId,
    requestedModel: run?.model ?? routing?.primaryModel,
    requestedApiStyle: routing?.primaryApiStyle,
    actualProviderId: routing?.effectiveProviderId ?? run?.providerId ?? routing?.primaryProviderId,
    actualModel: routing?.effectiveModel ?? run?.trace?.model ?? run?.model ?? routing?.primaryModel,
    actualApiStyle: routing?.effectiveApiStyle,
    fallbackProviderId: routing?.fallbackProviderId,
    fallbackModel: routing?.fallbackModel,
    fallbackReason: routing?.fallbackReason,
    fallbackUsed: routing?.fallbackUsed ?? false,
  };
}

export function formatPromptPackProviderModel(providerId?: string, model?: string): string {
  if (!providerId && !model) {
    return "unknown";
  }
  return `${providerId ?? "provider auto"}/${model ?? "provider default"}`;
}

export function formatDateTime(value?: string): string {
  if (!value) {
    return "unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function statusChipClass(status?: PromptPackRunRecord["status"]): string {
  if (!status) return "run-not-run";
  if (status === "completed") return "run-completed";
  if (status === "approval_paused") return "run-paused";
  if (status === "failed") return "run-failed";
  return "run-not-run";
}

export function classifyTestResultCategory(
  run: PromptPackRunRecord | undefined,
  assessment: PromptPackLatestAssessmentRecordV2 | undefined,
): Exclude<TestResultFilter, "all"> {
  if (!run) {
    return "not_run";
  }
  if (run.status === "approval_paused") {
    return "approval_paused";
  }
  if (run.status === "failed") {
    return "run_failed";
  }
  if (run.status !== "completed") {
    return "not_run";
  }
  if (!assessment?.autoScore) {
    if (!assessment?.legacyScore) {
      return "needs_score";
    }
    return assessment.legacyScore.totalScore >= 7 ? "passing" : "score_failed";
  }
  if (assessment.currentGeneration === false) {
    return "needs_score";
  }
  if (assessment.effectiveVerdict === "review") {
    return "review";
  }
  return assessment.effectiveVerdict === "pass" ? "passing" : "score_failed";
}

export function matchesTestResultFilter(
  filter: TestResultFilter,
  run: PromptPackRunRecord | undefined,
  assessment: PromptPackLatestAssessmentRecordV2 | undefined,
): boolean {
  if (filter === "all") {
    return true;
  }
  return classifyTestResultCategory(run, assessment) === filter;
}

export function formatResultCategory(category: Exclude<TestResultFilter, "all">): string {
  if (category === "approval_paused") return "Approval paused";
  if (category === "run_failed") return "Run failure";
  if (category === "score_failed") return "Score failure";
  if (category === "review") return "Review";
  if (category === "needs_score") return "Needs score";
  if (category === "passing") return "Passing";
  return "Not run";
}

export function resultCategoryClass(category: Exclude<TestResultFilter, "all">): string {
  if (category === "approval_paused") return "result-run-paused";
  if (category === "run_failed") return "result-run-failed";
  if (category === "score_failed") return "result-score-failed";
  if (category === "review") return "result-needs-score";
  if (category === "needs_score") return "result-needs-score";
  if (category === "passing") return "result-passing";
  return "result-not-run";
}

export function formatWeightedScore(value?: number): string {
  if (value === undefined || Number.isNaN(value)) {
    return "Needs score";
  }
  return `${value.toFixed(1)}/100`;
}

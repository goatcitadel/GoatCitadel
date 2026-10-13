import type {
  ChatCompletionResponse,
  MemoryContextComposeRequest,
  MemoryContextPack,
  MemoryQmdStatsResponse,
  MemoryRelationScope,
  MemoryRetrievalMatchSignals,
  MemoryRetrievalStatusResponse,
  MemoryRetrievalStrategy,
} from "@goatcitadel/contracts";
import { parseDistillerJson, type ParsedDistillation } from "@goatcitadel/memory-core";

export function parseDistillerResponse(response: ChatCompletionResponse): ParsedDistillation {
  const content = extractMessageContent(response);
  if (!content.trim()) {
    throw new Error("memory distiller returned empty content");
  }
  return parseDistillerJson(content);
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const choice = response.choices?.[0];
  const message = choice?.message;
  if (!message) {
    return "";
  }

  const raw = (message as Record<string, unknown>).content;
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") {
          return text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return "";
}

export function throwIfMemoryContextAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toMemoryContextAbortError(signal);
  }
}

function toMemoryContextAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("memory context composition aborted");
  error.name = "AbortError";
  return error;
}

export function isMemoryContextAbort(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  if (error === signal.reason) return true;
  const record = error as { name?: unknown; message?: unknown };
  return (
    record.name === "AbortError" ||
    String(record.message ?? "")
      .toLowerCase()
      .includes("abort")
  );
}

export function calculateSavings(originalTokens: number, distilledTokens: number): number {
  if (originalTokens <= 0) {
    return 0;
  }
  return Number((((originalTokens - distilledTokens) / originalTokens) * 100).toFixed(2));
}

export function reserveMemoryContextBudget(maxContextTokens: number): number {
  if (maxContextTokens <= 160) {
    return maxContextTokens;
  }
  const reserved = Math.max(96, Math.ceil(maxContextTokens * 0.12));
  return Math.max(128, maxContextTokens - reserved);
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

export function projectMemoryRetrievalStatus(input: {
  checkedAt: string;
  enabled: boolean;
  qmd: MemoryRetrievalStatusResponse["qmd"];
  recentContexts: MemoryContextPack[];
  recentRuns: Array<{ createdAt: string; errorText?: string }>;
  stats: MemoryQmdStatsResponse;
}): MemoryRetrievalStatusResponse {
  const { checkedAt, enabled, qmd, recentContexts, recentRuns, stats } = input;
  const retrievalStrategies = collectRecentRetrievalStrategies(recentContexts);
  const retrievalMode = resolveMemoryRetrievalMode(enabled, retrievalStrategies);
  const rerankMode = resolveMemoryRerankMode(enabled, retrievalStrategies);
  const lastError = recentRuns.find((run) => run.errorText?.trim())?.errorText;
  const lastRefresh = recentRuns[0]?.createdAt ?? recentContexts[0]?.createdAt;
  const fallbackMode = resolveMemoryFallbackMode(
    enabled,
    recentRuns[0]?.errorText,
    recentContexts[0]?.quality.reason,
  );
  return {
    checkedAt,
    enabled,
    retrievalMode,
    rerankAvailable: rerankMode !== "none",
    rerankMode,
    fallbackMode,
    lastRefresh,
    lastError,
    qmd,
    recent: {
      totalRuns: stats.totalRuns,
      generatedRuns: stats.generatedRuns,
      cacheHitRuns: stats.cacheHitRuns,
      fallbackRuns: stats.fallbackRuns,
      failedRuns: stats.failedRuns,
      retrievalStrategies,
    },
  };
}

function collectRecentRetrievalStrategies(recentContexts: MemoryContextPack[]): MemoryRetrievalStrategy[] {
  const strategies = new Set<MemoryRetrievalStrategy>();
  for (const context of recentContexts) {
    for (const citation of context.citations) {
      const strategy = citation.provenance?.retrievalStrategy;
      if (strategy) {
        strategies.add(strategy);
      }
    }
  }
  return [...strategies].sort();
}

function resolveMemoryRetrievalMode(
  enabled: boolean,
  retrievalStrategies: MemoryRetrievalStrategy[],
): MemoryRetrievalStatusResponse["retrievalMode"] {
  if (!enabled) {
    return "disabled";
  }
  if (retrievalStrategies.includes("hybrid_rank")) {
    return "hybrid_rank";
  }
  if (retrievalStrategies.includes("semantic_vector")) {
    return "semantic_vector";
  }
  if (retrievalStrategies.includes("semantic_hints")) {
    return "semantic_hints";
  }
  if (retrievalStrategies.includes("lexical_recency")) {
    return "lexical_recency";
  }
  // Honest default: with no observed semantic/hybrid strategy (e.g. the default
  // pseudo provider, which no longer contributes an embedding score), report
  // lexical_recency rather than implying a hybrid rerank that didn't happen.
  return "lexical_recency";
}

function resolveMemoryRerankMode(
  enabled: boolean,
  retrievalStrategies: MemoryRetrievalStrategy[],
): MemoryRetrievalStatusResponse["rerankMode"] {
  if (!enabled) {
    return "none";
  }
  return retrievalStrategies.includes("hybrid_rank") ? "hybrid_rank" : "none";
}

function resolveMemoryFallbackMode(
  enabled: boolean,
  latestRunError: string | undefined,
  latestQualityReason: string | undefined,
): MemoryRetrievalStatusResponse["fallbackMode"] {
  if (!enabled) {
    return "disabled";
  }
  const reason = latestRunError ?? latestQualityReason ?? "";
  if (/qmd_disabled|prompt_too_short/i.test(reason)) {
    return "short_prompt_or_disabled";
  }
  if (/no_candidates/i.test(reason)) {
    return "no_candidates";
  }
  if (reason.trim()) {
    return "distiller_fallback";
  }
  return "available";
}

export function toCandidateMap(
  candidates: Array<{
    candidateId: string;
    sourceType: "transcript" | "file" | "memory_item";
    timestamp?: string;
    rankScore?: number;
    rankSignals?: MemoryRetrievalMatchSignals;
  }>,
) {
  return new Map(candidates.map((candidate) => [candidate.candidateId, candidate] as const));
}

export function extractMemoryRetrievalHints(metadata: Record<string, unknown>): string[] | undefined {
  const hints = new Set<string>();
  for (const key of ["retrievalHints", "semanticTerms", "tags", "aliases", "keywords"]) {
    for (const value of readStringList(metadata[key])) {
      hints.add(value);
    }
  }
  return hints.size > 0 ? [...hints] : undefined;
}

export function extractMemoryEmbedding(metadata: Record<string, unknown>): number[] | undefined {
  for (const key of ["embedding", "contentEmbedding", "semanticEmbedding"]) {
    const value = metadata[key];
    if (Array.isArray(value) && value.length > 0 && value.every((item) => Number.isFinite(item))) {
      return value.map((item) => Number(item));
    }
  }
  return undefined;
}

function readStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

export function resolveMemoryRelationScope(input: MemoryContextComposeRequest): MemoryRelationScope {
  if (input.relationScope) {
    return input.relationScope;
  }
  if (input.phaseId || input.runId) {
    return "project";
  }
  if (input.taskId) {
    return "peer";
  }
  return "self";
}

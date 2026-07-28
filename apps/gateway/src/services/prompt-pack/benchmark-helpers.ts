import type {
  PromptPackBenchmarkItemRecord,
  PromptPackBenchmarkProviderInput,
  PromptPackBenchmarkRunRecord,
  PromptPackBenchmarkStatusRecord,
  PromptPackRunRecord,
  PromptPackScoreState,
  PromptPackVerdict,
} from "@goatcitadel/contracts";
import { resolvePromptPackExecutionStyle } from "../prompt-pack-execution-profile.js";
import { PROMPT_PACK_BENCHMARK_MAX_FAILURE_SIGNALS } from "../prompt-pack-policy.js";

export interface PromptPackBenchmarkRunRow {
  benchmark_run_id: string;
  pack_id: string;
  status: PromptPackBenchmarkRunRecord["status"];
  test_codes_json: string;
  providers_json: string;
  total_items: number;
  completed_items: number;
  claimed_by_worker_id: string | null;
  claim_heartbeat_at: string | null;
  claim_expires_at: string | null;
  execution_style: string | null;
  pack_content_sha256?: string | null;
  policy_hash?: string | null;
  test_snapshot_json?: string | null;
  test_snapshot_sha256?: string | null;
  scoring_snapshot_json?: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface PromptPackBenchmarkItemRow {
  item_id: string;
  benchmark_run_id: string;
  pack_id: string;
  test_id: string;
  test_code: string;
  provider_id: string;
  model: string;
  run_id: string | null;
  score_id: string | null;
  auto_score_id: string | null;
  run_status: PromptPackBenchmarkItemRecord["runStatus"];
  total_score: number | null;
  weighted_score: number | null;
  verdict: string | null;
  score_state: string | null;
  failure_signal: string | null;
  created_at: string;
}

export function dedupeBenchmarkProviders(
  input: PromptPackBenchmarkProviderInput[],
): PromptPackBenchmarkProviderInput[] {
  const out: PromptPackBenchmarkProviderInput[] = [];
  const seen = new Set<string>();
  for (const item of input ?? []) {
    const providerId = item.providerId?.trim();
    const model = item.model?.trim();
    if (!providerId || !model) {
      continue;
    }
    const key = `${providerId}::${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ providerId, model });
  }
  return out;
}

export async function runPromptPackBenchmarkItemsWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function runWorker(): Promise<void> {
    while (firstError === undefined) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      try {
        await worker(items[currentIndex] as T, currentIndex);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (firstError !== undefined) {
    throw firstError;
  }
}

export function mapPromptPackBenchmarkRunRow(row: PromptPackBenchmarkRunRow): PromptPackBenchmarkRunRecord {
  return {
    benchmarkRunId: row.benchmark_run_id,
    packId: row.pack_id,
    status: row.status,
    testCodes: safeJsonParse<string[]>(row.test_codes_json, []),
    providers: safeJsonParse<PromptPackBenchmarkProviderInput[]>(row.providers_json, []),
    executionStyle: resolvePromptPackExecutionStyle(row.execution_style),
    packContentSha256: row.pack_content_sha256 ?? undefined,
    policyHash: row.policy_hash ?? undefined,
    testSnapshotSha256: row.test_snapshot_sha256 ?? undefined,
    scoringSnapshot: safeJsonParse<Record<string, string>>(row.scoring_snapshot_json ?? "", {}),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

export function mapPromptPackBenchmarkItemRow(row: PromptPackBenchmarkItemRow): PromptPackBenchmarkItemRecord {
  return {
    itemId: row.item_id,
    benchmarkRunId: row.benchmark_run_id,
    packId: row.pack_id,
    testId: row.test_id,
    testCode: row.test_code,
    providerId: row.provider_id,
    model: row.model,
    runId: row.run_id ?? undefined,
    scoreId: row.score_id ?? undefined,
    autoScoreId: row.auto_score_id ?? undefined,
    runStatus: row.run_status,
    totalScore: row.total_score ?? undefined,
    weightedScore: row.weighted_score ?? undefined,
    verdict: (row.verdict as PromptPackVerdict | null) ?? undefined,
    scoreState: (row.score_state as PromptPackScoreState | null) ?? undefined,
    failureSignal: row.failure_signal ?? undefined,
    createdAt: row.created_at,
  };
}

export function summarizePromptPackBenchmarkItems(
  items: PromptPackBenchmarkItemRecord[],
): PromptPackBenchmarkStatusRecord["modelSummaries"] {
  const byModel = new Map<string, PromptPackBenchmarkItemRecord[]>();
  for (const item of items) {
    const key = `${item.providerId}::${item.model}`;
    const list = byModel.get(key) ?? [];
    list.push(item);
    byModel.set(key, list);
  }
  return Array.from(byModel.entries()).map(([key, group]) => {
    const [providerId, model] = key.split("::");
    const runFailures = group.filter((item) => item.runStatus === "failed" || item.runStatus === "missing_run").length;
    const approvalPausedCount = group.filter((item) => item.runStatus === "approval_paused").length;
    const scoredItems = group.filter((item) => item.weightedScore !== undefined || item.totalScore !== undefined);
    const legacyScoreSum = scoredItems.reduce((sum, item) => sum + (item.totalScore ?? 0), 0);
    const weightedScoreSum = scoredItems.reduce((sum, item) => sum + (item.weightedScore ?? 0), 0);
    const avgLegacyScore = scoredItems.length > 0 ? legacyScoreSum / scoredItems.length : 0;
    const avgWeightedScore = scoredItems.length > 0 ? weightedScoreSum / scoredItems.length : 0;
    const passCount = scoredItems.filter((item) => item.verdict === "pass").length;
    const reviewCount = scoredItems.filter((item) => item.verdict === "review").length;
    const degradedCount = scoredItems.filter((item) => item.scoreState === "auto_degraded").length;
    const noOutputCount = group.filter((item) =>
      item.failureSignal?.toLowerCase().includes("no assistant output"),
    ).length;
    const signalCounts = new Map<string, number>();
    for (const item of group) {
      const signal = item.failureSignal?.trim();
      if (signal) {
        signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
      }
    }
    const topFailureSignals = [...signalCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, PROMPT_PACK_BENCHMARK_MAX_FAILURE_SIGNALS)
      .map(([signal, count]) => ({ signal, count }));
    return {
      providerId: providerId ?? "",
      model: model ?? "",
      total: group.length,
      scored: scoredItems.length,
      averageTotalScore: Number(avgLegacyScore.toFixed(2)),
      averageWeightedScore: Number(avgWeightedScore.toFixed(2)),
      passRate: scoredItems.length > 0 ? Number((passCount / scoredItems.length).toFixed(4)) : 0,
      reviewRate: scoredItems.length > 0 ? Number((reviewCount / scoredItems.length).toFixed(4)) : 0,
      runFailures,
      degradedCount,
      approvalPausedCount,
      noOutputCount,
      topFailureSignals,
    };
  });
}

export function summarizePromptPackRunFailure(run: PromptPackRunRecord): string | undefined {
  if (run.status !== "failed" && run.status !== "approval_paused") {
    return undefined;
  }
  if (run.status === "approval_paused") {
    return run.error ?? "approval_paused";
  }
  if (run.error) {
    return run.error.slice(0, 400);
  }
  const trace = run.trace;
  if (trace) {
    const blockedOrFailed = trace.toolRuns.filter(
      (item) => item.status === "failed" || item.status === "blocked" || item.status === "approval_required",
    );
    if (blockedOrFailed.length > 0) {
      return blockedOrFailed
        .map((item) => `${item.toolName}:${item.error ?? item.status}`)
        .join("; ")
        .slice(0, 400);
    }
  }
  return "run_failed_unknown";
}

export function toPromptPackBenchmarkRunRow(value: unknown): PromptPackBenchmarkRunRow | undefined {
  return isPromptPackBenchmarkRunRow(value) ? value : undefined;
}

export function toPromptPackBenchmarkRunRows(value: unknown): PromptPackBenchmarkRunRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackBenchmarkRunRow) : [];
}

export function toPromptPackBenchmarkItemRows(value: unknown): PromptPackBenchmarkItemRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackBenchmarkItemRow) : [];
}

function isPromptPackBenchmarkRunRow(value: unknown): value is PromptPackBenchmarkRunRow {
  return (
    isRecord(value) &&
    typeof value.benchmark_run_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.status === "string" &&
    typeof value.test_codes_json === "string" &&
    typeof value.providers_json === "string" &&
    typeof value.total_items === "number" &&
    typeof value.completed_items === "number" &&
    (typeof value.claimed_by_worker_id === "string" || value.claimed_by_worker_id === null) &&
    (typeof value.claim_heartbeat_at === "string" || value.claim_heartbeat_at === null) &&
    (typeof value.claim_expires_at === "string" || value.claim_expires_at === null) &&
    (typeof value.execution_style === "string" ||
      value.execution_style === null ||
      value.execution_style === undefined) &&
    (typeof value.error === "string" || value.error === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null)
  );
}

function isPromptPackBenchmarkItemRow(value: unknown): value is PromptPackBenchmarkItemRow {
  return (
    isRecord(value) &&
    typeof value.item_id === "string" &&
    typeof value.benchmark_run_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.test_id === "string" &&
    typeof value.test_code === "string" &&
    typeof value.provider_id === "string" &&
    typeof value.model === "string" &&
    (typeof value.run_id === "string" || value.run_id === null) &&
    (typeof value.score_id === "string" || value.score_id === null) &&
    (typeof value.auto_score_id === "string" || value.auto_score_id === null) &&
    typeof value.run_status === "string" &&
    (typeof value.total_score === "number" || value.total_score === null) &&
    (typeof value.weighted_score === "number" || value.weighted_score === null) &&
    (typeof value.verdict === "string" || value.verdict === null) &&
    (typeof value.score_state === "string" || value.score_state === null) &&
    (typeof value.failure_signal === "string" || value.failure_signal === null) &&
    typeof value.created_at === "string"
  );
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

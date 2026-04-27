import type {
  CapabilityTrendSeries,
  PromptPackAutoScoreBatchResult,
  PromptPackAutoScoreResult,
  PromptPackBenchmarkStatusRecord,
  PromptPackExecutionStyle,
  PromptPackExportRecord,
  PromptPackHumanReviewRecordV2,
  PromptPackRecord,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackTestRecord,
  ReplayRegressionResult,
  ReplayRegressionRun,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function importPromptPack(input: {
  content: string;
  name?: string;
  sourceLabel?: string;
  packId?: string;
}): Promise<{
  pack: PromptPackRecord;
  tests: PromptPackTestRecord[];
}> {
  return request("/api/v1/prompt-packs/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchPromptPacks(limit = 200): Promise<{ items: PromptPackRecord[] }> {
  return request<{ items: PromptPackRecord[] }>(`/api/v1/prompt-packs?limit=${Math.max(1, Math.min(limit, 2000))}`);
}

export async function fetchPromptPackTests(packId: string, limit = 2000): Promise<{ items: PromptPackTestRecord[] }> {
  return request<{ items: PromptPackTestRecord[] }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests?limit=${Math.max(1, Math.min(limit, 2000))}`,
  );
}

export async function runPromptPackTest(
  packId: string,
  testId: string,
  input?: {
    sessionId?: string;
    providerId?: string;
    model?: string;
    executionStyle?: PromptPackExecutionStyle;
    placeholderValues?: Record<string, string>;
  },
): Promise<PromptPackRunRecord> {
  return request<PromptPackRunRecord>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/run`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function scorePromptPackTest(
  packId: string,
  testId: string,
  input: {
    runId: string;
    taskSuccess?: 0 | 1 | 2 | 3 | 4 | null;
    honesty?: 0 | 1 | 2 | 3 | 4 | null;
    executionQuality?: 0 | 1 | 2 | 3 | 4 | null;
    robustness?: 0 | 1 | 2 | 3 | 4 | null;
    usability?: 0 | 1 | 2 | 3 | 4 | null;
    overrideVerdict?: "pass" | "fail" | "review";
    notes?: string;
  },
): Promise<PromptPackHumanReviewRecordV2> {
  return request<PromptPackHumanReviewRecordV2>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/score`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function autoScorePromptPackTest(
  packId: string,
  testId: string,
  input?: {
    runId?: string;
    providerId?: string;
    model?: string;
    force?: boolean;
  },
): Promise<PromptPackAutoScoreResult> {
  return request<PromptPackAutoScoreResult>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/auto-score`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function fetchPromptPackReviews(
  packId: string,
  testId: string,
): Promise<{ items: PromptPackHumanReviewRecordV2[] }> {
  return request<{ items: PromptPackHumanReviewRecordV2[] }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId)}/reviews`,
  );
}

export async function autoScorePromptPackBatch(
  packId: string,
  input?: {
    onlyUnscored?: boolean;
    limit?: number;
    providerId?: string;
    model?: string;
    force?: boolean;
  },
): Promise<PromptPackAutoScoreBatchResult> {
  return request<PromptPackAutoScoreBatchResult>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/auto-score`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function fetchPromptPackReport(packId: string): Promise<PromptPackReportRecord> {
  return request<PromptPackReportRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/report`);
}

export async function runPromptPackBenchmark(
  packId: string,
  input: {
    testCodes: string[];
    providers: Array<{
      providerId: string;
      model: string;
    }>;
    executionStyle?: PromptPackExecutionStyle;
  },
): Promise<{ benchmarkRunId: string }> {
  return request<{ benchmarkRunId: string }>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/benchmark/run`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchPromptPackBenchmark(benchmarkRunId: string): Promise<PromptPackBenchmarkStatusRecord> {
  return request<PromptPackBenchmarkStatusRecord>(
    `/api/v1/prompt-packs/benchmark/${encodeURIComponent(benchmarkRunId)}`,
  );
}

export async function cancelPromptPackBenchmark(benchmarkRunId: string): Promise<PromptPackBenchmarkStatusRecord> {
  return request<PromptPackBenchmarkStatusRecord>(
    `/api/v1/prompt-packs/benchmark/${encodeURIComponent(benchmarkRunId)}/cancel`,
    {
      method: "POST",
    },
  );
}

export async function runPromptPackReplayRegression(
  packId: string,
  input: {
    testCodes: string[];
    baselineRef?: string;
  },
): Promise<{ regressionRunId: string }> {
  return request<{ regressionRunId: string }>(
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/replay-regression/run`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchPromptPackReplayRegressionStatus(
  runId: string,
): Promise<{ run: ReplayRegressionRun; results: ReplayRegressionResult[] }> {
  return request<{ run: ReplayRegressionRun; results: ReplayRegressionResult[] }>(
    `/api/v1/prompt-packs/replay-regression/${encodeURIComponent(runId)}`,
  );
}

export async function fetchPromptPackTrends(packId: string): Promise<{ items: CapabilityTrendSeries[] }> {
  return request<{ items: CapabilityTrendSeries[] }>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/trends`);
}

export async function fetchPromptPackExport(packId: string): Promise<PromptPackExportRecord> {
  return request<PromptPackExportRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/export`);
}

export async function exportPromptPackReport(
  packId: string,
  input?: { includeHistory?: boolean },
): Promise<PromptPackExportRecord> {
  return request<PromptPackExportRecord>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/export`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function resetPromptPack(
  packId: string,
  input?: {
    clearRuns?: boolean;
    clearScores?: boolean;
  },
): Promise<{
  packId: string;
  deletedRuns: number;
  deletedScores: number;
  export: PromptPackExportRecord;
}> {
  return request<{
    packId: string;
    deletedRuns: number;
    deletedScores: number;
    export: PromptPackExportRecord;
  }>(`/api/v1/prompt-packs/${encodeURIComponent(packId)}/reset`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

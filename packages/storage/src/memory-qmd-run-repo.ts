import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { MemoryQmdRunRecord, MemoryQmdStatsResponse } from "@goatcitadel/contracts";

interface MemoryQmdRunRow {
  run_event_id: string;
  scope: "chat" | "orchestration";
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  phase_id: string | null;
  status: "generated" | "cache_hit" | "fallback" | "failed";
  provider_id: string | null;
  model: string | null;
  duration_ms: number;
  candidate_count: number;
  citations_count: number;
  original_token_estimate: number;
  distilled_token_estimate: number;
  savings_percent: number;
  error_text: string | null;
  created_at: string;
}

export type MemoryQmdRunInsertInput = Omit<MemoryQmdRunRecord, "runEventId" | "createdAt"> & {
  createdAt?: string;
};

export class MemoryQmdRunRepository {
  private readonly insertStmt;
  private readonly listStmt;
  private readonly statsStmt;
  private readonly pruneOlderThanStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO memory_qmd_runs (
        run_event_id, scope, session_id, task_id, run_id, phase_id, status, provider_id,
        model, duration_ms, candidate_count, citations_count, original_token_estimate,
        distilled_token_estimate, savings_percent, error_text, created_at
      ) VALUES (
        @runEventId, @scope, @sessionId, @taskId, @runId, @phaseId, @status, @providerId,
        @model, @durationMs, @candidateCount, @citationsCount, @originalTokenEstimate,
        @distilledTokenEstimate, @savingsPercent, @errorText, @createdAt
      )
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM memory_qmd_runs
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.statsStmt = db.prepare(`
      SELECT
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'generated' THEN 1 ELSE 0 END) AS generated_runs,
        SUM(CASE WHEN status = 'cache_hit' THEN 1 ELSE 0 END) AS cache_hit_runs,
        SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) AS fallback_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
        SUM(original_token_estimate) AS original_tokens,
        SUM(distilled_token_estimate) AS distilled_tokens
      FROM memory_qmd_runs
      WHERE created_at >= @from
        AND created_at <= @to
    `);
    this.pruneOlderThanStmt = db.prepare(`
      DELETE FROM memory_qmd_runs
      WHERE created_at < @cutoff
    `);
  }

  public append(input: MemoryQmdRunInsertInput): MemoryQmdRunRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const runEventId = randomUUID();
    this.insertStmt.run({
      runEventId,
      scope: input.scope,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      phaseId: input.phaseId ?? null,
      status: input.status,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      durationMs: input.durationMs,
      candidateCount: input.candidateCount,
      citationsCount: input.citationsCount,
      originalTokenEstimate: input.originalTokenEstimate,
      distilledTokenEstimate: input.distilledTokenEstimate,
      savingsPercent: input.savingsPercent,
      errorText: input.errorText ?? null,
      createdAt,
    });

    return {
      runEventId,
      createdAt,
      ...input,
    };
  }

  public list(limit = 100): MemoryQmdRunRecord[] {
    const rows = toMemoryQmdRunRows(this.listStmt.all({ limit }));
    return rows.map(mapRow);
  }

  public stats(from: string, to: string): MemoryQmdStatsResponse {
    const row = this.statsStmt.get({ from, to }) as {
      total_runs: number | null;
      generated_runs: number | null;
      cache_hit_runs: number | null;
      fallback_runs: number | null;
      failed_runs: number | null;
      original_tokens: number | null;
      distilled_tokens: number | null;
    } | undefined;

    const totalRuns = Number(row?.total_runs ?? 0);
    const original = Number(row?.original_tokens ?? 0);
    const distilled = Number(row?.distilled_tokens ?? 0);
    const rawDelta = distilled - original;
    const netTokenDelta = Number(rawDelta.toFixed(2));
    const compressionPercent = original > 0 && distilled < original
      ? Number((((original - distilled) / original) * 100).toFixed(2))
      : 0;
    const expansionPercent = original > 0 && distilled > original
      ? Number((((distilled - original) / original) * 100).toFixed(2))
      : 0;
    const efficiencyLabel: MemoryQmdStatsResponse["efficiencyLabel"] = netTokenDelta < 0
      ? "reduced"
      : netTokenDelta > 0
        ? "expanded"
        : "neutral";

    return {
      from,
      to,
      totalRuns,
      generatedRuns: Number(row?.generated_runs ?? 0),
      cacheHitRuns: Number(row?.cache_hit_runs ?? 0),
      fallbackRuns: Number(row?.fallback_runs ?? 0),
      failedRuns: Number(row?.failed_runs ?? 0),
      originalTokenEstimate: original,
      distilledTokenEstimate: distilled,
      savingsPercent: original > 0 ? Number((((original - distilled) / original) * 100).toFixed(2)) : 0,
      netTokenDelta,
      compressionPercent,
      expansionPercent,
      efficiencyLabel,
    };
  }

  public pruneOlderThan(cutoffIso: string): number {
    const result = this.pruneOlderThanStmt.run({ cutoff: cutoffIso }) as { changes?: number };
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: MemoryQmdRunRow): MemoryQmdRunRecord {
  return {
    runEventId: row.run_event_id,
    scope: row.scope,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined,
    phaseId: row.phase_id ?? undefined,
    status: row.status,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    durationMs: row.duration_ms,
    candidateCount: row.candidate_count,
    citationsCount: row.citations_count,
    originalTokenEstimate: row.original_token_estimate,
    distilledTokenEstimate: row.distilled_token_estimate,
    savingsPercent: row.savings_percent,
    errorText: row.error_text ?? undefined,
    createdAt: row.created_at,
  };
}

function toMemoryQmdRunRows(value: unknown): MemoryQmdRunRow[] {
  return Array.isArray(value) ? value.filter(isMemoryQmdRunRow) : [];
}

function isMemoryQmdRunRow(value: unknown): value is MemoryQmdRunRow {
  return isRecord(value)
    && typeof value.run_event_id === "string"
    && (value.scope === "chat" || value.scope === "orchestration")
    && (typeof value.session_id === "string" || value.session_id === null)
    && (typeof value.task_id === "string" || value.task_id === null)
    && (typeof value.run_id === "string" || value.run_id === null)
    && (typeof value.phase_id === "string" || value.phase_id === null)
    && typeof value.status === "string"
    && (typeof value.provider_id === "string" || value.provider_id === null)
    && (typeof value.model === "string" || value.model === null)
    && typeof value.duration_ms === "number"
    && typeof value.candidate_count === "number"
    && typeof value.citations_count === "number"
    && typeof value.original_token_estimate === "number"
    && typeof value.distilled_token_estimate === "number"
    && typeof value.savings_percent === "number"
    && (typeof value.error_text === "string" || value.error_text === null)
    && typeof value.created_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}



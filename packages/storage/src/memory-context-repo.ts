import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { MemoryContextPack, MemoryContextScope, MemoryCitation, MemoryQmdStatus } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface MemoryContextRow {
  context_id: string;
  cache_key: string;
  scope: MemoryContextScope;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  phase_id: string | null;
  query_hash: string;
  sources_hash: string;
  context_text: string;
  citations_json: string;
  quality_json: string;
  original_token_estimate: number;
  distilled_token_estimate: number;
  created_at: string;
  expires_at: string;
}

export interface MemoryContextInsertInput {
  cacheKey: string;
  scope: MemoryContextScope;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
  queryHash: string;
  sourcesHash: string;
  contextText: string;
  citations: MemoryCitation[];
  quality: {
    status: MemoryQmdStatus;
    reason?: string;
  };
  originalTokenEstimate: number;
  distilledTokenEstimate: number;
  createdAt?: string;
  expiresAt: string;
}

export interface MemoryContextLookupInput {
  cacheKey: string;
  scope: MemoryContextScope;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  phaseId?: string;
}

export class MemoryContextRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getByCacheKeyStmt;
  private readonly listRecentStmt;
  private readonly listByRunStmt;
  private readonly pruneExpiredStmt;
  private readonly pruneOlderThanStmt;

  public constructor(private readonly db: DatabaseClient) {
    const nullableMatch = (column: string, param: string) => buildNullableMatchSql(this.db.dialect, column, param);
    this.insertStmt = db.prepare(`
      INSERT INTO memory_context_packs (
        context_id, cache_key, scope, session_id, task_id, run_id, phase_id,
        query_hash, sources_hash, context_text, citations_json, quality_json,
        original_token_estimate, distilled_token_estimate, created_at, expires_at
      ) VALUES (
        @contextId, @cacheKey, @scope, @sessionId, @taskId, @runId, @phaseId,
        @queryHash, @sourcesHash, @contextText, @citationsJson, @qualityJson,
        @originalTokenEstimate, @distilledTokenEstimate, @createdAt, @expiresAt
      )
      ON CONFLICT(cache_key) DO UPDATE SET
        scope = excluded.scope,
        session_id = excluded.session_id,
        task_id = excluded.task_id,
        run_id = excluded.run_id,
        phase_id = excluded.phase_id,
        query_hash = excluded.query_hash,
        sources_hash = excluded.sources_hash,
        context_text = excluded.context_text,
        citations_json = excluded.citations_json,
        quality_json = excluded.quality_json,
        original_token_estimate = excluded.original_token_estimate,
        distilled_token_estimate = excluded.distilled_token_estimate,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `);
    this.getStmt = db.prepare("SELECT * FROM memory_context_packs WHERE context_id = ?");
    this.getByCacheKeyStmt = db.prepare(`
      SELECT * FROM memory_context_packs
      WHERE cache_key = @cacheKey
        AND scope = @scope
        AND ${nullableMatch("session_id", "@sessionId")}
        AND ${nullableMatch("task_id", "@taskId")}
        AND ${nullableMatch("run_id", "@runId")}
        AND ${nullableMatch("phase_id", "@phaseId")}
        AND expires_at > @now
      LIMIT 1
    `);
    this.listRecentStmt = db.prepare(`
      SELECT * FROM memory_context_packs
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listByRunStmt = db.prepare(`
      SELECT * FROM memory_context_packs
      WHERE run_id = @runId
      ORDER BY created_at DESC
    `);
    this.pruneExpiredStmt = db.prepare(`
      DELETE FROM memory_context_packs
      WHERE expires_at <= @now
    `);
    this.pruneOlderThanStmt = db.prepare(`
      DELETE FROM memory_context_packs
      WHERE created_at < @cutoff
    `);
  }

  public upsert(input: MemoryContextInsertInput): MemoryContextPack {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const contextId = randomUUID();
    const scopedCacheKey = toScopedCacheKey(input);

    this.insertStmt.run({
      contextId,
      cacheKey: scopedCacheKey,
      scope: input.scope,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      phaseId: input.phaseId ?? null,
      queryHash: input.queryHash,
      sourcesHash: input.sourcesHash,
      contextText: input.contextText,
      citationsJson: JSON.stringify(input.citations),
      qualityJson: JSON.stringify(input.quality),
      originalTokenEstimate: input.originalTokenEstimate,
      distilledTokenEstimate: input.distilledTokenEstimate,
      createdAt,
      expiresAt: input.expiresAt,
    });

    const fresh = this.getByCacheKeyStmt.get({
      cacheKey: scopedCacheKey,
      scope: input.scope,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      phaseId: input.phaseId ?? null,
      now: "1970-01-01T00:00:00.000Z",
    });
    const freshRow = toMemoryContextRow(fresh);
    if (!freshRow) {
      throw new NotFoundError("Failed to read memory context pack after upsert");
    }
    return mapRow(freshRow);
  }

  public findFreshByCacheKey(input: MemoryContextLookupInput, now = new Date().toISOString()): MemoryContextPack | undefined {
    const row = toMemoryContextRow(this.getByCacheKeyStmt.get({
      cacheKey: toScopedCacheKey(input),
      scope: input.scope,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      phaseId: input.phaseId ?? null,
      now,
    }));
    return row ? mapRow(row) : undefined;
  }

  public get(contextId: string): MemoryContextPack {
    const row = toMemoryContextRow(this.getStmt.get(contextId));
    if (!row) {
      throw new NotFoundError({ entity: "Memory context", id: contextId });
    }
    return mapRow(row);
  }

  public listRecent(limit = 50): MemoryContextPack[] {
    const rows = toMemoryContextRows(this.listRecentStmt.all({ limit }));
    return rows.map(mapRow);
  }

  public listByRun(runId: string): MemoryContextPack[] {
    const rows = toMemoryContextRows(this.listByRunStmt.all({ runId }));
    return rows.map(mapRow);
  }

  public pruneExpired(nowIso = new Date().toISOString()): number {
    const result = this.pruneExpiredStmt.run({ now: nowIso }) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  public pruneOlderThan(cutoffIso: string): number {
    const result = this.pruneOlderThanStmt.run({ cutoff: cutoffIso }) as { changes?: number };
    return Number(result.changes ?? 0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMemoryContextRow(value: unknown): value is MemoryContextRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.context_id === "string"
    && typeof value.cache_key === "string"
    && typeof value.scope === "string"
    && (typeof value.session_id === "string" || value.session_id === null)
    && (typeof value.task_id === "string" || value.task_id === null)
    && (typeof value.run_id === "string" || value.run_id === null)
    && (typeof value.phase_id === "string" || value.phase_id === null)
    && typeof value.query_hash === "string"
    && typeof value.sources_hash === "string"
    && typeof value.context_text === "string"
    && typeof value.citations_json === "string"
    && typeof value.quality_json === "string"
    && typeof value.original_token_estimate === "number"
    && typeof value.distilled_token_estimate === "number"
    && typeof value.created_at === "string"
    && typeof value.expires_at === "string";
}

function toMemoryContextRow(value: unknown): MemoryContextRow | undefined {
  return isMemoryContextRow(value) ? value : undefined;
}

function toMemoryContextRows(value: unknown): MemoryContextRow[] {
  return Array.isArray(value) ? value.filter(isMemoryContextRow) : [];
}

function mapRow(row: MemoryContextRow): MemoryContextPack {
  const quality = safeJsonParse<{ status?: MemoryQmdStatus; reason?: string }>(row.quality_json, {});
  return {
    contextId: row.context_id,
    scope: row.scope,
    sessionId: row.session_id ?? undefined,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined,
    phaseId: row.phase_id ?? undefined,
    queryHash: row.query_hash,
    sourcesHash: row.sources_hash,
    contextText: row.context_text,
    citations: safeJsonParse<MemoryCitation[]>(row.citations_json, []),
    quality: {
      status: quality.status ?? "generated",
      reason: quality.reason,
    },
    originalTokenEstimate: row.original_token_estimate,
    distilledTokenEstimate: row.distilled_token_estimate,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toScopedCacheKey(input: MemoryContextLookupInput): string {
  return [
    input.scope,
    input.sessionId ?? "",
    input.taskId ?? "",
    input.runId ?? "",
    input.phaseId ?? "",
    input.cacheKey,
  ].join("|");
}

function buildNullableMatchSql(
  dialect: DatabaseClient["dialect"],
  column: string,
  param: string,
): string {
  if (dialect === "postgres") {
    return `${column} IS NOT DISTINCT FROM ${param}`;
  }
  return `${column} IS ${param}`;
}



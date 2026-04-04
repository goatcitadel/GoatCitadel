import type { DatabaseSync } from "node:sqlite";
import type { ChatProactiveMode, ChatReflectionMode, ChatRetrievalMode } from "@goatcitadel/contracts";
import { clampInt, NotFoundError } from "@goatcitadel/contracts";

interface SessionAutonomyPrefsRow {
  session_id: string;
  proactive_mode: ChatProactiveMode;
  max_actions_per_hour: number;
  max_actions_per_turn: number;
  cooldown_seconds: number;
  retrieval_mode: ChatRetrievalMode;
  reflection_mode: ChatReflectionMode;
  last_proactive_at: string | null;
  last_proactive_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionAutonomyPrefsRecord {
  sessionId: string;
  proactiveMode: ChatProactiveMode;
  maxActionsPerHour: number;
  maxActionsPerTurn: number;
  cooldownSeconds: number;
  retrievalMode: ChatRetrievalMode;
  reflectionMode: ChatReflectionMode;
  lastProactiveAt?: string;
  lastProactiveRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionAutonomyPrefsPatchInput {
  proactiveMode?: ChatProactiveMode;
  maxActionsPerHour?: number;
  maxActionsPerTurn?: number;
  cooldownSeconds?: number;
  retrievalMode?: ChatRetrievalMode;
  reflectionMode?: ChatReflectionMode;
}

export const DEFAULT_SESSION_AUTONOMY_PREFS: Omit<
  SessionAutonomyPrefsRecord,
  "sessionId" | "createdAt" | "updatedAt"
> = {
  proactiveMode: "off",
  maxActionsPerHour: 6,
  maxActionsPerTurn: 2,
  cooldownSeconds: 60,
  retrievalMode: "standard",
  reflectionMode: "off",
  lastProactiveAt: undefined,
  lastProactiveRunId: undefined,
};

export class SessionAutonomyPrefsRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly touchStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare(`
      SELECT *
      FROM session_autonomy_prefs
      WHERE session_id = ?
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO session_autonomy_prefs (
        session_id, proactive_mode, max_actions_per_hour, max_actions_per_turn, cooldown_seconds,
        retrieval_mode, reflection_mode, last_proactive_at, last_proactive_run_id, created_at, updated_at
      ) VALUES (
        @sessionId, @proactiveMode, @maxActionsPerHour, @maxActionsPerTurn, @cooldownSeconds,
        @retrievalMode, @reflectionMode, @lastProactiveAt, @lastProactiveRunId, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        proactive_mode = excluded.proactive_mode,
        max_actions_per_hour = excluded.max_actions_per_hour,
        max_actions_per_turn = excluded.max_actions_per_turn,
        cooldown_seconds = excluded.cooldown_seconds,
        retrieval_mode = excluded.retrieval_mode,
        reflection_mode = excluded.reflection_mode,
        last_proactive_at = excluded.last_proactive_at,
        last_proactive_run_id = excluded.last_proactive_run_id,
        updated_at = excluded.updated_at
    `);
    this.touchStmt = db.prepare(`
      UPDATE session_autonomy_prefs
      SET
        last_proactive_at = @lastProactiveAt,
        last_proactive_run_id = @runId,
        updated_at = @updatedAt
      WHERE session_id = @sessionId
    `);
  }

  public get(sessionId: string): SessionAutonomyPrefsRecord | undefined {
    const row = toSessionAutonomyPrefsRow(this.getStmt.get(sessionId));
    return row ? mapRow(row) : undefined;
  }

  public ensure(sessionId: string, now = new Date().toISOString()): SessionAutonomyPrefsRecord {
    const existing = this.get(sessionId);
    if (existing) {
      return existing;
    }
    this.upsertStmt.run({
      sessionId,
      proactiveMode: DEFAULT_SESSION_AUTONOMY_PREFS.proactiveMode,
      maxActionsPerHour: DEFAULT_SESSION_AUTONOMY_PREFS.maxActionsPerHour,
      maxActionsPerTurn: DEFAULT_SESSION_AUTONOMY_PREFS.maxActionsPerTurn,
      cooldownSeconds: DEFAULT_SESSION_AUTONOMY_PREFS.cooldownSeconds,
      retrievalMode: DEFAULT_SESSION_AUTONOMY_PREFS.retrievalMode,
      reflectionMode: DEFAULT_SESSION_AUTONOMY_PREFS.reflectionMode,
      lastProactiveAt: null,
      lastProactiveRunId: null,
      createdAt: now,
      updatedAt: now,
    });
    const created = this.get(sessionId);
    if (!created) {
      throw new NotFoundError({ entity: "session autonomy prefs", id: sessionId });
    }
    return created;
  }

  public patch(
    sessionId: string,
    input: SessionAutonomyPrefsPatchInput,
    now = new Date().toISOString(),
  ): SessionAutonomyPrefsRecord {
    const current = this.ensure(sessionId, now);
    const next: SessionAutonomyPrefsRecord = {
      ...current,
      proactiveMode: input.proactiveMode ?? current.proactiveMode,
      maxActionsPerHour: clampInt(input.maxActionsPerHour, current.maxActionsPerHour, 1, 200),
      maxActionsPerTurn: clampInt(input.maxActionsPerTurn, current.maxActionsPerTurn, 1, 25),
      cooldownSeconds: clampInt(input.cooldownSeconds, current.cooldownSeconds, 0, 3600),
      retrievalMode: input.retrievalMode ?? current.retrievalMode,
      reflectionMode: input.reflectionMode ?? current.reflectionMode,
      updatedAt: now,
    };
    this.upsertStmt.run({
      sessionId: next.sessionId,
      proactiveMode: next.proactiveMode,
      maxActionsPerHour: next.maxActionsPerHour,
      maxActionsPerTurn: next.maxActionsPerTurn,
      cooldownSeconds: next.cooldownSeconds,
      retrievalMode: next.retrievalMode,
      reflectionMode: next.reflectionMode,
      lastProactiveAt: next.lastProactiveAt ?? null,
      lastProactiveRunId: next.lastProactiveRunId ?? null,
      createdAt: current.createdAt,
      updatedAt: next.updatedAt,
    });
    return this.ensure(sessionId, now);
  }

  public touch(sessionId: string, runId: string, now = new Date().toISOString()): SessionAutonomyPrefsRecord {
    this.ensure(sessionId, now);
    this.touchStmt.run({
      sessionId,
      runId,
      lastProactiveAt: now,
      updatedAt: now,
    });
    return this.ensure(sessionId, now);
  }

  public listBySessionIds(sessionIds: string[]): Map<string, SessionAutonomyPrefsRecord> {
    const uniqueSessionIds = [...new Set(sessionIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueSessionIds.length === 0) {
      return new Map();
    }
    const rows: SessionAutonomyPrefsRow[] = [];
    for (let index = 0; index < uniqueSessionIds.length; index += 400) {
      const batch = uniqueSessionIds.slice(index, index + 400);
      const placeholders = batch.map(() => "?").join(", ");
      const stmt = this.db.prepare(`
        SELECT *
        FROM session_autonomy_prefs
        WHERE session_id IN (${placeholders})
      `);
      rows.push(...toSessionAutonomyPrefsRows(stmt.all(...batch)));
    }
    const mapped = rows.map((row) => mapRow(row));
    return new Map(mapped.map((row) => [row.sessionId, row]));
  }
}

function mapRow(row: SessionAutonomyPrefsRow): SessionAutonomyPrefsRecord {
  return {
    sessionId: row.session_id,
    proactiveMode: row.proactive_mode,
    maxActionsPerHour: clampInt(row.max_actions_per_hour, DEFAULT_SESSION_AUTONOMY_PREFS.maxActionsPerHour, 1, 200),
    maxActionsPerTurn: clampInt(row.max_actions_per_turn, DEFAULT_SESSION_AUTONOMY_PREFS.maxActionsPerTurn, 1, 25),
    cooldownSeconds: clampInt(row.cooldown_seconds, DEFAULT_SESSION_AUTONOMY_PREFS.cooldownSeconds, 0, 3600),
    retrievalMode: row.retrieval_mode,
    reflectionMode: row.reflection_mode,
    lastProactiveAt: row.last_proactive_at ?? undefined,
    lastProactiveRunId: row.last_proactive_run_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSessionAutonomyPrefsRow(value: unknown): SessionAutonomyPrefsRow | undefined {
  return isSessionAutonomyPrefsRow(value) ? value : undefined;
}

function toSessionAutonomyPrefsRows(value: unknown): SessionAutonomyPrefsRow[] {
  return Array.isArray(value) ? value.filter(isSessionAutonomyPrefsRow) : [];
}

function isSessionAutonomyPrefsRow(value: unknown): value is SessionAutonomyPrefsRow {
  return isRecord(value)
    && typeof value.session_id === "string"
    && typeof value.proactive_mode === "string"
    && typeof value.max_actions_per_hour === "number"
    && typeof value.max_actions_per_turn === "number"
    && typeof value.cooldown_seconds === "number"
    && typeof value.retrieval_mode === "string"
    && typeof value.reflection_mode === "string"
    && (typeof value.last_proactive_at === "string" || value.last_proactive_at === null)
    && (typeof value.last_proactive_run_id === "string" || value.last_proactive_run_id === null)
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

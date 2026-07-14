import type { DatabaseClient } from "./db.js";
import type { ChatProactiveMode, ChatReflectionMode, ChatRetrievalMode } from "@goatcitadel/contracts";
import { clampInt, NotFoundError } from "@goatcitadel/contracts";
import { ChatSessionRevisionRepository } from "./chat-session-revision-repo.js";

interface SessionAutonomyPrefsRow {
  session_id: string;
  aggregate_revision: number | null | undefined;
  proactive_mode: ChatProactiveMode;
  max_actions_per_hour: number;
  max_actions_per_turn: number;
  cooldown_seconds: number;
  retrieval_mode: ChatRetrievalMode;
  reflection_mode: ChatReflectionMode;
  last_proactive_at: string | null;
  last_proactive_run_id: string | null;
  // P1-F4 heartbeat columns (added in migration 124, default-on posture).
  heartbeat_enabled: number;
  heartbeat_interval_seconds: number;
  active_hours_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Active-hours window for autonomous self-wake (P1-F4). `start`/`end` are local
 * hours; `tz` is an optional IANA timezone hint reserved for future per-session
 * scheduling (the runtime currently evaluates against the host's local hour, so
 * the field is persisted round-trip but not yet consulted).
 */
export interface SessionActiveHoursWindow {
  tz?: string;
  /** Inclusive local start hour [0, 24]. */
  start: number;
  /** Exclusive local end hour [0, 24]. `start === end` ⇒ always active. */
  end: number;
}

export interface SessionAutonomyPrefsRecord {
  sessionId: string;
  revision: number;
  proactiveMode: ChatProactiveMode;
  maxActionsPerHour: number;
  maxActionsPerTurn: number;
  cooldownSeconds: number;
  retrievalMode: ChatRetrievalMode;
  reflectionMode: ChatReflectionMode;
  lastProactiveAt?: string;
  lastProactiveRunId?: string;
  /** P1-F4: whether silent self-wake heartbeats may fire for this session. */
  heartbeatEnabled: boolean;
  /** P1-F4: floor interval between heartbeats, seconds. */
  heartbeatIntervalSeconds: number;
  /** P1-F4: local active-hours window heartbeats are confined to. */
  activeHours: SessionActiveHoursWindow;
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
  heartbeatEnabled?: boolean;
  heartbeatIntervalSeconds?: number;
  activeHours?: SessionActiveHoursWindow;
}

/** Default active-hours window: 08:00–22:00 local (matches the F3 sweep default). */
export const DEFAULT_SESSION_ACTIVE_HOURS: SessionActiveHoursWindow = { start: 8, end: 22 };

/** Heartbeat interval floor / default, seconds (1 hour). */
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 3600;

export const DEFAULT_SESSION_AUTONOMY_PREFS: Omit<
  SessionAutonomyPrefsRecord,
  "sessionId" | "revision" | "createdAt" | "updatedAt"
> = {
  proactiveMode: "off",
  maxActionsPerHour: 6,
  maxActionsPerTurn: 2,
  cooldownSeconds: 60,
  retrievalMode: "standard",
  reflectionMode: "off",
  lastProactiveAt: undefined,
  lastProactiveRunId: undefined,
  // Heartbeat defaults to ON (the chosen on-by-default posture). Cost note: every
  // eligible idle human session fires one read-only model call per interval.
  heartbeatEnabled: true,
  heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  activeHours: DEFAULT_SESSION_ACTIVE_HOURS,
};

export class SessionAutonomyPrefsRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly touchStmt;
  private readonly revisions;

  public constructor(private readonly db: DatabaseClient) {
    this.revisions = new ChatSessionRevisionRepository(db);
    this.getStmt = db.prepare(`
      SELECT prefs.*, meta.revision AS aggregate_revision
      FROM session_autonomy_prefs AS prefs
      LEFT JOIN chat_session_meta AS meta ON meta.session_id = prefs.session_id
      WHERE prefs.session_id = ?
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO session_autonomy_prefs (
        session_id, proactive_mode, max_actions_per_hour, max_actions_per_turn, cooldown_seconds,
        retrieval_mode, reflection_mode, last_proactive_at, last_proactive_run_id,
        heartbeat_enabled, heartbeat_interval_seconds, active_hours_json, created_at, updated_at
      ) VALUES (
        @sessionId, @proactiveMode, @maxActionsPerHour, @maxActionsPerTurn, @cooldownSeconds,
        @retrievalMode, @reflectionMode, @lastProactiveAt, @lastProactiveRunId,
        @heartbeatEnabled, @heartbeatIntervalSeconds, @activeHoursJson, @createdAt, @updatedAt
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
        heartbeat_enabled = excluded.heartbeat_enabled,
        heartbeat_interval_seconds = excluded.heartbeat_interval_seconds,
        active_hours_json = excluded.active_hours_json,
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
    const revision = this.revisions.ensure(sessionId, now);
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
      heartbeatEnabled: DEFAULT_SESSION_AUTONOMY_PREFS.heartbeatEnabled ? 1 : 0,
      heartbeatIntervalSeconds: DEFAULT_SESSION_AUTONOMY_PREFS.heartbeatIntervalSeconds,
      activeHoursJson: serializeActiveHours(DEFAULT_SESSION_AUTONOMY_PREFS.activeHours),
      createdAt: now,
      updatedAt: now,
    });
    const created = this.get(sessionId);
    if (!created) {
      throw new NotFoundError({ entity: "session autonomy prefs", id: sessionId });
    }
    return { ...created, revision: revision.revision };
  }

  public patch(
    sessionId: string,
    input: SessionAutonomyPrefsPatchInput,
    now = new Date().toISOString(),
  ): SessionAutonomyPrefsRecord {
    const current = this.ensure(sessionId, now);
    return this.patchWithRevision(sessionId, input, current.revision, now);
  }

  public patchWithRevision(
    sessionId: string,
    input: SessionAutonomyPrefsPatchInput,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): SessionAutonomyPrefsRecord {
    const result = this.revisions.runWithRevision(
      sessionId,
      expectedRevision,
      () => this.patchWithinAggregate(sessionId, input, expectedRevision, now),
      now,
    );
    return { ...result.value, revision: result.revision };
  }

  /**
   * Transaction-internal child mutation used by aggregate chat-session writes.
   * The caller must already hold the chat-session revision fence and owns the
   * single aggregate revision bump.
   */
  public patchWithinAggregate(
    sessionId: string,
    input: SessionAutonomyPrefsPatchInput,
    revision: number,
    now = new Date().toISOString(),
  ): { value: SessionAutonomyPrefsRecord; changed: boolean } {
    const current = this.get(sessionId) ?? this.createDefaultsUnchecked(sessionId, now, revision);
    const next: SessionAutonomyPrefsRecord = {
      ...current,
      proactiveMode: input.proactiveMode ?? current.proactiveMode,
      maxActionsPerHour: clampInt(input.maxActionsPerHour, current.maxActionsPerHour, 1, 200),
      maxActionsPerTurn: clampInt(input.maxActionsPerTurn, current.maxActionsPerTurn, 1, 25),
      cooldownSeconds: clampInt(input.cooldownSeconds, current.cooldownSeconds, 0, 3600),
      retrievalMode: input.retrievalMode ?? current.retrievalMode,
      reflectionMode: input.reflectionMode ?? current.reflectionMode,
      heartbeatEnabled: input.heartbeatEnabled ?? current.heartbeatEnabled,
      heartbeatIntervalSeconds: clampInt(
        input.heartbeatIntervalSeconds,
        current.heartbeatIntervalSeconds,
        DEFAULT_HEARTBEAT_INTERVAL_SECONDS_FLOOR,
        DEFAULT_HEARTBEAT_INTERVAL_SECONDS_CEILING,
      ),
      activeHours: input.activeHours ? normalizeActiveHours(input.activeHours) : current.activeHours,
      updatedAt: now,
    };
    if (isSemanticNoop(current, next)) {
      return { value: { ...current, revision }, changed: false };
    }
    this.upsertStmt.run(toWriteParams(next, current.createdAt));
    return { value: { ...this.requireRecord(sessionId), revision }, changed: true };
  }

  public touch(sessionId: string, runId: string, now = new Date().toISOString()): SessionAutonomyPrefsRecord {
    this.ensure(sessionId, now);
    this.touchStmt.run({
      sessionId,
      runId,
      lastProactiveAt: now,
      updatedAt: now,
    });
    return this.requireRecord(sessionId);
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
        SELECT prefs.*, meta.revision AS aggregate_revision
        FROM session_autonomy_prefs AS prefs
        LEFT JOIN chat_session_meta AS meta ON meta.session_id = prefs.session_id
        WHERE prefs.session_id IN (${placeholders})
      `);
      rows.push(...toSessionAutonomyPrefsRows(stmt.all(...batch)));
    }
    const mapped = rows.map((row) => mapRow(row));
    return new Map(mapped.map((row) => [row.sessionId, row]));
  }

  private createDefaultsUnchecked(sessionId: string, now: string, revision: number): SessionAutonomyPrefsRecord {
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
      heartbeatEnabled: DEFAULT_SESSION_AUTONOMY_PREFS.heartbeatEnabled ? 1 : 0,
      heartbeatIntervalSeconds: DEFAULT_SESSION_AUTONOMY_PREFS.heartbeatIntervalSeconds,
      activeHoursJson: serializeActiveHours(DEFAULT_SESSION_AUTONOMY_PREFS.activeHours),
      createdAt: now,
      updatedAt: now,
    });
    return { ...this.requireRecord(sessionId), revision };
  }

  private requireRecord(sessionId: string): SessionAutonomyPrefsRecord {
    const record = this.get(sessionId);
    if (!record) {
      throw new NotFoundError({ entity: "session autonomy prefs", id: sessionId });
    }
    return record;
  }
}

function mapRow(row: SessionAutonomyPrefsRow): SessionAutonomyPrefsRecord {
  return {
    sessionId: row.session_id,
    revision: normalizeAggregateRevision(row.aggregate_revision),
    proactiveMode: row.proactive_mode,
    maxActionsPerHour: clampInt(row.max_actions_per_hour, DEFAULT_SESSION_AUTONOMY_PREFS.maxActionsPerHour, 1, 200),
    maxActionsPerTurn: clampInt(row.max_actions_per_turn, DEFAULT_SESSION_AUTONOMY_PREFS.maxActionsPerTurn, 1, 25),
    cooldownSeconds: clampInt(row.cooldown_seconds, DEFAULT_SESSION_AUTONOMY_PREFS.cooldownSeconds, 0, 3600),
    retrievalMode: row.retrieval_mode,
    reflectionMode: row.reflection_mode,
    lastProactiveAt: row.last_proactive_at ?? undefined,
    lastProactiveRunId: row.last_proactive_run_id ?? undefined,
    heartbeatEnabled: row.heartbeat_enabled !== 0,
    heartbeatIntervalSeconds: clampInt(
      row.heartbeat_interval_seconds,
      DEFAULT_SESSION_AUTONOMY_PREFS.heartbeatIntervalSeconds,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS_FLOOR,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS_CEILING,
    ),
    activeHours: parseActiveHours(row.active_hours_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Interval floor (15 min) — mirrors the schedule-tool interval floor. */
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS_FLOOR = 15 * 60;
/** Interval ceiling (24 h). */
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS_CEILING = 24 * 60 * 60;

/** Clamp an active-hours window into integer hours in [0, 24]. */
function normalizeActiveHours(window: SessionActiveHoursWindow): SessionActiveHoursWindow {
  const start = clampInt(window.start, DEFAULT_SESSION_ACTIVE_HOURS.start, 0, 24);
  const end = clampInt(window.end, DEFAULT_SESSION_ACTIVE_HOURS.end, 0, 24);
  const tz = typeof window.tz === "string" && window.tz.trim().length > 0 ? window.tz.trim() : undefined;
  return tz ? { tz, start, end } : { start, end };
}

function serializeActiveHours(window: SessionActiveHoursWindow): string {
  return JSON.stringify(normalizeActiveHours(window));
}

/** Parse a persisted active-hours JSON blob, falling back to the default window. */
function parseActiveHours(raw: string | null): SessionActiveHoursWindow {
  if (!raw) {
    return DEFAULT_SESSION_ACTIVE_HOURS;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.start === "number" && typeof parsed.end === "number") {
      return normalizeActiveHours({
        start: parsed.start,
        end: parsed.end,
        ...(typeof parsed.tz === "string" ? { tz: parsed.tz } : {}),
      });
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_SESSION_ACTIVE_HOURS;
}

function toSessionAutonomyPrefsRow(value: unknown): SessionAutonomyPrefsRow | undefined {
  return isSessionAutonomyPrefsRow(value) ? value : undefined;
}

function toSessionAutonomyPrefsRows(value: unknown): SessionAutonomyPrefsRow[] {
  return Array.isArray(value) ? value.filter(isSessionAutonomyPrefsRow) : [];
}

function isSessionAutonomyPrefsRow(value: unknown): value is SessionAutonomyPrefsRow {
  return (
    isRecord(value) &&
    typeof value.session_id === "string" &&
    (typeof value.aggregate_revision === "number" ||
      value.aggregate_revision === null ||
      value.aggregate_revision === undefined) &&
    typeof value.proactive_mode === "string" &&
    typeof value.max_actions_per_hour === "number" &&
    typeof value.max_actions_per_turn === "number" &&
    typeof value.cooldown_seconds === "number" &&
    typeof value.retrieval_mode === "string" &&
    typeof value.reflection_mode === "string" &&
    (typeof value.last_proactive_at === "string" || value.last_proactive_at === null) &&
    (typeof value.last_proactive_run_id === "string" || value.last_proactive_run_id === null) &&
    typeof value.heartbeat_enabled === "number" &&
    typeof value.heartbeat_interval_seconds === "number" &&
    (typeof value.active_hours_json === "string" || value.active_hours_json === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeAggregateRevision(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

function isSemanticNoop(current: SessionAutonomyPrefsRecord, next: SessionAutonomyPrefsRecord): boolean {
  return (
    next.proactiveMode === current.proactiveMode &&
    next.maxActionsPerHour === current.maxActionsPerHour &&
    next.maxActionsPerTurn === current.maxActionsPerTurn &&
    next.cooldownSeconds === current.cooldownSeconds &&
    next.retrievalMode === current.retrievalMode &&
    next.reflectionMode === current.reflectionMode &&
    next.heartbeatEnabled === current.heartbeatEnabled &&
    next.heartbeatIntervalSeconds === current.heartbeatIntervalSeconds &&
    serializeActiveHours(next.activeHours) === serializeActiveHours(current.activeHours)
  );
}

function toWriteParams(next: SessionAutonomyPrefsRecord, createdAt: string): Record<string, unknown> {
  return {
    sessionId: next.sessionId,
    proactiveMode: next.proactiveMode,
    maxActionsPerHour: next.maxActionsPerHour,
    maxActionsPerTurn: next.maxActionsPerTurn,
    cooldownSeconds: next.cooldownSeconds,
    retrievalMode: next.retrievalMode,
    reflectionMode: next.reflectionMode,
    lastProactiveAt: next.lastProactiveAt ?? null,
    lastProactiveRunId: next.lastProactiveRunId ?? null,
    heartbeatEnabled: next.heartbeatEnabled ? 1 : 0,
    heartbeatIntervalSeconds: next.heartbeatIntervalSeconds,
    activeHoursJson: serializeActiveHours(next.activeHours),
    createdAt,
    updatedAt: next.updatedAt,
  };
}

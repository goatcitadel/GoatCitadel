import type { OperatorSummary, SessionMeta } from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseSync } from "node:sqlite";
import { safeJsonParse } from "./safe-json.js";

interface SessionRow {
  session_id: string;
  session_key: string;
  kind: "dm" | "group" | "thread";
  channel: string;
  account: string;
  display_name: string | null;
  routing_hints_json: string | null;
  last_activity_at: string;
  updated_at: string;
  health: SessionMeta["health"];
  token_input: number;
  token_output: number;
  token_cached_input: number;
  token_total: number;
  cost_usd_total: number;
  budget_state: SessionMeta["budgetState"];
}

interface OperatorSummaryRow {
  operator_id: string;
  session_count: number;
  active_sessions: number;
  last_activity_at: string | null;
}

export interface SessionUpsertInput {
  sessionId: string;
  sessionKey: string;
  kind: SessionMeta["kind"];
  channel: string;
  account: string;
  displayName?: string;
  routingHints?: Record<string, string>;
  timestamp: string;
}

export interface SessionUsageDelta {
  sessionId: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCachedInput: number;
  costUsd: number;
  timestamp: string;
}

export class SessionRepository {
  private readonly getByKeyStmt;
  private readonly getByIdStmt;
  private readonly upsertStmt;
  private readonly applyUsageStmt;
  private readonly listStmt;
  private readonly listOperatorSummariesStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getByKeyStmt = db.prepare("SELECT * FROM sessions WHERE session_key = ?");
    this.getByIdStmt = db.prepare("SELECT * FROM sessions WHERE session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO sessions (
        session_id, session_key, kind, channel, account, display_name, routing_hints_json,
        last_activity_at, updated_at
      ) VALUES (@sessionId, @sessionKey, @kind, @channel, @account, @displayName, @routingHintsJson, @timestamp, @timestamp)
      ON CONFLICT(session_key) DO UPDATE SET
        display_name = excluded.display_name,
        routing_hints_json = excluded.routing_hints_json,
        last_activity_at = excluded.last_activity_at,
        updated_at = excluded.updated_at
    `);
    this.applyUsageStmt = db.prepare(`
      UPDATE sessions
      SET
        token_input = token_input + @tokenInput,
        token_output = token_output + @tokenOutput,
        token_cached_input = token_cached_input + @tokenCachedInput,
        token_total = token_total + (@tokenInput + @tokenOutput),
        cost_usd_total = cost_usd_total + @costUsd,
        last_activity_at = @timestamp,
        updated_at = @timestamp
      WHERE session_id = @sessionId
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM sessions
      WHERE (
        @cursorUpdatedAt IS NULL
        OR updated_at < @cursorUpdatedAt
        OR (updated_at = @cursorUpdatedAt AND session_id < @cursorSessionId)
      )
      ORDER BY updated_at DESC, session_id DESC
      LIMIT @limit
    `);
    this.listOperatorSummariesStmt = db.prepare(`
      SELECT
        account AS operator_id,
        COUNT(*) AS session_count,
        SUM(CASE WHEN last_activity_at >= @activeSinceIso THEN 1 ELSE 0 END) AS active_sessions,
        MAX(last_activity_at) AS last_activity_at
      FROM sessions
      GROUP BY account
      ORDER BY MAX(last_activity_at) DESC
    `);
  }

  public upsert(input: SessionUpsertInput): SessionMeta {
    this.upsertStmt.run({
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      kind: input.kind,
      channel: input.channel,
      account: input.account,
      displayName: input.displayName ?? null,
      routingHintsJson: input.routingHints ? JSON.stringify(input.routingHints) : null,
      timestamp: input.timestamp,
    });

    return this.getBySessionKey(input.sessionKey);
  }

  public applyUsage(delta: SessionUsageDelta): void {
    this.applyUsageStmt.run({
      sessionId: delta.sessionId,
      tokenInput: delta.tokenInput,
      tokenOutput: delta.tokenOutput,
      tokenCachedInput: delta.tokenCachedInput,
      costUsd: delta.costUsd,
      timestamp: delta.timestamp,
    });
  }

  public getBySessionKey(sessionKey: string): SessionMeta {
    const row = this.getByKeyStmt.get(sessionKey) as SessionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Session", id: sessionKey });
    }

    return mapSessionRow(row);
  }

  public getBySessionId(sessionId: string): SessionMeta {
    const row = this.getByIdStmt.get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Session", id: sessionId });
    }

    return mapSessionRow(row);
  }

  public list(limit: number, cursor?: string): SessionMeta[] {
    const parsedCursor = parseCompositeCursor(cursor);
    const rows = this.listStmt.all({
      limit,
      cursorUpdatedAt: parsedCursor?.timestamp ?? null,
      cursorSessionId: parsedCursor?.key ?? null,
    });

    assertSessionRows(rows);
    const sessionRows: SessionRow[] = rows;

    return sessionRows.map(mapSessionRow);
  }

  public listOperatorSummaries(activeSinceIso: string): OperatorSummary[] {
    const rows = this.listOperatorSummariesStmt.all({
      activeSinceIso,
    });

    assertOperatorSummaryRows(rows);
    const operatorSummaryRows: OperatorSummaryRow[] = rows;

    return operatorSummaryRows.map((row) => ({
      operatorId: row.operator_id,
      sessionCount: row.session_count,
      activeSessions: row.active_sessions,
      lastActivityAt: row.last_activity_at ?? undefined,
    }));
  }
}

interface CompositeCursor {
  timestamp: string;
  key: string;
}

function parseCompositeCursor(cursor?: string): CompositeCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) {
    return {
      timestamp: cursor,
      key: "",
    };
  }

  const timestamp = cursor.slice(0, separator);
  const key = cursor.slice(separator + 1);
  if (!timestamp || !key) {
    return undefined;
  }

  return { timestamp, key };
}

function assertSessionRows(rows: unknown): asserts rows is SessionRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isSessionRow(row))) {
    throw new TypeError("Unexpected sessions row shape");
  }
}

function assertOperatorSummaryRows(rows: unknown): asserts rows is OperatorSummaryRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isOperatorSummaryRow(row))) {
    throw new TypeError("Unexpected operator summary row shape");
  }
}

function isSessionRow(value: unknown): value is SessionRow {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.session_id === "string"
    && typeof value.session_key === "string"
    && (value.kind === "dm" || value.kind === "group" || value.kind === "thread")
    && typeof value.channel === "string"
    && typeof value.account === "string"
    && (typeof value.display_name === "string" || value.display_name === null)
    && (typeof value.routing_hints_json === "string" || value.routing_hints_json === null)
    && typeof value.last_activity_at === "string"
    && typeof value.updated_at === "string"
    && typeof value.health === "string"
    && typeof value.token_input === "number"
    && typeof value.token_output === "number"
    && typeof value.token_cached_input === "number"
    && typeof value.token_total === "number"
    && typeof value.cost_usd_total === "number"
    && typeof value.budget_state === "string";
}

function isOperatorSummaryRow(value: unknown): value is OperatorSummaryRow {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.operator_id === "string"
    && typeof value.session_count === "number"
    && typeof value.active_sessions === "number"
    && (typeof value.last_activity_at === "string" || value.last_activity_at === null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapSessionRow(row: SessionRow): SessionMeta {
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    kind: row.kind,
    channel: row.channel,
    account: row.account,
    displayName: row.display_name ?? undefined,
    routingHints: safeJsonParse<Record<string, string> | undefined>(row.routing_hints_json, undefined),
    lastActivityAt: row.last_activity_at,
    updatedAt: row.updated_at,
    health: row.health,
    tokenInput: row.token_input,
    tokenOutput: row.token_output,
    tokenCachedInput: row.token_cached_input,
    tokenTotal: row.token_total,
    costUsdTotal: row.cost_usd_total,
    budgetState: row.budget_state,
  };
}

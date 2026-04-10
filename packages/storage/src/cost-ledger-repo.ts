import type { DatabaseClient } from "./db.js";

export interface CostLedgerRecord {
  sessionId: string;
  agentId?: string;
  taskId?: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCachedInput: number;
  costUsd: number;
  createdAt: string;
}

export interface CostSummary {
  scope: "session" | "day" | "agent" | "task";
  key: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCachedInput: number;
  tokenTotal: number;
  costUsd: number;
}

export interface CostUsageAvailability {
  trackedEvents: number;
  unknownEvents: number;
  totalAgentEvents: number;
}

export class CostLedgerRepository {
  private readonly insertStmt;
  private readonly summaryByDayStmt;
  private readonly summaryBySessionStmt;
  private readonly summaryByAgentStmt;
  private readonly summaryByTaskStmt;
  private readonly summaryUsageAvailabilityStmt;
  private readonly pruneStmt;
  private insertCount = 0;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO cost_ledger (
        session_id, agent_id, task_id, day,
        token_input, token_output, token_cached_input, cost_usd, created_at
      ) VALUES (
        @sessionId, @agentId, @taskId, @day,
        @tokenInput, @tokenOutput, @tokenCachedInput, @costUsd, @createdAt
      )
    `);

    this.summaryByDayStmt = db.prepare(`
      SELECT
        day AS key,
        SUM(token_input) AS token_input,
        SUM(token_output) AS token_output,
        SUM(token_cached_input) AS token_cached_input,
        SUM(cost_usd) AS cost_usd
      FROM cost_ledger
      WHERE day >= @fromDay AND day <= @toDay
      GROUP BY day
      ORDER BY day DESC
    `);

    this.summaryBySessionStmt = db.prepare(`
      SELECT
        session_id AS key,
        SUM(token_input) AS token_input,
        SUM(token_output) AS token_output,
        SUM(token_cached_input) AS token_cached_input,
        SUM(cost_usd) AS cost_usd
      FROM cost_ledger
      WHERE created_at >= @from AND created_at <= @to
      GROUP BY session_id
      ORDER BY SUM(cost_usd) DESC
    `);

    this.summaryByAgentStmt = db.prepare(`
      SELECT
        agent_id AS key,
        SUM(token_input) AS token_input,
        SUM(token_output) AS token_output,
        SUM(token_cached_input) AS token_cached_input,
        SUM(cost_usd) AS cost_usd
      FROM cost_ledger
      WHERE created_at >= @from AND created_at <= @to AND agent_id IS NOT NULL
      GROUP BY agent_id
      ORDER BY SUM(cost_usd) DESC
    `);

    this.summaryByTaskStmt = db.prepare(`
      SELECT
        task_id AS key,
        SUM(token_input) AS token_input,
        SUM(token_output) AS token_output,
        SUM(token_cached_input) AS token_cached_input,
        SUM(cost_usd) AS cost_usd
      FROM cost_ledger
      WHERE created_at >= @from AND created_at <= @to AND task_id IS NOT NULL
      GROUP BY task_id
      ORDER BY SUM(cost_usd) DESC
    `);

    this.summaryUsageAvailabilityStmt = db.prepare(`
      SELECT
        COUNT(*) AS total_agent_events,
        SUM(CASE WHEN token_input > 0 OR token_output > 0 OR token_cached_input > 0 OR cost_usd > 0 THEN 1 ELSE 0 END) AS tracked_events,
        SUM(CASE WHEN token_input = 0 AND token_output = 0 AND token_cached_input = 0 AND cost_usd = 0 THEN 1 ELSE 0 END) AS unknown_events
      FROM cost_ledger
      WHERE created_at >= @from
        AND created_at <= @to
        AND agent_id IS NOT NULL
    `);

    this.pruneStmt = db.prepare(`
      DELETE FROM cost_ledger
      WHERE created_at < @cutoff
    `);
  }

  public insert(record: CostLedgerRecord): void {
    const day = record.createdAt.slice(0, 10);
    const nextInsertCount = this.insertCount + 1;
    const shouldPrune = nextInsertCount % 50 === 0;
    this.db.exec("SAVEPOINT cost_ledger_insert");
    try {
      this.insertStmt.run({
        ...record,
        day,
        agentId: record.agentId ?? null,
        taskId: record.taskId ?? null,
      });
      if (shouldPrune) {
        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        this.pruneStmt.run({ cutoff });
      }
      this.db.exec("RELEASE SAVEPOINT cost_ledger_insert");
      this.insertCount = nextInsertCount;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT cost_ledger_insert");
      this.db.exec("RELEASE SAVEPOINT cost_ledger_insert");
      throw error;
    }
  }

  public summary(scope: CostSummary["scope"], fromIso: string, toIso: string): CostSummary[] {
    if (scope === "day") {
      const rows = toSummaryRows(this.summaryByDayStmt.all({
        fromDay: fromIso.slice(0, 10),
        toDay: toIso.slice(0, 10),
      }));
      return rows.map((row) => mapSummaryRow(scope, row));
    }
    if (scope === "session") {
      const rows = toSummaryRows(this.summaryBySessionStmt.all({ from: fromIso, to: toIso }));
      return rows.map((row) => mapSummaryRow(scope, row));
    }
    if (scope === "agent") {
      const rows = toSummaryRows(this.summaryByAgentStmt.all({ from: fromIso, to: toIso }));
      return rows.map((row) => mapSummaryRow(scope, row));
    }

    const rows = toSummaryRows(this.summaryByTaskStmt.all({ from: fromIso, to: toIso }));
    return rows.map((row) => mapSummaryRow(scope, row));
  }

  public usageAvailability(fromIso: string, toIso: string): CostUsageAvailability {
    const row = this.summaryUsageAvailabilityStmt.get({ from: fromIso, to: toIso }) as {
      total_agent_events: number | null;
      tracked_events: number | null;
      unknown_events: number | null;
    } | undefined;
    return {
      trackedEvents: Number(row?.tracked_events ?? 0),
      unknownEvents: Number(row?.unknown_events ?? 0),
      totalAgentEvents: Number(row?.total_agent_events ?? 0),
    };
  }
}

interface SummaryRow {
  key: string;
  token_input: number;
  token_output: number;
  token_cached_input: number;
  cost_usd: number;
}

function mapSummaryRow(scope: CostSummary["scope"], row: SummaryRow): CostSummary {
  const tokenInput = Number(row.token_input ?? 0);
  const tokenOutput = Number(row.token_output ?? 0);
  const tokenCachedInput = Number(row.token_cached_input ?? 0);
  return {
    scope,
    key: row.key,
    tokenInput,
    tokenOutput,
    tokenCachedInput,
    tokenTotal: tokenInput + tokenOutput,
    costUsd: Number(row.cost_usd ?? 0),
  };
}

function toSummaryRows(value: unknown): SummaryRow[] {
  return Array.isArray(value) ? value.filter(isSummaryRow) : [];
}

function isSummaryRow(value: unknown): value is SummaryRow {
  return isRecord(value)
    && typeof value.key === "string"
    && typeof value.token_input === "number"
    && typeof value.token_output === "number"
    && typeof value.token_cached_input === "number"
    && typeof value.cost_usd === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}



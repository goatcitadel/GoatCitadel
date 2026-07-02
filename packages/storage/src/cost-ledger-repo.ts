import type { DatabaseClient } from "./db.js";

export type CostLedgerCredentialType = "api_key" | "oauth" | "unknown";
export type CostLedgerUsagePool = "standard" | "subscription" | "unknown";

export interface CostLedgerRecord {
  sessionId: string;
  agentId?: string;
  taskId?: string;
  providerId?: string;
  modelId?: string;
  /** Credential class the call was billed against (Anthropic Jun-2026 pool split). */
  credentialType?: CostLedgerCredentialType;
  /** Which billing pool the usage drew from (subscription credit pool vs standard). */
  usagePool?: CostLedgerUsagePool;
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

export interface CostDailySeriesSegment {
  providerKey: string;
  label: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCachedInput: number;
  tokenTotal: number;
  costUsd: number;
  models: string[];
}

export interface CostDailySeriesDay {
  isoDate: string;
  shortLabel: string;
  tokenInput: number;
  tokenOutput: number;
  tokenCachedInput: number;
  tokenTotal: number;
  costUsd: number;
  segments: CostDailySeriesSegment[];
}

export class CostLedgerRepository {
  private readonly insertStmt;
  private readonly summaryByDayStmt;
  private readonly summaryBySessionStmt;
  private readonly summaryByAgentStmt;
  private readonly summaryByTaskStmt;
  private readonly summaryUsageAvailabilityStmt;
  private readonly dailySeriesStmt;
  private readonly pruneStmt;
  private insertCount = 0;

  public constructor(private readonly db: DatabaseClient) {
    const providerAttributionSupported = hasCostLedgerColumn(db, "provider_id") && hasCostLedgerColumn(db, "model_id");
    const credentialDimsSupported = hasCostLedgerColumn(db, "credential_type") && hasCostLedgerColumn(db, "usage_pool");
    // Build the INSERT column list to match whichever optional columns the schema
    // actually has (older DBs may predate provider attribution and/or credential dims).
    const insertColumns = ["session_id", "agent_id", "task_id"];
    const insertValues = ["@sessionId", "@agentId", "@taskId"];
    if (providerAttributionSupported) {
      insertColumns.push("provider_id", "model_id");
      insertValues.push("@providerId", "@modelId");
    }
    insertColumns.push("day", "token_input", "token_output", "token_cached_input", "cost_usd", "created_at");
    insertValues.push("@day", "@tokenInput", "@tokenOutput", "@tokenCachedInput", "@costUsd", "@createdAt");
    if (credentialDimsSupported) {
      insertColumns.push("credential_type", "usage_pool");
      insertValues.push("@credentialType", "@usagePool");
    }
    this.insertStmt = db.prepare(
      `INSERT INTO cost_ledger (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
    );

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

    // A single MIN() dropped every model but the lexicographically smallest, so a provider/day
    // that used multiple models surfaced only one in the cost breakdown. Aggregate the DISTINCT
    // model ids comma-joined (matching splitModelIds), branching on dialect because GROUP_CONCAT
    // is SQLite-only and string_agg is Postgres-only.
    const modelIdsAgg =
      db.dialect === "postgres"
        ? "string_agg(DISTINCT NULLIF(model_id, ''), ',')"
        : "GROUP_CONCAT(DISTINCT NULLIF(model_id, ''))";
    this.dailySeriesStmt = db.prepare(
      providerAttributionSupported
        ? `
          SELECT
            day AS iso_date,
            COALESCE(NULLIF(provider_id, ''), 'unattributed') AS provider_key,
            ${modelIdsAgg} AS model_ids,
            SUM(token_input) AS token_input,
            SUM(token_output) AS token_output,
            SUM(token_cached_input) AS token_cached_input,
            SUM(cost_usd) AS cost_usd
          FROM cost_ledger
          WHERE day >= @fromDay AND day <= @toDay
          GROUP BY day, provider_key
          ORDER BY day ASC, SUM(cost_usd) DESC, provider_key ASC
        `
        : `
          SELECT
            day AS iso_date,
            'unattributed' AS provider_key,
            NULL AS model_ids,
            SUM(token_input) AS token_input,
            SUM(token_output) AS token_output,
            SUM(token_cached_input) AS token_cached_input,
            SUM(cost_usd) AS cost_usd
          FROM cost_ledger
          WHERE day >= @fromDay AND day <= @toDay
          GROUP BY day
          ORDER BY day ASC, SUM(cost_usd) DESC
        `,
    );

    this.pruneStmt = db.prepare(`
      DELETE FROM cost_ledger
      WHERE created_at < @cutoff
    `);
  }

  public insert(record: CostLedgerRecord): void {
    const day = record.createdAt.slice(0, 10);
    const nextInsertCount = this.insertCount + 1;
    const shouldPrune = nextInsertCount % 50 === 0;
    this.db.transaction("immediate", () => {
      this.insertStmt.run({
        ...record,
        day,
        agentId: record.agentId ?? null,
        taskId: record.taskId ?? null,
        providerId: normalizeOptionalText(record.providerId) ?? null,
        modelId: normalizeOptionalText(record.modelId) ?? null,
        credentialType: normalizeOptionalText(record.credentialType) ?? null,
        usagePool: normalizeOptionalText(record.usagePool) ?? null,
      });
      if (shouldPrune) {
        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        this.pruneStmt.run({ cutoff });
      }
    });
    this.insertCount = nextInsertCount;
  }

  public summary(scope: CostSummary["scope"], fromIso: string, toIso: string): CostSummary[] {
    if (scope === "day") {
      const rows = toSummaryRows(
        this.summaryByDayStmt.all({
          fromDay: fromIso.slice(0, 10),
          toDay: toIso.slice(0, 10),
        }),
      );
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
    const row = this.summaryUsageAvailabilityStmt.get({ from: fromIso, to: toIso }) as
      | {
          total_agent_events: number | null;
          tracked_events: number | null;
          unknown_events: number | null;
        }
      | undefined;
    return {
      trackedEvents: Number(row?.tracked_events ?? 0),
      unknownEvents: Number(row?.unknown_events ?? 0),
      totalAgentEvents: Number(row?.total_agent_events ?? 0),
    };
  }

  public dailySeries(fromIso: string, toIso: string): CostDailySeriesDay[] {
    const dayKeys = enumerateIsoDays(fromIso.slice(0, 10), toIso.slice(0, 10)).slice(-7);
    const rows = toDailySeriesRows(
      this.dailySeriesStmt.all({
        fromDay: dayKeys[0] ?? fromIso.slice(0, 10),
        toDay: dayKeys[dayKeys.length - 1] ?? toIso.slice(0, 10),
      }),
    );
    const days = new Map<string, CostDailySeriesDay>();
    for (const dayKey of dayKeys) {
      days.set(dayKey, {
        isoDate: dayKey,
        shortLabel: dayKey.slice(5),
        tokenInput: 0,
        tokenOutput: 0,
        tokenCachedInput: 0,
        tokenTotal: 0,
        costUsd: 0,
        segments: [],
      });
    }

    for (const row of rows) {
      const day = days.get(row.iso_date);
      if (!day) {
        continue;
      }
      const tokenInput = Number(row.token_input ?? 0);
      const tokenOutput = Number(row.token_output ?? 0);
      const tokenCachedInput = Number(row.token_cached_input ?? 0);
      const costUsd = Number(row.cost_usd ?? 0);
      const tokenTotal = tokenInput + tokenOutput;
      day.tokenInput += tokenInput;
      day.tokenOutput += tokenOutput;
      day.tokenCachedInput += tokenCachedInput;
      day.tokenTotal += tokenTotal;
      day.costUsd += costUsd;
      day.segments.push({
        providerKey: row.provider_key,
        label: formatProviderLabel(row.provider_key),
        tokenInput,
        tokenOutput,
        tokenCachedInput,
        tokenTotal,
        costUsd,
        models: splitModelIds(row.model_ids),
      });
    }

    return Array.from(days.values());
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

interface DailySeriesRow {
  iso_date: string;
  provider_key: string;
  model_ids: string | null;
  token_input: number;
  token_output: number;
  token_cached_input: number;
  cost_usd: number;
}

function toDailySeriesRows(value: unknown): DailySeriesRow[] {
  return Array.isArray(value) ? value.filter(isDailySeriesRow) : [];
}

function isSummaryRow(value: unknown): value is SummaryRow {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.token_input === "number" &&
    typeof value.token_output === "number" &&
    typeof value.token_cached_input === "number" &&
    typeof value.cost_usd === "number"
  );
}

function isDailySeriesRow(value: unknown): value is DailySeriesRow {
  return (
    isRecord(value) &&
    typeof value.iso_date === "string" &&
    typeof value.provider_key === "string" &&
    (typeof value.model_ids === "string" || value.model_ids === null) &&
    typeof value.token_input === "number" &&
    typeof value.token_output === "number" &&
    typeof value.token_cached_input === "number" &&
    typeof value.cost_usd === "number"
  );
}

function enumerateIsoDays(fromDay: string, toDay: string): string[] {
  const start = parseIsoDay(fromDay);
  const end = parseIsoDay(toDay);
  if (!start || !end || start.getTime() > end.getTime()) {
    return [];
  }
  const days: string[] = [];
  for (const cursor = start; cursor.getTime() <= end.getTime(); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function parseIsoDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatProviderLabel(providerKey: string): string {
  if (providerKey === "unattributed") {
    return "Unattributed";
  }
  return providerKey
    .split(/[-_:/.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function splitModelIds(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasCostLedgerColumn(
  db: DatabaseClient,
  columnName: "provider_id" | "model_id" | "credential_type" | "usage_pool",
): boolean {
  try {
    if (db.dialect === "sqlite") {
      const rows = db.prepare("PRAGMA table_info(cost_ledger)").all() as Array<{ name?: unknown }>;
      return rows.some((row) => row.name === columnName);
    }
    const row = db
      .prepare(
        `
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_name = 'cost_ledger' AND column_name = @columnName
          LIMIT 1
        `,
      )
      .get<{ name?: string }>({ columnName });
    return row?.name === columnName;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

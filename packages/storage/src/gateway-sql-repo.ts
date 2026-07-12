import type { DatabaseClient, DbStatement } from "./db.js";

export class GatewaySqlRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public get dialect(): DatabaseClient["dialect"] {
    return this.db.dialect;
  }

  public prepare(sql: string): DbStatement {
    return this.db.prepare(sql);
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public runImmediateTransaction<T>(callback: () => T): T {
    return this.db.transaction("immediate", callback);
  }

  /** Read a fresh wall-clock instant from the database that owns auth state. */
  public readDatabaseNow(): string {
    const row = this.db
      .prepare(
        this.db.dialect === "postgres"
          ? `
            SELECT to_char(
              clock_timestamp() AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS database_now
          `
          : `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS database_now`,
      )
      .get<{ database_now?: unknown }>();
    if (typeof row?.database_now !== "string" || !Number.isFinite(Date.parse(row.database_now))) {
      throw new Error("Database clock did not return a valid timestamp.");
    }
    return row.database_now;
  }

  /** Create an issuance/expiry pair from one database-clock sample. */
  public createDatabaseTtlWindow(durationMs: number): { createdAt: string; expiresAt: string } {
    assertPositiveDuration(durationMs);
    const row = this.db
      .prepare(
        this.db.dialect === "postgres"
          ? `
            WITH database_clock AS (
              SELECT clock_timestamp() AS now_instant
            )
            SELECT
              to_char(
                now_instant AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS created_at,
              to_char(
                (
                  now_instant + (CAST(@durationMs AS DOUBLE PRECISION) * interval '1 millisecond')
                ) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS expires_at
            FROM database_clock
          `
          : `
            SELECT
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS created_at,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', @durationModifier) AS expires_at
          `,
      )
      .get<{ created_at?: unknown; expires_at?: unknown }>(
        this.db.dialect === "postgres" ? { durationMs } : { durationModifier: `${durationMs / 1_000} seconds` },
      );
    if (
      typeof row?.created_at !== "string" ||
      typeof row.expires_at !== "string" ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      !Number.isFinite(Date.parse(row.expires_at))
    ) {
      throw new Error("Database clock did not return a valid TTL window.");
    }
    return { createdAt: row.created_at, expiresAt: row.expires_at };
  }

  /** True only when the supplied instant parses and is after database now. */
  public isDatabaseInstantFuture(instant: string): boolean {
    if (!isCanonicalZonedInstant(instant)) {
      return false;
    }
    const row = this.db
      .prepare(
        this.db.dialect === "postgres"
          ? `
            SELECT COALESCE(
              isfinite(gc_try_parse_timestamptz(@instant))
                AND gc_try_parse_timestamptz(@instant) > clock_timestamp(),
              FALSE
            ) AS is_future
          `
          : `SELECT COALESCE(julianday(@instant) > julianday('now'), 0) AS is_future`,
      )
      .get<{ is_future?: unknown }>({ instant });
    return row?.is_future === true || row?.is_future === 1;
  }

  /** Malformed instants are expired: auth expiry checks fail closed. */
  public isDatabaseInstantExpired(instant: string): boolean {
    if (!isCanonicalZonedInstant(instant)) {
      return true;
    }
    const row = this.db
      .prepare(
        this.db.dialect === "postgres"
          ? `
            SELECT NOT COALESCE(
              isfinite(gc_try_parse_timestamptz(@instant))
                AND gc_try_parse_timestamptz(@instant) > clock_timestamp(),
              FALSE
            ) AS is_expired
          `
          : `SELECT COALESCE(julianday(@instant) <= julianday('now'), 1) AS is_expired`,
      )
      .get<{ is_expired?: unknown }>({ instant });
    return row?.is_expired === true || row?.is_expired === 1;
  }

  /** Compare a client-supplied timestamp with database time without trusting the host clock. */
  public isDatabaseInstantWithinSkew(instant: string, skewMs: number): boolean {
    assertNonNegativeDuration(skewMs);
    if (!isCanonicalZonedInstant(instant)) {
      return false;
    }
    const row = this.db
      .prepare(
        this.db.dialect === "postgres"
          ? `
            SELECT COALESCE(
              isfinite(gc_try_parse_timestamptz(@instant))
                AND abs(EXTRACT(EPOCH FROM (gc_try_parse_timestamptz(@instant) - clock_timestamp()))) * 1000
                  <= @skewMs,
              FALSE
            ) AS is_within_skew
          `
          : `
            SELECT COALESCE(
              abs((julianday(@instant) - julianday('now')) * 86400000) <= @skewMs,
              0
            ) AS is_within_skew
          `,
      )
      .get<{ is_within_skew?: unknown }>({ instant, skewMs });
    return row?.is_within_skew === true || row?.is_within_skew === 1;
  }
}

function assertPositiveDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new TypeError("Database TTL requires a positive duration in milliseconds.");
  }
}

function assertNonNegativeDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new TypeError("Database clock skew requires a non-negative duration in milliseconds.");
  }
}

const CANONICAL_ZONED_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

function isCanonicalZonedInstant(value: string): boolean {
  return CANONICAL_ZONED_INSTANT.test(value);
}

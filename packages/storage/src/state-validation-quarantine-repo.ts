import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type { QuarantineEntry } from "./load-and-sanitize.js";

interface QuarantineRow {
  quarantine_id: string;
  store: string;
  row_id: string;
  raw_value: string | null;
  schema_error: string;
  observed_at: string;
}

export interface StoredQuarantineEntry extends QuarantineEntry {
  quarantineId: string;
}

export class StateValidationQuarantineRepository {
  private readonly insertStmt;
  private readonly listStmt;
  private readonly countStmt;
  private readonly countsByStoreStmt;
  private readonly clearAllStmt;
  private readonly clearStoreStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO state_validation_quarantine (
        quarantine_id, store, row_id, raw_value, schema_error, observed_at
      ) VALUES (@quarantineId, @store, @rowId, @rawValue, @schemaError, @observedAt)
    `);
    this.listStmt = db.prepare(`
      SELECT quarantine_id, store, row_id, raw_value, schema_error, observed_at
      FROM state_validation_quarantine
      ORDER BY observed_at DESC, quarantine_id DESC
      LIMIT ?
    `);
    this.countStmt = db.prepare("SELECT COUNT(1) AS count FROM state_validation_quarantine");
    this.countsByStoreStmt = db.prepare(`
      SELECT store, COUNT(1) AS count
      FROM state_validation_quarantine
      GROUP BY store
    `);
    this.clearAllStmt = db.prepare("DELETE FROM state_validation_quarantine");
    this.clearStoreStmt = db.prepare("DELETE FROM state_validation_quarantine WHERE store = ?");
  }

  public record(entry: QuarantineEntry): StoredQuarantineEntry {
    const quarantineId = randomUUID();
    this.insertStmt.run({
      quarantineId,
      store: entry.store,
      rowId: entry.rowId,
      rawValue: entry.rawValue ?? null,
      schemaError: entry.schemaError,
      observedAt: entry.observedAt,
    });
    return { ...entry, quarantineId };
  }

  public list(limit: number): StoredQuarantineEntry[] {
    const rows = this.listStmt.all(Math.max(1, Math.floor(limit))) as QuarantineRow[];
    return rows.map(mapRow);
  }

  public count(): number {
    const row = this.countStmt.get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  public countsByStore(): Array<{ store: string; count: number }> {
    const rows = this.countsByStoreStmt.all() as Array<{ store: string; count: number | bigint }>;
    return rows.map((row) => ({ store: row.store, count: Number(row.count) }));
  }

  public clear(store?: string): number {
    if (store === undefined) {
      const result = this.clearAllStmt.run();
      return Number(result.changes ?? 0);
    }
    const result = this.clearStoreStmt.run(store);
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: QuarantineRow): StoredQuarantineEntry {
  return {
    quarantineId: row.quarantine_id,
    store: row.store,
    rowId: row.row_id,
    rawValue: row.raw_value,
    schemaError: row.schema_error,
    observedAt: row.observed_at,
  };
}

import type { DatabaseClient } from "./db.js";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface SystemSettingRow {
  setting_key: string;
  value_json: string;
  updated_at: string;
}

export interface SystemSettingRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: string;
}

export class SystemSettingsRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly insertIfAbsentStmt;
  private readonly getForUpdateStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM system_settings WHERE setting_key = ?");
    this.insertIfAbsentStmt = db.prepare(`
      INSERT INTO system_settings (setting_key, value_json, updated_at)
      VALUES (@key, @valueJson, @updatedAt)
      ON CONFLICT(setting_key) DO NOTHING
    `);
    this.getForUpdateStmt = db.prepare(
      `SELECT * FROM system_settings WHERE setting_key = ?${db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    );
    this.upsertStmt = db.prepare(`
      INSERT INTO system_settings (setting_key, value_json, updated_at)
      VALUES (@key, @valueJson, @updatedAt)
      ON CONFLICT(setting_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
  }

  public get<T = unknown>(key: string): SystemSettingRecord<T> | undefined {
    const row = this.getStmt.get(key) as SystemSettingRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      key: row.setting_key,
      value: parseValue(row.value_json) as T,
      updatedAt: row.updated_at,
    };
  }

  public set<T>(key: string, value: T, now = new Date().toISOString()): SystemSettingRecord<T> {
    this.upsertStmt.run({
      key,
      valueJson: JSON.stringify(value),
      updatedAt: now,
    });
    const saved = this.get<T>(key);
    if (!saved) {
      throw new NotFoundError(`Failed to persist setting ${key}`);
    }
    return saved;
  }

  /**
   * Atomically advances a shared cyclic counter. PostgreSQL locks the setting
   * row (including safe first-insert contention); SQLite callers are serialized
   * by the surrounding IMMEDIATE transaction. Callers can include this write in
   * a larger transaction so their domain receipt commits with the increment.
   */
  public advanceCyclicCounter(
    key: string,
    resetAt: number,
    now = new Date().toISOString(),
  ): { previous: number; value: number; due: boolean } {
    const threshold = Math.max(1, Math.floor(resetAt));
    return this.db.transaction("immediate", () => {
      this.insertIfAbsentStmt.run({ key, valueJson: "0", updatedAt: now });
      const row = this.getForUpdateStmt.get(key) as SystemSettingRow | undefined;
      if (!row) {
        throw new NotFoundError(`Failed to lock setting ${key}`);
      }
      const parsed = parseValue(row.value_json);
      const previous = typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
      const next = previous + 1;
      const due = next >= threshold;
      const value = due ? 0 : next;
      this.upsertStmt.run({ key, valueJson: JSON.stringify(value), updatedAt: now });
      return { previous, value, due };
    });
  }
}

function parseValue(raw: string): unknown {
  return safeJsonParse<unknown>(raw, raw);
}

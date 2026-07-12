import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): { db: DatabaseClient; repo: SystemSettingsRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-system-settings-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new SystemSettingsRepository(db) };
}

describe("SystemSettingsRepository", () => {
  it("sets, updates, reads missing rows, and falls back for malformed JSON", () => {
    const { db, repo } = createRepo();

    assert.equal(repo.get("ui.theme"), undefined);

    const saved = repo.set("ui.theme", { mode: "dark" }, "2026-05-12T00:00:00.000Z");
    assert.deepEqual(saved, {
      key: "ui.theme",
      value: { mode: "dark" },
      updatedAt: "2026-05-12T00:00:00.000Z",
    });

    const updated = repo.set("ui.theme", "noir", "2026-05-12T00:01:00.000Z");
    assert.equal(updated.value, "noir");
    assert.equal(updated.updatedAt, "2026-05-12T00:01:00.000Z");

    db.prepare("UPDATE system_settings SET value_json = ? WHERE setting_key = ?").run("{malformed-json", "ui.theme");

    assert.deepEqual(repo.get("ui.theme"), {
      key: "ui.theme",
      value: "{malformed-json",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
  });

  it("throws when an upsert cannot be read back", () => {
    const repo = new SystemSettingsRepository(new MissingReadbackDatabase());

    assert.throws(() => repo.set("provider.default", "openai", "2026-05-12T00:00:00.000Z"), /Failed to persist/);
  });

  it("atomically advances and resets a cyclic counter", () => {
    const { repo } = createRepo();

    assert.deepEqual(repo.advanceCyclicCounter("background", 3), { previous: 0, value: 1, due: false });
    assert.deepEqual(repo.advanceCyclicCounter("background", 3), { previous: 1, value: 2, due: false });
    assert.deepEqual(repo.advanceCyclicCounter("background", 3), { previous: 2, value: 0, due: true });
    assert.equal(repo.get<number>("background")?.value, 0);
  });
});

class MissingReadbackDatabase implements DatabaseClient {
  public readonly dialect = "sqlite" as const;

  public prepare(sql: string): DbStatement {
    if (sql.includes("SELECT * FROM system_settings")) {
      return new FakeStatement({ get: () => undefined });
    }
    return new FakeStatement({ run: () => ({ changes: 1 }) });
  }

  public exec(): void {}

  public close(): void {}

  public transaction<T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return callback();
  }
}

class FakeStatement implements DbStatement {
  public constructor(
    private readonly handlers: {
      run?: (...params: unknown[]) => { changes: number };
      get?: (...params: unknown[]) => unknown;
      all?: (...params: unknown[]) => unknown[];
    },
  ) {}

  public run(...params: unknown[]): { changes: number } {
    return this.handlers.run?.(...params) ?? { changes: 0 };
  }

  public get<T = unknown>(...params: unknown[]): T | undefined {
    return this.handlers.get?.(...params) as T | undefined;
  }

  public all<T = unknown>(...params: unknown[]): T[] {
    return (this.handlers.all?.(...params) ?? []) as T[];
  }
}

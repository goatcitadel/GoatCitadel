import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals } from "./sqlite.js";

describe("SQLite operator resource revision migration", () => {
  it("backfills legacy workspace and chat-project rows at revision one idempotently", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE chat_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO workspaces (workspace_id, name) VALUES ('legacy-workspace', 'Legacy Workspace');
      INSERT INTO chat_projects (project_id, name) VALUES ('legacy-project', 'Legacy Project');
    `);

    __sqliteInternals.applySchemaMigrationForTest(145, db);
    __sqliteInternals.applySchemaMigrationForTest(145, db);

    for (const tableName of ["workspaces", "chat_projects"] as const) {
      const revisionColumn = db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all()
        .find((column) => (column as { name?: unknown }).name === "revision") as
        | { name: string; notnull: number; dflt_value: string | null }
        | undefined;
      assert.deepEqual(
        revisionColumn
          ? {
              name: revisionColumn.name,
              notnull: revisionColumn.notnull,
              dflt_value: revisionColumn.dflt_value,
            }
          : undefined,
        { name: "revision", notnull: 1, dflt_value: "1" },
      );
    }
    assert.equal(
      (
        db.prepare("SELECT revision FROM workspaces WHERE workspace_id = 'legacy-workspace'").get() as {
          revision: number;
        }
      ).revision,
      1,
    );
    assert.equal(
      (
        db.prepare("SELECT revision FROM chat_projects WHERE project_id = 'legacy-project'").get() as {
          revision: number;
        }
      ).revision,
      1,
    );
    db.close();
  });
});

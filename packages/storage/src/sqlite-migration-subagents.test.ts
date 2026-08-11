import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

describe("sqlite subagent migration", () => {
  it("renames legacy openclaw_session_id column to agent_session_id", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-legacy-subagents-${randomUUID()}.db`);
    createdFiles.push(dbPath);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assigned_agent_id TEXT,
        created_by TEXT,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Faithful copy of the legacy base schema that shipped this table. The
      -- task_id foreign key must be seeded too: post-migration canonical
      -- schema-shape validation refuses any shape the supported lineage never
      -- produced, and RENAME COLUMN preserves the constraint on upgrade.
      CREATE TABLE task_subagent_sessions (
        subagent_session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        openclaw_session_id TEXT NOT NULL UNIQUE,
        agent_name TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
      );
    `);

    legacy.exec(`
      INSERT INTO tasks (
        task_id, title, status, priority, created_at, updated_at
      ) VALUES (
        'task-1', 'Legacy task', 'in_progress', 'normal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

      INSERT INTO task_subagent_sessions (
        subagent_session_id, task_id, openclaw_session_id, agent_name, status, created_at, updated_at
      ) VALUES (
        'sub-1', 'task-1', 'agent:legacy:test', 'legacy-agent', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const db = createDatabase({ dbPath });
    const rows = db.prepare("PRAGMA table_info(task_subagent_sessions)").all() as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));

    assert.equal(columns.has("agent_session_id"), true);
    assert.equal(columns.has("openclaw_session_id"), false);

    const record = db
      .prepare("SELECT agent_session_id AS agentSessionId FROM task_subagent_sessions WHERE subagent_session_id = ?")
      .get("sub-1") as { agentSessionId: string } | undefined;
    assert.equal(record?.agentSessionId, "agent:legacy:test");

    db.close();
  });
});

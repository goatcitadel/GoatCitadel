import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { __sqliteInternals } from "./sqlite.js";

describe("SQLite skill aggregate revision migration", () => {
  it("backfills known aggregates at revision one and remains idempotent", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE skill_lifecycle (
        skill_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE skill_state (
        skill_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE candidate_skill_versions (
        version_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE system_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO skill_lifecycle (skill_id, created_at, updated_at) VALUES
        ('skill.shared', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
        ('skill.lifecycle-only', '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z');
      INSERT INTO skill_state (skill_id, updated_at) VALUES
        ('skill.shared', '2026-07-04T00:00:00.000Z'),
        ('skill.state-only', '2026-07-05T00:00:00.000Z'),
        ('  skill.padded  ', '2026-07-05T01:00:00.000Z'),
        ('skill.invalid-timestamp', '');
      INSERT INTO candidate_skill_versions (version_id, candidate_id, created_at, updated_at) VALUES
        ('version-a1', 'candidate.a', '2026-07-06T00:00:00.000Z', '2026-07-06T01:00:00.000Z'),
        ('version-a2', 'candidate.a', '2026-07-07T00:00:00.000Z', '2026-07-08T00:00:00.000Z'),
        ('version-b1', 'candidate.b', '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');
      INSERT INTO system_settings (setting_key, value_json, updated_at)
        VALUES ('skill_activation_policy_v1', '{}', '2026-07-10T00:00:00.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(164, db);

    const rows = db
      .prepare(
        `
        SELECT aggregate_kind, aggregate_id, revision, created_at, updated_at
        FROM skill_aggregate_revisions
        ORDER BY aggregate_kind, aggregate_id
      `,
      )
      .all() as Array<{
      aggregate_kind: string;
      aggregate_id: string;
      revision: number;
      created_at: string;
      updated_at: string;
    }>;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          aggregate_kind: "activation_policy",
          aggregate_id: "global",
          revision: 1,
          created_at: "2026-07-10T00:00:00.000Z",
          updated_at: "2026-07-10T00:00:00.000Z",
        },
        {
          aggregate_kind: "candidate_skill",
          aggregate_id: "candidate.a",
          revision: 1,
          created_at: "2026-07-06T00:00:00.000Z",
          updated_at: "2026-07-08T00:00:00.000Z",
        },
        {
          aggregate_kind: "candidate_skill",
          aggregate_id: "candidate.b",
          revision: 1,
          created_at: "2026-07-09T00:00:00.000Z",
          updated_at: "2026-07-09T00:00:00.000Z",
        },
        {
          aggregate_kind: "runtime_skill",
          aggregate_id: "skill.lifecycle-only",
          revision: 1,
          created_at: "2026-07-03T00:00:00.000Z",
          updated_at: "2026-07-03T00:00:00.000Z",
        },
        {
          aggregate_kind: "runtime_skill",
          aggregate_id: "skill.padded",
          revision: 1,
          created_at: "2026-07-05T01:00:00.000Z",
          updated_at: "2026-07-05T01:00:00.000Z",
        },
        {
          aggregate_kind: "runtime_skill",
          aggregate_id: "skill.shared",
          revision: 1,
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-04T00:00:00.000Z",
        },
        {
          aggregate_kind: "runtime_skill",
          aggregate_id: "skill.state-only",
          revision: 1,
          created_at: "2026-07-05T00:00:00.000Z",
          updated_at: "2026-07-05T00:00:00.000Z",
        },
      ],
    );

    db.prepare(
      "UPDATE skill_aggregate_revisions SET revision = 7 WHERE aggregate_kind = 'runtime_skill' AND aggregate_id = 'skill.shared'",
    ).run();
    __sqliteInternals.applySchemaMigrationForTest(164, db);
    assert.equal(
      (
        db
          .prepare(
            "SELECT revision FROM skill_aggregate_revisions WHERE aggregate_kind = 'runtime_skill' AND aggregate_id = 'skill.shared'",
          )
          .get() as { revision: number } | undefined
      )?.revision,
      7,
      "migration replay must not reset an established aggregate revision",
    );

    const insert = db.prepare(`
      INSERT INTO skill_aggregate_revisions (
        aggregate_kind, aggregate_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z')
    `);
    assert.throws(() => insert.run("unknown", "id", 1));
    assert.throws(() => insert.run("runtime_skill", " ", 1));
    assert.throws(() => insert.run("runtime_skill", " skill.padded ", 1));
    assert.throws(() => insert.run("runtime_skill", "skill.invalid-revision", 0));
    assert.throws(() => insert.run("runtime_skill", "skill.fractional-revision", 1.5));
    db.close();
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./client.js";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import { applyPostgresMigrationsSync, runPostgresMigrations } from "./migrator.js";
import { PostgresSyncDatabaseClient } from "./sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

for (const historical of [false, true]) {
  test(
    `Postgres confirms the learning schema on ${historical ? "upgrade from v239" : "fresh bootstrap"}`,
    { skip: !connectionString && "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance." },
    async () => {
      assert.ok(connectionString);
      const database = `gc_learning_shape_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString, max: 1 });
      const url = new URL(connectionString);
      url.pathname = `/${database}`;
      const options = { database, connectionString: url.toString(), pool: { max: 1 } };
      let created = false;
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
        created = true;
        const db = new PostgresSyncDatabaseClient(options);
        try {
          if (historical) {
            applyPostgresMigrationsSync(db, {
              migrations: POSTGRES_MIGRATIONS.filter(({ version }) => version <= 239),
            });
            // The current bootstrap uses the wider types. Recreate the catalog
            // left by the original additive migrations and keep an existing row.
            db.exec(`
              ALTER TABLE improvement_activations
                ALTER COLUMN positive_signal_count TYPE INTEGER,
                ALTER COLUMN watch_evidence_version TYPE INTEGER,
                ALTER COLUMN watch_evidence_complete TYPE INTEGER;
              ALTER TABLE memory_learnings ALTER COLUMN confidence TYPE REAL;
              ALTER TABLE memory_recall_state ALTER COLUMN singleton TYPE INTEGER;
              UPDATE memory_recall_state SET generation = 42 WHERE singleton = 1;

              DROP INDEX idx_chat_turn_trace_completion_cursor,
                idx_durable_runs_learning_foreground_recent,
                idx_durable_runs_learning_foreground_status;
              CREATE INDEX idx_chat_turn_trace_completion_cursor
                ON chat_turn_traces(status, COALESCE(finished_at, started_at), turn_id);
              CREATE INDEX idx_durable_runs_learning_foreground_recent
                ON durable_runs(workflow_key, updated_at DESC);
              CREATE INDEX idx_durable_runs_learning_foreground_status
                ON durable_runs(workflow_key, status, updated_at DESC);
            `);
            applyPostgresMigrationsSync(db);
            const generation = db
              .prepare("SELECT generation FROM memory_recall_state WHERE singleton = 1")
              .get<{ generation: number | bigint }>()?.generation;
            assert.equal(Number(generation), 42);
          } else {
            const client = new PostgresDatabaseClient(options);
            try {
              assert.equal((await runPostgresMigrations(client)).latestVersion, 241);
            } finally {
              await client.close();
            }
          }

          const learningLedger = db.prepare(
            "SELECT version, name FROM schema_migrations WHERE version >= 240 ORDER BY version",
          );
          const applied = learningLedger.all<{ version: number | bigint; name: string }>();
          assert.deepEqual(
            applied.map(({ version, name }) => [Number(version), name]),
            [
              [240, "canonical_memory_note_origins"],
              [241, "learning_schema_convergence"],
            ],
          );
          applyPostgresMigrationsSync(db);
          assert.deepEqual(learningLedger.all(), applied);
          const indexes = db
            .prepare(
              `
            SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
              'idx_chat_turn_trace_completion_cursor',
              'idx_durable_runs_learning_foreground_recent',
              'idx_durable_runs_learning_foreground_status'
            ) ORDER BY indexname
          `,
            )
            .all<{ indexdef: string }>();
          assert.equal(indexes.length, 3);
          assert.match(indexes[0]!.indexdef, /COALESCE\(finished_at, started_at\)/u);
          assert.match(indexes[1]!.indexdef, /\(workflow_key, updated_at DESC\)/u);
          assert.match(indexes[2]!.indexdef, /\(workflow_key, status, updated_at DESC\)/u);
        } finally {
          db.close();
        }
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
    },
  );
}

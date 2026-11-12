import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { ChatSessionLifecycleRepository } from "../chat-session-lifecycle-repo.js";
import { PostgresDatabaseClient } from "./client.js";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import { applyPostgresMigrationsSync, runPostgresMigrations } from "./migrator.js";
import { PostgresSyncDatabaseClient } from "./sync.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

for (const [mode, previousVersion] of [
  ["async", 0],
  ["sync", 230],
  ["sync", 231],
] as const) {
  test(
    `approval and file schema converges with ${mode} migrations from v${previousVersion}`,
    {
      skip: !connectionString && "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.",
    },
    async () => {
      assert.ok(connectionString);
      const database = `gc_file_shape_${randomUUID().replaceAll("-", "")}`;
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
          if (previousVersion) {
            applyPostgresMigrationsSync(db, {
              migrations: POSTGRES_MIGRATIONS.filter(({ version }) => version <= 229),
            });
            // The current v2 bootstrap already creates these four empty tables.
            // Remove that bootstrap-only state to model a database created before
            // the two features shipped, then run their original additive DDL.
            db.exec(`
            DROP TABLE chat_turn_approval_admissions, chat_session_approval_modes,
              managed_project_file_heads, managed_project_file_revisions;
          `);
            applyPostgresMigrationsSync(db, {
              migrations: POSTGRES_MIGRATIONS.filter(({ version }) => version <= previousVersion),
            });
            assert.equal(
              db
                .prepare(
                  `
            SELECT data_type FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'chat_session_approval_modes' AND column_name = 'last_change_aggregate_revision'
          `,
                )
                .get<{ data_type: string }>()?.data_type,
              "integer",
            );
            new ChatSessionLifecycleRepository(db).initialize({
              workspaceId: "default",
              sessionId: "schema-proof",
              actorId: "fixture",
              idempotencyKey: "schema-proof-init",
              correlationId: "schema-proof-init",
            });
            db.exec(`
            INSERT INTO chat_session_approval_modes
              (session_id, mode, mode_revision, last_change_aggregate_revision, workspace_id)
              VALUES ('schema-proof', 'standard', 'proof-revision', 42, 'default');
          `);
          }
          const legacyIndex =
            previousVersion === 231
              ? db
                  .prepare(
                    `
          SELECT 'managed_project_file_revisions_effect_id_key'::regclass::oid::text AS oid
        `,
                  )
                  .get<{ oid: string }>()?.oid
              : undefined;
          if (mode === "async") {
            const client = new PostgresDatabaseClient(options);
            try {
              await runPostgresMigrations(client);
            } finally {
              await client.close();
            }
          } else {
            applyPostgresMigrationsSync(db);
          }
          const columns = db
            .prepare(
              `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND (table_name, column_name) IN (
            ('chat_session_approval_modes', 'last_change_aggregate_revision'),
            ('chat_session_approval_modes', 'project_revision'),
            ('managed_project_file_revisions', 'byte_length')
          ) ORDER BY column_name
        `,
            )
            .all();
          assert.deepEqual(columns, [
            { column_name: "byte_length", data_type: "bigint", is_nullable: "NO" },
            { column_name: "last_change_aggregate_revision", data_type: "bigint", is_nullable: "NO" },
            { column_name: "project_revision", data_type: "bigint", is_nullable: "YES" },
          ]);
          const indexes = db
            .prepare(
              `
          SELECT indexrelid::text AS oid, indexrelid::regclass::text AS name
          FROM pg_index
          WHERE indrelid = 'managed_project_file_revisions'::regclass AND indisunique AND indisvalid
            AND indpred IS NULL AND pg_get_indexdef(indexrelid, 1, true) = 'effect_id'
        `,
            )
            .all<{ oid: string; name: string }>();
          assert.deepEqual(
            indexes.map(({ name }) => name),
            ["idx_managed_project_file_revisions_effect_id_unique"],
          );
          if (legacyIndex) assert.equal(indexes[0]?.oid, legacyIndex);
          if (previousVersion) {
            assert.deepEqual(
              db
                .prepare(
                  `
            SELECT mode_revision, last_change_aggregate_revision::int, project_revision
            FROM chat_session_approval_modes WHERE session_id = 'schema-proof'
          `,
                )
                .get(),
              { mode_revision: "proof-revision", last_change_aggregate_revision: 42, project_revision: null },
            );
          }
          applyPostgresMigrationsSync(db);
        } finally {
          db.close();
        }
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE "${database}"`);
        } finally {
          await admin.end();
        }
      }
    },
  );
}

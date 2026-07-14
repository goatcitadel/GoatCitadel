import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { runPostgresMigrations } from "./postgres/migrator.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real Postgres HX-410 saved-board cap, CAS, archive, and delete fences",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `hx410_ops_boards_${suffix}`;
    const adminPool = new Pool({ connectionString });
    const scopedUrl = new URL(connectionString);
    scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
    const scopedPool = new Pool({ connectionString: scopedUrl.toString(), max: 6 });
    const migrationClient = new PostgresDatabaseClient(
      { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
      { pool: scopedPool },
    );

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
      const workspace = await scopedPool.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspaces ORDER BY workspace_id LIMIT 1",
      );
      assert.ok(workspace.rows[0]);
      const workspaceId = workspace.rows[0].workspace_id;

      await assert.rejects(
        scopedPool.query(
          insertSql().replace("'active', 1", "'active', 2"),
          insertValues(workspaceId, "forged-history", "forged-history", "Forged history"),
        ),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );

      for (let index = 0; index < 63; index += 1) {
        await insertBoard(scopedPool, workspaceId, `board-${index}`, `key-${index}`, `Board ${index}`);
      }
      const finalAttempts = await Promise.allSettled([
        insertBoard(scopedPool, workspaceId, "board-63a", "key-63a", "Board 63 A"),
        insertBoard(scopedPool, workspaceId, "board-63b", "key-63b", "Board 63 B"),
      ]);
      assert.equal(finalAttempts.filter((result) => result.status === "fulfilled").length, 1);
      const capFailure = finalAttempts.find((result) => result.status === "rejected");
      assert.ok(capFailure && capFailure.status === "rejected");
      assert.equal((capFailure.reason as { code?: string }).code, "23514");
      const count = await scopedPool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM ops_saved_boards WHERE workspace_id = $1",
        [workspaceId],
      );
      assert.equal(Number(count.rows[0]?.count), 64);

      const replay = await scopedPool.query(
        `${insertSql()} ON CONFLICT(workspace_id, idempotency_key) DO NOTHING`,
        insertValues(workspaceId, "ignored-replay", "key-0", "Board 0"),
      );
      assert.equal(replay.rowCount, 0);

      const updateSql = `
        UPDATE ops_saved_boards
        SET name = $1, revision = revision + 1, updated_by_actor_id = $2, updated_at = $3
        WHERE workspace_id = $4 AND board_id = 'board-0' AND status = 'active' AND revision = 1
      `;
      const updates = await Promise.all([
        scopedPool.query(updateSql, ["Winner A", "operator-a", "2026-07-14T12:01:00.000Z", workspaceId]),
        scopedPool.query(updateSql, ["Winner B", "operator-b", "2026-07-14T12:02:00.000Z", workspaceId]),
      ]);
      assert.deepEqual(updates.map((result) => result.rowCount).sort(), [0, 1]);
      const winner = await scopedPool.query<{ name: string; revision: string }>(
        "SELECT name, revision FROM ops_saved_boards WHERE workspace_id = $1 AND board_id = 'board-0'",
        [workspaceId],
      );
      assert.equal(Number(winner.rows[0]?.revision), 2);
      assert.ok(winner.rows[0]?.name === "Winner A" || winner.rows[0]?.name === "Winner B");
      await assert.rejects(
        scopedPool.query(
          `
            UPDATE ops_saved_boards
            SET name = 'Regressed', revision = revision + 1,
                updated_by_actor_id = 'operator-regressed', updated_at = '2026-07-14T11:59:00.000Z'
            WHERE workspace_id = $1 AND board_id = 'board-0' AND revision = 2
          `,
          [workspaceId],
        ),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
      const afterRegression = await scopedPool.query<{ revision: string }>(
        "SELECT revision FROM ops_saved_boards WHERE workspace_id = $1 AND board_id = 'board-0'",
        [workspaceId],
      );
      assert.equal(Number(afterRegression.rows[0]?.revision), 2);

      await scopedPool.query(
        `
          UPDATE ops_saved_boards
          SET status = 'archived', revision = revision + 1,
              updated_by_actor_id = 'operator-a', updated_at = '2026-07-14T12:03:00.000Z',
              archived_by_actor_id = 'operator-a', archived_at = '2026-07-14T12:03:00.000Z'
          WHERE workspace_id = $1 AND board_id = 'board-1' AND revision = 1
        `,
        [workspaceId],
      );
      await assert.rejects(
        insertBoard(scopedPool, workspaceId, "board-65", "key-65", "Board 65"),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
      await assert.rejects(
        scopedPool.query("DELETE FROM ops_saved_boards WHERE workspace_id = $1 AND board_id = 'board-1'", [
          workspaceId,
        ]),
        (error: unknown) => (error as { code?: string }).code === "23514",
      );
    } finally {
      await scopedPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  },
);

function insertBoard(pool: Pool, workspaceId: string, boardId: string, idempotencyKey: string, name: string) {
  return pool.query(insertSql(), insertValues(workspaceId, boardId, idempotencyKey, name));
}

function insertSql(): string {
  return `
    INSERT INTO ops_saved_boards (
      workspace_id, board_id, schema_version, name, description, layout_json, status, revision,
      created_by_actor_id, created_at, updated_by_actor_id, updated_at,
      archived_by_actor_id, archived_at, idempotency_key, request_sha256
    ) VALUES (
      $1, $2, 'goatcitadel.ops-board.v1', $3, NULL, $4, 'active', 1,
      'operator-test', '2026-07-14T12:00:00.000Z', 'operator-test', '2026-07-14T12:00:00.000Z',
      NULL, NULL, $5, $6
    )
  `;
}

function insertValues(workspaceId: string, boardId: string, idempotencyKey: string, name: string): unknown[] {
  return [
    workspaceId,
    boardId,
    name,
    '[{"height":4,"kind":"runtime_truth_summary","widgetId":"runtime","width":6,"x":0,"y":0}]',
    idempotencyKey,
    "a".repeat(64),
  ];
}

import { createHash } from "node:crypto";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { ApprovalRepository } from "./approval-repo.js";
import { APPROVAL_EXECUTION_LINKAGE_POSTGRES_SQL } from "./approval-execution-linkage-migration.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL;
test("PostgreSQL canonical execution linkage migrates, backfills, indexes and pages without workspace scans", async (t) => {
  assert.ok(
    connectionString,
    "Run against a disposable loopback PostgreSQL database; missing evidence must fail this proof",
  );
  const scope = await createRemoteWorkerPostgresTestScope(connectionString, "cockpit_approval_linkage");
  try {
    const migrationUrl = new URL(connectionString);
    migrationUrl.searchParams.set("options", "-csearch_path=" + scope.schemaName);
    const migrationClient = new PostgresDatabaseClient(
      {
        connectionString: migrationUrl.toString(),
        database: decodeURIComponent(migrationUrl.pathname.replace(/^\//u, "")) || "postgres",
      },
      { pool: scope.scopedPool },
    );
    const assertDirections = async () => {
      const indexes = (
        await scope.scopedPool.query(
          "SELECT relation.relname AS name, ARRAY[pg_catalog.pg_get_indexdef(relation.oid, 1, true), pg_catalog.pg_get_indexdef(relation.oid, 2, true), pg_catalog.pg_get_indexdef(relation.oid, 3, true), pg_catalog.pg_get_indexdef(relation.oid, 4, true)] AS keys, ARRAY[pg_catalog.pg_index_column_has_property(relation.oid::pg_catalog.regclass, 1, 'desc'), pg_catalog.pg_index_column_has_property(relation.oid::pg_catalog.regclass, 2, 'desc'), pg_catalog.pg_index_column_has_property(relation.oid::pg_catalog.regclass, 3, 'desc'), pg_catalog.pg_index_column_has_property(relation.oid::pg_catalog.regclass, 4, 'desc')] AS descending FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = current_schema() AND relation.relname = ANY($1::text[]) ORDER BY relation.relname",
          [["idx_approval_execution_run", "idx_approval_execution_durable_run"]],
        )
      ).rows;
      assert.equal(indexes.length, 2);
      for (const index of indexes) {
        assert.deepEqual(
          (index.keys as string[]).map((key) => key.toLowerCase()),
          [
            "workspace_id",
            index.name === "idx_approval_execution_run" ? "run_id" : "durable_run_id",
            "created_at",
            "approval_id",
          ],
        );
        assert.deepEqual(index.descending, [false, false, true, true]);
      }
    };
    await t.test("fresh PostgreSQL startup and a repeated startup retain both descending indexes", async () => {
      await assertDirections();
      assert.deepEqual((await runPostgresMigrations(migrationClient)).appliedVersions, []);
      await assertDirections();
    });
    const repo = new ApprovalRepository(scope.db);
    const create = (workspaceId: string, runId: string, sessionId = "session") =>
      repo.create({
        kind: "tool.invoke",
        riskLevel: "safe",
        payload: {},
        preview: {},
        linkage: { workspaceId, runId, sessionId },
      });
    const old = create("one", "run"),
      legacy = create("one", "run"),
      foreign = create("two", "run");
    scope.db.prepare("UPDATE approvals SET linkage_json=NULL WHERE approval_id=?").run(legacy.approvalId);
    scope.db.transaction("immediate", () => {
      for (let index = 0; index < 1100; index++) create("one", "other-" + index);
    });
    create("one", "run", "foreign-session");
    const first = repo.listByRunLinkage({ workspaceId: "one", runId: "run", sessionId: "session", limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = repo.listByRunLinkage({
      workspaceId: "one",
      runId: "run",
      sessionId: "session",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(
      new Set([...first.items, ...second.items].map((item) => item.approvalId)),
      new Set([old.approvalId, legacy.approvalId]),
    );
    assert.notEqual(first.items[0]!.approvalId, foreign.approvalId);
    repo.mergeLinkage(old.approvalId, { runId: "moved" });
    assert.equal(repo.listByRunLinkage({ workspaceId: "one", runId: "moved" }).items[0]!.approvalId, old.approvalId);
    scope.db
      .prepare("UPDATE approvals SET linkage_json=? WHERE approval_id=?")
      .run('{"workspaceId":"foreign","workspaceId":"one","runId":"run"}', old.approvalId);
    assert.equal(
      repo
        .listByRunLinkage({ workspaceId: "one", runId: "run" })
        .items.some((item) => item.approvalId === old.approvalId),
      true,
    );
    const before = scope.db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(legacy.approvalId);
    scope.db.prepare("DELETE FROM approval_execution_linkages WHERE approval_id=?").run(legacy.approvalId);
    await scope.scopedPool.query(APPROVAL_EXECUTION_LINKAGE_POSTGRES_SQL);
    assert.deepEqual(scope.db.prepare("SELECT * FROM approvals WHERE approval_id=?").get(legacy.approvalId), before);
    assert.equal(
      repo
        .listByRunLinkage({ workspaceId: "one", runId: "run", sessionId: "session" })
        .items.some((item) => item.approvalId === legacy.approvalId),
      true,
    );
    const plan = await scope.scopedPool.query(
      "SET enable_seqscan=off; EXPLAIN SELECT approval_id FROM approval_execution_linkages WHERE workspace_id='one' AND run_id='run' UNION SELECT approval_id FROM approval_execution_linkages WHERE workspace_id='one' AND durable_run_id='run'",
    );
    const details = JSON.stringify(plan);
    assert.match(details, /idx_approval_execution_run/);
    assert.match(details, /idx_approval_execution_durable_run/);

    await t.test(
      "indexed pending pages preserve real PostgreSQL database expiry and unfiltered history without mutation",
      async () => {
        const createExpiry = (expiresAt?: string) =>
          repo.create({
            kind: "tool.invoke",
            riskLevel: "safe",
            payload: {},
            preview: {},
            linkage: { workspaceId: "one", runId: "expiry-run" },
            expiresAt,
          });
        const noExpiry = createExpiry(),
          future = createExpiry("2999-01-01T00:00:00.000Z"),
          expired = createExpiry("2000-01-01T00:00:00.000Z");
        const before = scope.db.prepare("SELECT * FROM approvals ORDER BY approval_id").all();
        const first = repo.listByRunLinkage({ workspaceId: "one", runId: "expiry-run", status: "pending", limit: 1 });
        assert.equal(first.items.length, 1);
        assert.ok(first.nextCursor);
        const second = repo.listByRunLinkage({
          workspaceId: "one",
          runId: "expiry-run",
          status: "pending",
          limit: 1,
          cursor: first.nextCursor,
        });
        assert.equal(second.items.length, 1);
        assert.equal(second.nextCursor, undefined);
        assert.deepEqual(
          new Set([...first.items, ...second.items].map((row) => row.approvalId)),
          new Set([noExpiry.approvalId, future.approvalId]),
        );
        assert.deepEqual(
          new Set(
            repo.listByRunLinkage({ workspaceId: "one", runId: "expiry-run" }).items.map((row) => row.approvalId),
          ),
          new Set([noExpiry.approvalId, future.approvalId, expired.approvalId]),
        );
        assert.deepEqual(scope.db.prepare("SELECT * FROM approvals ORDER BY approval_id").all(), before);
      },
    );

    await t.test(
      "1000 linked records preserve scoped cursor order across historical ASC and DESC upgrades",
      async () => {
        scope.db.transaction("immediate", () => {
          for (let index = 0; index < 1_000; index++) {
            const linkage =
              index % 3 === 0
                ? { runId: "paging-run", durableRunId: "paging-run" }
                : index % 2 === 0
                  ? { runId: "paging-run" }
                  : { durableRunId: "paging-run" };
            const row = repo.create({
              kind: "tool.invoke",
              riskLevel: "safe",
              payload: {},
              preview: {},
              linkage: { workspaceId: "one", sessionId: "paging-session", ...linkage },
            });
            scope.db
              .prepare("UPDATE approvals SET created_at = ? WHERE approval_id = ?")
              .run(new Date(1_700_000_000_000 + Math.floor(index / 3)).toISOString(), row.approvalId);
          }
          create("foreign", "paging-run", "paging-session");
          create("one", "paging-run", "foreign-session");
        });
        const expected = scope.db
          .prepare(
            "SELECT approval_id FROM approval_execution_linkages WHERE workspace_id = ? AND (run_id = ? OR durable_run_id = ?) AND session_id = ? ORDER BY created_at DESC, approval_id DESC",
          )
          .all<{ approval_id: string }>("one", "paging-run", "paging-run", "paging-session")
          .map((row) => row.approval_id);
        assert.equal(expected.length, 1_000);
        const assertPages = () => {
          const actual: string[] = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = repo.listByRunLinkage({
              workspaceId: "one",
              runId: "paging-run",
              sessionId: "paging-session",
              limit: 100,
              cursor,
            });
            assert.equal(page.items.length, 100);
            actual.push(...page.items.map((item) => item.approvalId));
            cursor = page.nextCursor;
            if (cursor) {
              assert.equal(cursors.has(cursor), false);
              cursors.add(cursor);
            }
            assert.ok(actual.length <= 1_000, "cursor traversal must not duplicate or leak scoped records");
          } while (cursor);
          assert.deepEqual(actual, expected);
          assert.equal(new Set(actual).size, 1_000);
        };
        assertPages();
        for (const previousDirection of ["ASC", "DESC"] as const) {
          scope.db.transaction("immediate", () => {
            scope.db.exec(
              "DROP INDEX idx_approval_execution_run; DROP INDEX idx_approval_execution_durable_run;" +
                "CREATE INDEX idx_approval_execution_run ON approval_execution_linkages(workspace_id, run_id, created_at " +
                previousDirection +
                ", approval_id " +
                previousDirection +
                ");" +
                "CREATE INDEX idx_approval_execution_durable_run ON approval_execution_linkages(workspace_id, durable_run_id, created_at " +
                previousDirection +
                ", approval_id " +
                previousDirection +
                ");",
            );
            scope.db.prepare("DELETE FROM schema_migrations WHERE version = 210").run();
          });
          const retained = {
            approvals: scope.db.prepare("SELECT * FROM approvals ORDER BY approval_id").all(),
            linkages: scope.db.prepare("SELECT * FROM approval_execution_linkages ORDER BY approval_id").all(),
            ledger: scope.db.prepare("SELECT * FROM schema_migrations WHERE version <= 209 ORDER BY version").all(),
            laterLedger: scope.db.prepare("SELECT * FROM schema_migrations WHERE version > 210 ORDER BY version").all(),
            objects: (
              await scope.scopedPool.query(
                "SELECT relation.relname, relation.relkind, relation.oid::text FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = current_schema() AND relation.relname NOT IN ('idx_approval_execution_run', 'idx_approval_execution_durable_run') ORDER BY relation.relname",
              )
            ).rows,
          };
          assertPages();
          const migrated = await runPostgresMigrations(migrationClient);
          assert.deepEqual(migrated.appliedVersions, [210]);
          assert.equal(migrated.latestVersion, 224);
          await assertDirections();
          assert.deepEqual(scope.db.prepare("SELECT * FROM approvals ORDER BY approval_id").all(), retained.approvals);
          assert.deepEqual(
            scope.db.prepare("SELECT * FROM approval_execution_linkages ORDER BY approval_id").all(),
            retained.linkages,
          );
          assert.deepEqual(
            scope.db.prepare("SELECT * FROM schema_migrations WHERE version <= 209 ORDER BY version").all(),
            retained.ledger,
          );
          assert.deepEqual(
            scope.db.prepare("SELECT * FROM schema_migrations WHERE version > 210 ORDER BY version").all(),
            retained.laterLedger,
          );
          assert.deepEqual(
            (
              await scope.scopedPool.query(
                "SELECT relation.relname, relation.relkind, relation.oid::text FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = current_schema() AND relation.relname NOT IN ('idx_approval_execution_run', 'idx_approval_execution_durable_run') ORDER BY relation.relname",
              )
            ).rows,
            retained.objects,
          );
          assertPages();
          assert.deepEqual((await runPostgresMigrations(migrationClient)).appliedVersions, []);
          await assertDirections();
          assertPages();
        }
      },
    );

    await t.test("credential-route hash purge preserves keys, claims, status and unrelated records", async () => {
      const migration = POSTGRES_MIGRATIONS.find(
        (item) => item.name === "purge_credential_route_idempotency_payload_hashes",
      );
      assert.ok(migration);
      assert.equal(migration.version, 199);
      const sentinel = createHash("sha256").update("credential_route_historical_payload_hash_purged_v1").digest("hex");
      const routes = [
        "/api/v1/secrets/providers/:providerId",
        "/api/v1/auth/settings",
        "/api/v1/integrations/connections",
        "/api/v1/secrets/providers",
        "/api/v1/auth/settings/extra",
      ];
      for (const [index, route] of routes.entries()) {
        await scope.scopedPool.query(
          "INSERT INTO mutation_idempotency (method,route_path,idempotency_key,actor_scope,payload_hash,status,claim_token,claim_expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            index === 1 ? "PATCH" : "PUT",
            route,
            "migration-proof-" + index,
            "operator:disposable",
            createHash("sha256")
              .update("synthetic-body-" + index)
              .digest("hex"),
            index === 0 ? "pending" : index === 1 ? "failed" : "completed",
            index === 0 ? "synthetic-claim" : null,
            index === 0 ? "2026-01-03T00:00:00.000Z" : null,
            "2026-01-01T00:00:00.000Z",
            "2026-01-02T00:00:00.000Z",
          ],
        );
      }
      const read = async () =>
        (await scope.scopedPool.query("SELECT * FROM mutation_idempotency ORDER BY route_path,idempotency_key")).rows;
      const before = await read();
      await scope.scopedPool.query(migration.sql);
      const after = await read();
      assert.equal(after.length, before.length, "rows and replay/conflict keys must never be deleted");
      for (const previous of before) {
        const current = after.find(
          (row) =>
            row.method === previous.method &&
            row.route_path === previous.route_path &&
            row.idempotency_key === previous.idempotency_key &&
            row.actor_scope === previous.actor_scope,
        );
        assert.ok(current);
        const credential = routes.slice(0, 2).includes(previous.route_path);
        assert.deepEqual(
          current,
          { ...previous, payload_hash: credential ? sentinel : previous.payload_hash },
          "only exact credential-route payload hashes may change",
        );
      }
      await scope.scopedPool.query(migration.sql);
      assert.deepEqual(await read(), after, "migration must be idempotent on real PostgreSQL");
    });
  } finally {
    await scope.teardown();
  }
});

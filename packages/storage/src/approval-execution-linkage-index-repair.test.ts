import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalRepository } from "./approval-repo.js";
import type { DatabaseClient } from "./db.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { assertPostgresMigrationIntegrity, buildCanonicalPostgresSchemaShapeManifest } from "./postgres/migrator.js";
import { buildPostgresSchemaShapeManifest } from "./postgres/schema-shape.js";
import {
  APPROVAL_EXECUTION_LINKAGE_INDEX_REPAIR_POSTGRES_SQL,
  APPROVAL_EXECUTION_LINKAGE_INDEX_REPAIR_SQLITE_SQL,
} from "./approval-execution-linkage-index-repair.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
const indexNames = ["idx_approval_execution_run", "idx_approval_execution_durable_run"] as const;

function assertIndexDirections(db: DatabaseClient): void {
  for (const name of indexNames) {
    const keys = db.prepare("PRAGMA index_xinfo(" + name + ")").all<{ name: string | null; desc: number; key: number }>()
      .filter((row) => row.key === 1).map((row) => [row.name, row.desc]);
    assert.deepEqual(keys, [
      ["workspace_id", 0], [name === indexNames[0] ? "run_id" : "durable_run_id", 0],
      ["created_at", 1], ["approval_id", 1],
    ]);
  }
}

function snapshotData(db: DatabaseClient): unknown {
  return {
    approvals: db.prepare("SELECT * FROM approvals ORDER BY approval_id").all(),
    linkages: db.prepare("SELECT * FROM approval_execution_linkages ORDER BY approval_id").all(),
  };
}

function assertThousandRecordPages(db: DatabaseClient): void {
  const expected = db.prepare("SELECT approval_id FROM approval_execution_linkages WHERE workspace_id = ? AND (run_id = ? OR durable_run_id = ?) AND session_id = ? ORDER BY created_at DESC, approval_id DESC")
    .all<{ approval_id: string }>("one", "run", "run", "session").map((row) => row.approval_id);
  assert.equal(expected.length, 1_000);
  const repo = new ApprovalRepository(db);
  const actual: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = repo.listByRunLinkage({ workspaceId: "one", runId: "run", sessionId: "session", limit: 100, cursor });
    assert.equal(page.items.length, 100);
    actual.push(...page.items.map((item) => item.approvalId));
    cursor = page.nextCursor;
    if (cursor) {
      assert.equal(cursors.has(cursor), false, "cursor must advance through timestamp ties");
      cursors.add(cursor);
    }
    assert.ok(actual.length <= 1_000, "paging must not duplicate or leak scoped records");
  } while (cursor);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, 1_000);
}

it("validates every current PostgreSQL registry digest and rejects altered repair SQL", () => {
  for (const definition of POSTGRES_MIGRATIONS) {
    assert.doesNotThrow(() => assertPostgresMigrationIntegrity(definition));
  }
  const repair = POSTGRES_MIGRATIONS.find((definition) => definition.name === "approval_execution_linkage_index_sort_convergence");
  assert.ok(repair);
  assert.equal(repair.integritySha256, "fd9d22a3cccbb824e727517aabe5987a00fdd1936a7c3dd276724cbef47543b8");
  assert.throws(() => assertPostgresMigrationIntegrity({
    ...repair,
    sql: repair.sql.replace("created_at DESC", "created_at ASC"),
  }), /integrity hash mismatch/);
});

it("fresh SQLite and canonical PostgreSQL shapes retain both descending execution linkage indexes", () => {
  const db = files.open({ dbPath: ":memory:" });
  assertIndexDirections(db);
  assert.deepEqual(APPROVAL_EXECUTION_LINKAGE_INDEX_REPAIR_SQLITE_SQL, APPROVAL_EXECUTION_LINKAGE_INDEX_REPAIR_POSTGRES_SQL);
  const canonical = buildCanonicalPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS);
  const forward = buildPostgresSchemaShapeManifest(POSTGRES_MIGRATIONS.filter((migration) => migration.version >= 209));
  for (const shape of [canonical, forward]) {
    for (const name of indexNames) {
      assert.deepEqual(shape.indexes.find((index) => index.name === name)?.keys, [
        "workspace_id", name === indexNames[0] ? "run_id" : "durable_run_id", "created_at desc", "approval_id desc",
      ]);
    }
  }
});

for (const previousDirection of ["ASC", "DESC"] as const) {
  it("upgrades populated v262 " + previousDirection + " indexes through normal startup without changing rows or cursor paging", () => {
    const dbPath = files.path("approval-linkage-sort");
    const before = files.open({ dbPath });
    const repo = new ApprovalRepository(before);
    before.transaction("immediate", () => {
      for (let index = 0; index < 1_000; index++) {
        const linkage = index % 3 === 0 ? { runId: "run", durableRunId: "run" }
          : index % 2 === 0 ? { runId: "run" } : { durableRunId: "run" };
        const row = repo.create({ kind: "tool.invoke", riskLevel: "safe", payload: {}, preview: {}, linkage: { workspaceId: "one", sessionId: "session", ...linkage } });
        before.prepare("UPDATE approvals SET created_at = ? WHERE approval_id = ?")
          .run(new Date(1_700_000_000_000 + Math.floor(index / 3)).toISOString(), row.approvalId);
      }
      repo.create({ kind: "tool.invoke", riskLevel: "safe", payload: {}, preview: {}, linkage: { workspaceId: "foreign", runId: "run", sessionId: "session" } });
      repo.create({ kind: "tool.invoke", riskLevel: "safe", payload: {}, preview: {}, linkage: { workspaceId: "one", runId: "run", sessionId: "foreign" } });
      before.exec("DROP INDEX idx_approval_execution_run; DROP INDEX idx_approval_execution_durable_run;"
        + "CREATE INDEX idx_approval_execution_run ON approval_execution_linkages(workspace_id, run_id, created_at " + previousDirection + ", approval_id " + previousDirection + ");"
        + "CREATE INDEX idx_approval_execution_durable_run ON approval_execution_linkages(workspace_id, durable_run_id, created_at " + previousDirection + ", approval_id " + previousDirection + ");");
      before.prepare("DELETE FROM schema_migrations WHERE version >= 263").run();
    });
    const rows = snapshotData(before);
    const ledger = before.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const objects = before.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT IN (?, ?) ORDER BY name")
      .all(...indexNames);
    assertThousandRecordPages(before);
    before.close();

    const upgraded = files.open({ dbPath });
    assertIndexDirections(upgraded);
    assert.deepEqual(snapshotData(upgraded), rows);
    assert.deepEqual(upgraded.prepare("SELECT * FROM schema_migrations WHERE version <= 262 ORDER BY version").all(), ledger);
    assert.deepEqual(upgraded.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT IN (?, ?) ORDER BY name").all(...indexNames), objects);
    assert.equal(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 263").get<{ name: string }>()?.name, "approval_execution_linkage_index_sort_convergence");
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
    assertThousandRecordPages(upgraded);
    upgraded.close();

    const restarted = files.open({ dbPath });
    assertIndexDirections(restarted);
    assert.deepEqual(snapshotData(restarted), rows);
    assertThousandRecordPages(restarted);
  });
}

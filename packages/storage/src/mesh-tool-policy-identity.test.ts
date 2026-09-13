import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import type { DatabaseClient } from "./db.js";
import { createDatabase, __sqliteInternals } from "./sqlite.js";
import { ToolAccessDecisionRepository } from "./tool-access-decision-repo.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

function verifyMeshAccounting(db: DatabaseClient) {
  const repo = new ToolAccessDecisionRepository(db);
  const base = { agentId: "mesh-agent", sessionId: "mesh-session", workspaceId: "mesh-workspace", taskId: "mesh-task",
    allowed: true, requiresApproval: false, riskLevel: "caution" as const, reasonCodes: ["allowed"] };
  const record = (toolName: string, countsTowardLimits = true, timestamp?: string) => repo.record({
    ...base, toolName, policyToolName: "mesh.invoke", countsTowardLimits,
  }, timestamp);
  record("mesh:node-a:tool:project.status");
  record("mesh:node-b:mcp_server:docs");
  record("mesh:node-a:tool:preview", false);
  record("mesh:node-a:tool:old", true, new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  repo.record({ ...base, toolName: "mesh:unbound:tool:read" });
  repo.record({ ...base, toolName: "mcp.docs.read", policyToolName: "mcp.invoke" });
  for (const scope of ["global", "agent", "session", "workspace", "task"] as const) {
    assert.equal(repo.countToolCallsInLastHourInScope({ ...base, scope, toolName: "mesh.invoke" }), 2, scope);
    assert.equal(repo.countToolCallsInLastHourInScope({ ...base, scope, toolName: "mesh:node-a:tool:project.status" }), 1, scope);
    assert.equal(repo.countToolCallsInLastHourInScope({ ...base, scope, toolName: "mcp.invoke" }), 1, scope);
    assert.equal(repo.countWritesInLastHourInScope({ ...base, scope }), 3, scope);
  }
  for (const name of ["fs.read", "mcp.docs.read", "mesh.invoke", "MESH:a:tool:read", "mesh:a:skill:guide"]) {
    assert.throws(() => record(name), Error, name);
  }
}

const legacyRowsSql = `
  CREATE TABLE tool_access_decisions (tool_name TEXT, timestamp TEXT, counts_toward_limits INTEGER);
  INSERT INTO tool_access_decisions VALUES ('mcp.invoke', '2026-09-11T00:00:00Z', 1);
`;

it("accounts for mesh and MCP separately across every SQLite scope", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try { verifyMeshAccounting(db); } finally { db.close(); }
});

it("upgrades and replays mesh accounting without changing retained SQLite evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(legacyRowsSql);
    __sqliteInternals.applySchemaMigrationForTest(217, db);
    db.exec("INSERT INTO tool_access_decisions VALUES ('mcp.docs.read', '2026-09-11T00:00:01Z', 1, 'mcp.invoke')");
    const before = db.prepare("SELECT * FROM tool_access_decisions ORDER BY timestamp").all();
    for (let index = 0; index < 2; index += 1) {
      __sqliteInternals.applySchemaMigrationForTest(219, db);
      assert.deepEqual(db.prepare("SELECT * FROM tool_access_decisions ORDER BY timestamp").all(), before);
    }
    db.exec("INSERT INTO tool_access_decisions VALUES ('mesh:a:tool:read', '2026-09-11T00:00:02Z', 1, 'mesh.invoke')");
    assert.throws(() => db.exec("UPDATE tool_access_decisions SET policy_tool_name = 'mesh.invoke' WHERE tool_name = 'mcp.docs.read'"));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tool_access_decisions_policy_time'").get());
  } finally { db.close(); }
});

it("rolls back the SQLite migration if copying an existing identity cannot commit", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(legacyRowsSql);
    __sqliteInternals.applySchemaMigrationForTest(217, db);
    db.exec("CREATE TRIGGER fail_copy BEFORE UPDATE ON tool_access_decisions BEGIN SELECT RAISE(ABORT, 'fixture copy refused'); END");
    const before = db.prepare("SELECT * FROM tool_access_decisions").all();
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => __sqliteInternals.applySchemaMigrationForTest(219, db), /fixture copy refused/);
    db.exec("ROLLBACK");
    assert.deepEqual(db.prepare("SELECT * FROM tool_access_decisions").all(), before);
    assert.equal(db.prepare("PRAGMA table_info(tool_access_decisions)").all().length, 4);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tool_access_decisions_policy_time'").get());
  } finally { db.close(); }
});

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
it("accounts for mesh and upgrades existing identities on actual PostgreSQL", { skip: !url, timeout: 120_000 }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(url!, "mesh_policy_identity");
  try {
    verifyMeshAccounting(scope.db);
    const client = await scope.scopedPool.connect();
    try {
      await client.query(legacyRowsSql.replace("CREATE TABLE", "CREATE TEMPORARY TABLE"));
      await client.query(POSTGRES_MIGRATIONS.find((item) => item.version === 162)!.sql);
      await client.query("INSERT INTO tool_access_decisions VALUES ('mcp.docs.read', '2026-09-11T00:00:01Z', 1, 'mcp.invoke')");
      const before = (await client.query("SELECT * FROM tool_access_decisions ORDER BY timestamp")).rows;
      for (let index = 0; index < 2; index += 1) {
        await client.query(POSTGRES_MIGRATIONS.find((item) => item.version === 164)!.sql);
        assert.deepEqual((await client.query("SELECT * FROM tool_access_decisions ORDER BY timestamp")).rows, before);
      }
      await client.query("INSERT INTO tool_access_decisions VALUES ('mesh:a:mcp_server:docs', '2026-09-11T00:00:02Z', 1, 'mesh.invoke')");
      await assert.rejects(client.query("UPDATE tool_access_decisions SET policy_tool_name = 'mesh.invoke' WHERE tool_name = 'mcp.docs.read'"), /check constraint/);
    } finally { client.release(); }
  } finally { await scope.teardown(); }
});

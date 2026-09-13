import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { createDatabase, __sqliteInternals } from "./sqlite.js";
import { verifyToolPolicyIdentityAccounting } from "./tool-policy-identity-fixture.js";

it("counts named MCP calls against shared and exact limits on SQLite", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    verifyToolPolicyIdentityAccounting(db);
  } finally {
    db.close();
  }
});

it("upgrades existing access decisions without changing retained evidence", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE tool_access_decisions (
      tool_name TEXT, timestamp TEXT, counts_toward_limits INTEGER);
      INSERT INTO tool_access_decisions VALUES ('mcp.invoke', '2026-09-09T00:00:00Z', 1);`);
    __sqliteInternals.applySchemaMigrationForTest(217, db);
    const row = db.prepare("SELECT * FROM tool_access_decisions").get();
    assert.deepEqual(
      { ...row },
      {
        tool_name: "mcp.invoke",
        timestamp: "2026-09-09T00:00:00Z",
        counts_toward_limits: 1,
        policy_tool_name: null,
      },
    );
  } finally {
    db.close();
  }
});

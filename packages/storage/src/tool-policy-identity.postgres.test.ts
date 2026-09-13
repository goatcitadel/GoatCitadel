import { it } from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyToolPolicyIdentityAccounting } from "./tool-policy-identity-fixture.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
it(
  "counts named MCP limits and preserves existing PostgreSQL decisions through upgrade",
  {
    skip: !url,
    timeout: 300_000,
  },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(url!, "tool_policy_identity");
    try {
      verifyToolPolicyIdentityAccounting(scope.db);
      const client = await scope.scopedPool.connect();
      try {
        // The temporary legacy table shadows the migrated fixture in this connection.
        // Run the real forward migration twice to cover upgrade and bootstrap replay.
        await client.query(`CREATE TEMPORARY TABLE tool_access_decisions (
        tool_name TEXT, timestamp TEXT, counts_toward_limits INTEGER);
        INSERT INTO tool_access_decisions VALUES ('mcp.invoke', '2026-09-09T00:00:00Z', 1);`);
        const migration = POSTGRES_MIGRATIONS.find((item) => item.version === 162)!;
        await client.query(migration.sql);
        await client.query(migration.sql);
        const { rows } = await client.query("SELECT * FROM tool_access_decisions");
        assert.deepEqual(rows, [
          {
            tool_name: "mcp.invoke",
            timestamp: "2026-09-09T00:00:00Z",
            counts_toward_limits: 1,
            policy_tool_name: null,
          },
        ]);
        await assert.rejects(
          client.query("UPDATE tool_access_decisions SET policy_tool_name = 'mcp.invoke'"),
          /check constraint/,
        );
      } finally {
        client.release();
      }
    } finally {
      await scope.teardown();
    }
  },
);

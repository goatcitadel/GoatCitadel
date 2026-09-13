import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyMemoryItemEnumeration } from "./memory-item-enumeration-fixture.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL enumerates more than 500 scoped memory items and rejects mutated or expired cursors", { skip: !connectionString }, async (context) => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "memory_enumeration");
  try { context.diagnostic(JSON.stringify(await verifyMemoryItemEnumeration(scope.db))); }
  finally { await scope.teardown(); }
});

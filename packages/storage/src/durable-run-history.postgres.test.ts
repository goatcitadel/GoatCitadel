import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyDurableRunHistory } from "./durable-run-history.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL durable history filters before pagination and rejects invalid scope cursors", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "durable_history");
  try { verifyDurableRunHistory(scope.db); } finally { await scope.teardown(); }
});

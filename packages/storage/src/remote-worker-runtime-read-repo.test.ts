import { describe, it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { remoteWorkerRuntimeReadCases } from "./remote-worker-runtime-read-fixture.js";

describe("remote worker assignment runtime read (SQLite)", () => {
  for (const scenario of remoteWorkerRuntimeReadCases) it(scenario.name, async () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try { await scenario.run(db); } finally { db.close(); }
  });
});
describe("remote worker assignment runtime read (PostgreSQL)", { skip: !process.env.GOATCITADEL_TEST_POSTGRES_URL }, () => {
  for (const scenario of remoteWorkerRuntimeReadCases) it(scenario.name, async () => {
    const scope = await createRemoteWorkerPostgresTestScope(process.env.GOATCITADEL_TEST_POSTGRES_URL!, "worker_runtime_read");
    try { await scenario.run(scope.db); } finally { await scope.teardown(); }
  });
});

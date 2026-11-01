import { test } from "node:test";
import { verifyDeletePackCascade } from "./prompt-pack-delete-cascade.test-support.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL deletes its prompt packs with every run and score",
  { skip: !connectionString, timeout: 120_000 },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "prompt_delete");
    try {
      await verifyDeletePackCascade(scope.db);
    } finally {
      await scope.teardown();
    }
  },
);

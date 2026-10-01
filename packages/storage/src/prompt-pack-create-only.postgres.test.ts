import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyConcurrentCreateOnly, verifyCreateOnlyPromptPack } from "./prompt-pack-create-only.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL create-only prompt packs preserve evidence, roll back failures, and admit one concurrent writer",
  { skip: !connectionString, timeout: 120_000 },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "prompt_create");
    try {
      verifyCreateOnlyPromptPack(scope.db);
      const url = new URL(connectionString!);
      url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
      await verifyConcurrentCreateOnly(scope.db, { connectionString: url.toString() });
    } finally {
      await scope.teardown();
    }
  },
);

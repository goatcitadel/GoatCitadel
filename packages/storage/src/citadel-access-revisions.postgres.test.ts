import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyCitadelAccessRevisions, verifyCitadelAccessRaces } from "./citadel-access-revisions.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL Citadel access revisions commit atomically across independent writers", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "citadel_access_revision");
  try {
    verifyCitadelAccessRevisions(scope.db);
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    await verifyCitadelAccessRaces(scope.db, {
      connectionString: url.toString(), database: decodeURIComponent(url.pathname.slice(1)) || "postgres", pool: { max: 1 },
    });
  } finally { await scope.teardown(); }
});

import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyCitadelStructureRevisions, verifyCitadelStructureRaces } from "./citadel-structure-revisions.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL Citadel structure revisions commit atomically across independent writers", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "citadel_structure_revision");
  try {
    verifyCitadelStructureRevisions(scope.db);
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    await verifyCitadelStructureRaces(scope.db, {
      connectionString: url.toString(), database: decodeURIComponent(url.pathname.slice(1)) || "postgres", pool: { max: 1 },
    });
  } finally { await scope.teardown(); }
});

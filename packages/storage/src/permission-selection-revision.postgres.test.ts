import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyPermissionSelectionRaces, verifyPermissionSelectionRevisions } from "./permission-selection-revision.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL reviewed activations and defaults reject independent competing profile writers", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "permission_selection_revision");
  try {
    verifyPermissionSelectionRevisions(scope.db);
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    await verifyPermissionSelectionRaces(scope.db, "postgres", {
      connectionString: url.toString(), database: decodeURIComponent(url.pathname.slice(1)) || "postgres", pool: { max: 1 },
    });
  } finally { await scope.teardown(); }
});

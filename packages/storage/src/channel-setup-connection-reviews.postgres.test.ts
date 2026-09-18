import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyChannelSetupConnectionReviews, verifyChannelSetupConnectionRaces } from "./channel-setup-connection-reviews.test-support.js";
const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL channel finalization commits the reviewed draft and connection together", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "channel_review");
  try {
    verifyChannelSetupConnectionReviews(scope.db);
    const url = new URL(connectionString!); url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    await verifyChannelSetupConnectionRaces(scope.db, { connectionString: url.toString(), database: decodeURIComponent(url.pathname.slice(1)) || "postgres", pool: { max: 1 } });
  } finally { await scope.teardown(); }
});

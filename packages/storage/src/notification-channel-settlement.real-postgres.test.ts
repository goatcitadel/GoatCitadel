import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import {
  verifyNotificationBindingFailures,
  verifyNotificationChannelSettlement,
  verifyNotificationSettlementCas,
} from "./notification-channel-settlement.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL notification settlement, scope and concurrent snapshot parity",
  { skip: !connectionString, timeout: 120_000 },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "notification_settlement");
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    const peer = new PostgresSyncDatabaseClient({
      connectionString: url.toString(),
      database: decodeURIComponent(url.pathname.slice(1)) || "postgres",
      pool: { max: 1 },
    });
    try {
      verifyNotificationChannelSettlement(scope.db);
      verifyNotificationBindingFailures(scope.db);
      verifyNotificationSettlementCas(scope.db, peer);
    } finally {
      peer.close();
      await scope.teardown();
    }
  },
);

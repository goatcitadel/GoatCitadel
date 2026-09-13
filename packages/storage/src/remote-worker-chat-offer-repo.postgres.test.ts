import { it } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyChatOfferScheduling } from "./remote-worker-chat-offer-fixture.js";
import { verifyChatExecutionPlacement } from "./remote-worker-chat-placement-fixture.js";
import { verifyOrdinaryChatTaskAdmission } from "./remote-worker-chat-task-fixture.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
it(
  "Chat offer scheduling preserves canonical admission, exact replay and rollback on PostgreSQL",
  {
    skip: !url,
    timeout: 300_000,
  },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(url!, "chat_offer");
    try {
      verifyChatOfferScheduling(scope.db);
      verifyChatExecutionPlacement(scope.db);
      verifyOrdinaryChatTaskAdmission(scope.db);
    } finally {
      await scope.teardown();
    }
  },
);

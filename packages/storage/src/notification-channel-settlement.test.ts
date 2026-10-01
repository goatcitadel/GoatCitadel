import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import {
  verifyNotificationBindingFailures,
  verifyNotificationChannelSettlement,
  verifyNotificationSettlementCas,
} from "./notification-channel-settlement.test-support.js";

for (const verify of [
  verifyNotificationChannelSettlement,
  verifyNotificationBindingFailures,
  verifyNotificationSettlementCas,
]) {
  test(`SQLite ${verify.name}`, () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      verify(db);
    } finally {
      db.close();
    }
  });
}

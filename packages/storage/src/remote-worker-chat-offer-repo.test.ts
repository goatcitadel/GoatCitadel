import { it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyChatOfferScheduling } from "./remote-worker-chat-offer-fixture.js";
import { verifyChatExecutionPlacement } from "./remote-worker-chat-placement-fixture.js";
import { verifyOrdinaryChatTaskAdmission } from "./remote-worker-chat-task-fixture.js";

it("Chat offer scheduling preserves canonical admission, exact replay and rollback on SQLite", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try {
    verifyChatOfferScheduling(db);
    verifyChatExecutionPlacement(db);
    verifyOrdinaryChatTaskAdmission(db);
  } finally {
    db.close();
  }
});

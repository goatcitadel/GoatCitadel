import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyDurableRunHistory } from "./durable-run-history.test-support.js";

test("SQLite durable history filters before pagination and rejects invalid scope cursors", () => {
  const db = createDatabase({ dbPath: ":memory:" });
  try { verifyDurableRunHistory(db); } finally { db.close(); }
});

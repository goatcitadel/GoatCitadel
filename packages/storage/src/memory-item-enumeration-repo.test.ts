import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyMemoryItemEnumeration } from "./memory-item-enumeration-fixture.js";

test("SQLite enumerates more than 500 scoped memory items and rejects mutated or expired cursors", async (context) => {
  const db = createDatabase({ dbPath: ":memory:" });
  try { context.diagnostic(JSON.stringify(await verifyMemoryItemEnumeration(db))); }
  finally { db.close(); }
});

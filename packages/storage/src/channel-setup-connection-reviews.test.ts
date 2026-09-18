import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyChannelSetupConnectionReviews, verifyChannelSetupConnectionRaces } from "./channel-setup-connection-reviews.test-support.js";

test("SQLite channel finalization commits the reviewed draft and connection together", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-channel-review-")), dbPath = path.join(root, "test.db");
  const db = createDatabase({ dbPath });
  try { verifyChannelSetupConnectionReviews(db); await verifyChannelSetupConnectionRaces(db, { dbPath }); }
  finally { db.close(); /* Retain this task-owned disposable database as concurrency evidence. */ }
});

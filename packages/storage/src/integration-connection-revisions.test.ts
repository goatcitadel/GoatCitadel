import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyIntegrationConnectionRevisions, verifyIntegrationConnectionRaces } from "./integration-connection-revisions.test-support.js";

test("SQLite integration revisions preserve reviewed writes across independent connections", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-integration-revision-"));
  const dbPath = path.join(root, "connections.db");
  const db = createDatabase({ dbPath });
  try { verifyIntegrationConnectionRevisions(db); await verifyIntegrationConnectionRaces(db, { dbPath }); }
  finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-integration-revision-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

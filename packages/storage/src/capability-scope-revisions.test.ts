import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyCapabilityScopeRevisions } from "./capability-scope-revisions.test-support.js";
import { verifyCapabilityScopeRaces } from "./capability-scope-races.test-support.js";

test("SQLite reviewed capability selections fence scope, parent, lifecycle and every legacy writer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-capability-review-"));
  const dbPath = path.join(root, "scope.db"),
    db = createDatabase({ dbPath });
  try {
    verifyCapabilityScopeRevisions(db);
    await verifyCapabilityScopeRaces(db, { dbPath });
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-capability-review-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

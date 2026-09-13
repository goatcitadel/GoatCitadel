import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyPermissionSelectionRaces, verifyPermissionSelectionRevisions } from "./permission-selection-revision.test-support.js";

test("SQLite reviewed activations and default changes serialize competing profiles and preserve rejected state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-permission-selection-"));
  const dbPath = path.join(root, "profiles.db");
  const db = createDatabase({ dbPath });
  try {
    verifyPermissionSelectionRevisions(db);
    await verifyPermissionSelectionRaces(db, "sqlite", { dbPath });
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-permission-selection-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

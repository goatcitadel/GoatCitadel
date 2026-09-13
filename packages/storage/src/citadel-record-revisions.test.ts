import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyCitadelRecordRevisions, verifyCitadelRecordRaces } from "./citadel-record-revisions.test-support.js";

test("SQLite Citadel profile revisions preserve reviewed writes across independent writers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-citadel-record-revision-"));
  const dbPath = path.join(root, "citadels.db");
  const db = createDatabase({ dbPath });
  try {
    verifyCitadelRecordRevisions(db);
    await verifyCitadelRecordRaces(db, { dbPath });
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-citadel-record-revision-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

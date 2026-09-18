import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDatabase } from "./sqlite.js";
import { verifyCitadelVaultRevisions, verifyCitadelVaultRaces } from "./citadel-vault-revisions.test-support.js";

test("SQLite Citadel vault revisions commit atomically across independent writers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-citadel-vault-revision-"));
  const dbPath = path.join(root, "citadels.db");
  const db = createDatabase({ dbPath });
  try {
    verifyCitadelVaultRevisions(db);
    await verifyCitadelVaultRaces(db, { dbPath });
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-citadel-vault-revision-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

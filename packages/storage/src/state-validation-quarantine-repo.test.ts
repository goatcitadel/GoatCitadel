import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

describe("state_validation_quarantine schema", () => {
  it("creates the quarantine table on first boot", () => {
    const dbPath = path.join(os.tmpdir(), `gc-quarantine-schema-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state_validation_quarantine'")
      .get();
    assert.ok(row, "quarantine table should exist after migrate");
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_state_validation_quarantine_store_observed'",
      )
      .get();
    assert.ok(idx, "quarantine index should exist after migrate");
  });
});

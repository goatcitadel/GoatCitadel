import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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

describe("sqlite approvals migration", () => {
  it("adds explanation columns to legacy approvals table", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-legacy-approvals-${randomUUID()}.db`);
    createdFiles.push(dbPath);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE approvals (
        approval_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT
      );
    `);
    legacy.close();

    const db = createDatabase({ dbPath });
    const rows = db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));

    assert.equal(columns.has("explanation_status"), true);
    assert.equal(columns.has("explanation_json"), true);
    assert.equal(columns.has("explanation_error"), true);
    assert.equal(columns.has("explanation_updated_at"), true);
    assert.equal(columns.has("expires_at"), true);

    db.close();
  });
});

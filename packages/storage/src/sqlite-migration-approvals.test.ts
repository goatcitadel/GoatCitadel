import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

describe("sqlite approvals migration", () => {
  it("adds explanation columns to legacy approvals table", () => {
    const dbPath = tempDbs.path("goatcitadel-legacy-approvals");

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

    const db = tempDbs.open({ dbPath });
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

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

describe("sqlite agent profile migration", () => {
  it("creates agent_profiles table and required columns", () => {
    const dbPath = tempDbs.path("goatcitadel-agents-migration");
    const db = tempDbs.open({ dbPath });

    const rows = db.prepare("PRAGMA table_info(agent_profiles)").all() as Array<{ name: string }>;
    const columns = new Set(rows.map((row) => row.name));

    assert.equal(columns.has("agent_id"), true);
    assert.equal(columns.has("role_id"), true);
    assert.equal(columns.has("name"), true);
    assert.equal(columns.has("lifecycle_status"), true);
    assert.equal(columns.has("specialties_json"), true);
    assert.equal(columns.has("default_tools_json"), true);
    assert.equal(columns.has("aliases_json"), true);
    db.close();
  });
});

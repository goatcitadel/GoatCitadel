import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";
import { __sqliteInternals } from "./sqlite.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const MIGRATION_VERSION = 273;
const MIGRATION_NAME = "purge_integration_plugin_records";
const PLUGIN_SETTING_KEY = "integration_plugins_v1";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

interface SettingRow {
  setting_key: string;
  value_json: string;
  updated_at: string;
}

// Stand-in for the single record list the removed integration plugin service kept.
const PLUGIN_RECORDS_JSON = JSON.stringify([
  { pluginId: "example-plugin", version: "1.0.0", enabled: true },
  { pluginId: "second-plugin", version: "0.2.0", enabled: false },
]);

const OTHER_SETTINGS: readonly SettingRow[] = [
  { setting_key: "integration_plugins_v2", value_json: '{"near":"miss"}', updated_at: "2026-01-02T00:00:00.000Z" },
  { setting_key: "integration_plugins", value_json: "[]", updated_at: "2026-01-03T00:00:00.000Z" },
  { setting_key: "xintegration_plugins_v1", value_json: "[]", updated_at: "2026-01-04T00:00:00.000Z" },
  { setting_key: "capability_scope.selection_nonce.v1:abc", value_json: '"n"', updated_at: "2026-01-05T00:00:00.000Z" },
  { setting_key: "ui.theme", value_json: '{"mode":"dark"}', updated_at: "2026-01-06T00:00:00.000Z" },
];

function applyMigrationTo(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  try {
    __sqliteInternals.applySchemaMigrationForTest(MIGRATION_VERSION, raw);
  } finally {
    raw.close();
  }
}

function readSettings(dbPath: string): SettingRow[] {
  const raw = new DatabaseSync(dbPath);
  try {
    return (raw.prepare("SELECT * FROM system_settings ORDER BY setting_key ASC").all() as unknown as SettingRow[]).map(
      (row) => ({ ...row }),
    );
  } finally {
    raw.close();
  }
}

describe("sqlite integration plugin record purge", () => {
  it("is registered under the shared migration name", () => {
    assert.equal(__sqliteInternals.getSchemaMigrationNameForTest(MIGRATION_VERSION), MIGRATION_NAME);
  });

  it("deletes the integration plugin setting and keeps every other setting", () => {
    const dbPath = tempDbs.path("goatcitadel-integration-plugin-purge");
    const db = tempDbs.open({ dbPath });
    const insert = db.prepare("INSERT INTO system_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)");
    insert.run(PLUGIN_SETTING_KEY, PLUGIN_RECORDS_JSON, "2026-01-01T00:00:00.000Z");
    for (const row of OTHER_SETTINGS) insert.run(row.setting_key, row.value_json, row.updated_at);
    db.close();
    const before = readSettings(dbPath);
    assert.ok(before.some((row) => row.setting_key === PLUGIN_SETTING_KEY));

    applyMigrationTo(dbPath);
    const after = readSettings(dbPath);

    assert.equal(
      after.some((row) => row.setting_key === PLUGIN_SETTING_KEY),
      false,
    );
    assert.deepEqual(
      after,
      before.filter((row) => row.setting_key !== PLUGIN_SETTING_KEY),
    );

    // A second run, and a run on an install that never stored the setting, change nothing.
    applyMigrationTo(dbPath);
    assert.deepEqual(readSettings(dbPath), after);
  });

  it("keeps integration connections' plugin columns readable", () => {
    const dbPath = tempDbs.path("goatcitadel-integration-plugin-columns");
    const db = tempDbs.open({ dbPath });
    const created = new IntegrationConnectionRepository(db).create({
      catalogId: "tool.github",
      kind: "productivity",
      key: "github",
      label: "GitHub",
      enabled: true,
      status: "connected",
      config: { scopes: ["repo"] },
      pluginId: "example-plugin",
      pluginVersion: "1.0.0",
      pluginEnabled: true,
    });
    db.close();

    applyMigrationTo(dbPath);

    const columns = new DatabaseSync(dbPath);
    try {
      const names = (
        columns.prepare("PRAGMA table_info(integration_connections)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      for (const name of ["plugin_id", "plugin_version", "plugin_enabled", "plugin_meta_json"]) {
        assert.ok(names.includes(name), `${name} must stay on integration_connections`);
      }
    } finally {
      columns.close();
    }

    const reopened = new IntegrationConnectionRepository(tempDbs.open({ dbPath }));
    const read = reopened.get(created.connectionId);
    assert.equal(read.pluginId, "example-plugin");
    assert.equal(read.pluginVersion, "1.0.0");
    assert.equal(read.pluginEnabled, true);
    assert.equal(reopened.list().length, 1);
  });
});

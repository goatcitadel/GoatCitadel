import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const skip = connectionString ? false : "Set GOATCITADEL_TEST_POSTGRES_URL to a disposable PostgreSQL instance.";
const upTo = (version: number) => POSTGRES_MIGRATIONS.filter((migration) => migration.version <= version);
const PLUGIN_SETTING_KEY = "integration_plugins_v1";

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

async function withSchema(
  prefix: string,
  run: (ctx: { admin: Pool; schema: string; migrations: PostgresDatabaseClient }) => Promise<void>,
) {
  assert.ok(connectionString);
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, new RegExp(`^${prefix}_[a-f0-9]{32}$`));
  const admin = new Pool({ connectionString });
  const scoped = new URL(connectionString);
  scoped.searchParams.set("options", `-csearch_path=${schema}`);
  const migrations = new PostgresDatabaseClient({ connectionString: scoped.toString(), database: "postgres" });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run({ admin, schema, migrations });
  } finally {
    await migrations.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

async function readSettings(admin: Pool, schema: string): Promise<SettingRow[]> {
  const result = await admin.query<SettingRow>(
    `SELECT setting_key, value_json, updated_at FROM ${schema}.system_settings ORDER BY setting_key`,
  );
  return result.rows;
}

test("real PostgreSQL fresh installs run the purge as a no-op", { skip }, async () => {
  await withSchema("plugin_purge_fresh", async ({ admin, schema, migrations }) => {
    const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    assert.equal(migrated.latestVersion, 224);
    assert.equal(
      POSTGRES_MIGRATIONS.find((migration) => migration.version === 222)?.name,
      "purge_integration_plugin_records",
    );
    assert.equal(
      (await readSettings(admin, schema)).some((row) => row.setting_key === PLUGIN_SETTING_KEY),
      false,
    );
  });
});

test("real PostgreSQL deletes the integration plugin setting and keeps every other setting", { skip }, async () => {
  await withSchema("plugin_purge_upgrade", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, upTo(221));
    await admin.query(
      `INSERT INTO ${schema}.system_settings (setting_key, value_json, updated_at) VALUES ($1, $2, $3)`,
      [PLUGIN_SETTING_KEY, PLUGIN_RECORDS_JSON, "2026-01-01T00:00:00.000Z"],
    );
    for (const row of OTHER_SETTINGS) {
      await admin.query(
        `INSERT INTO ${schema}.system_settings (setting_key, value_json, updated_at) VALUES ($1, $2, $3)`,
        [row.setting_key, row.value_json, row.updated_at],
      );
    }
    const before = await readSettings(admin, schema);
    assert.ok(before.some((row) => row.setting_key === PLUGIN_SETTING_KEY));

    const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    assert.deepEqual(migrated.appliedVersions, [222, 223, 224]);
    assert.equal(migrated.latestVersion, 224);

    const after = await readSettings(admin, schema);
    assert.equal(
      after.some((row) => row.setting_key === PLUGIN_SETTING_KEY),
      false,
    );
    assert.deepEqual(
      after,
      before.filter((row) => row.setting_key !== PLUGIN_SETTING_KEY),
    );

    // Re-running is a no-op.
    assert.deepEqual((await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS)).appliedVersions, []);
    assert.deepEqual(await readSettings(admin, schema), after);
  });
});

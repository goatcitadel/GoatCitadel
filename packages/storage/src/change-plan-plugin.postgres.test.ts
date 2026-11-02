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

/** The plan CHECKs this migration owns, plus any probe it failed to drop. */
async function planChecks(admin: Pool, schema: string): Promise<Array<{ conname: string; definition: string }>> {
  const result = await admin.query<{ conname: string; definition: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = $1::regclass AND contype = 'c'
       AND (conname IN ('change_plans_origin_surface_check', 'change_plans_kind_check') OR conname LIKE 'gc_plugin_install_%')
     ORDER BY conname`,
    [`${schema}.change_plans`],
  );
  return result.rows;
}

async function insertPlan(admin: Pool, schema: string, planId: string, surface: string, kind: string): Promise<void> {
  const now = "2026-10-31T00:00:00.000Z";
  await admin.query(
    `INSERT INTO ${schema}.change_plans (
       schema_version, plan_id, origin_surface, workspace_id, adapter_id, adapter_version, kind, scope, status, phase,
       revision, request_json, intent_hash, target_owner_id, target_resource_id, title, summary, impact, risk,
       approval_refs_json, evidence_refs_json, rollback_refs_json, created_at, updated_at
     ) VALUES (1, $1, $2, 'default', 'fixture', 1, $3, 'capability', 'awaiting_confirmation', 'confirmation',
       1, '{}', repeat('a', 64), 'fixture', $1, 'Fixture plan', 'Fixture summary', 'Fixture impact', 'caution',
       '[]', '[]', '[]', $4, $4)`,
    [planId, surface, kind, now],
  );
}

/** Both new kinds store, every older kind still stores, and anything else is refused. */
async function assertWidened(admin: Pool, schema: string): Promise<void> {
  await insertPlan(admin, schema, "plan-plugin-install", "capabilities", "plugin_install");
  await insertPlan(admin, schema, "plan-plugin-uninstall", "capabilities", "plugin_uninstall");
  await insertPlan(admin, schema, "plan-connector-after", "capabilities", "connector_install");
  await insertPlan(admin, schema, "plan-pack-after", "settings", "capability_pack");
  await assert.rejects(insertPlan(admin, schema, "plan-other-surface", "anywhere", "plugin_install"), /check/iu);
  await assert.rejects(insertPlan(admin, schema, "plan-other-kind", "capabilities", "plugin_remove"), /check/iu);
}

test("real PostgreSQL fresh installs accept plugin install and uninstall plans", { skip }, async () => {
  await withSchema("plan_plugin_fresh", async ({ admin, schema, migrations }) => {
    // The full registry (not a canonical prefix) runs the schema-shape gate.
    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    const checks = await planChecks(admin, schema);
    assert.deepEqual(
      checks.map((check) => check.conname),
      ["change_plans_kind_check", "change_plans_origin_surface_check"],
    );
    assert.match(checks[0]!.definition, /'connector_install'.*'plugin_install'.*'plugin_uninstall'/u);
    assert.match(checks[1]!.definition, /'system'.*'capabilities'/u);
    await assertWidened(admin, schema);
  });
});

test("real PostgreSQL upgraded installs keep their plans and match a fresh install", { skip }, async () => {
  let freshChecks: Array<{ conname: string; definition: string }> = [];
  await withSchema("plan_plugin_ref", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    freshChecks = await planChecks(admin, schema);
  });

  // An install already at the connector-install head (v222) gets the kind CHECK widened (v223), then the data-only
  // review-depth reset (v224), which leaves change_plans alone.
  await withSchema("plan_plugin_upgrade", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, upTo(222));
    await insertPlan(admin, schema, "plan-legacy-pack", "settings", "capability_pack");
    await insertPlan(admin, schema, "plan-legacy-connector", "capabilities", "connector_install");
    await assert.rejects(insertPlan(admin, schema, "plan-early", "capabilities", "plugin_install"), /check/iu);
    const before = await admin.query(`SELECT * FROM ${schema}.change_plans ORDER BY plan_id`);

    const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    assert.deepEqual(migrated.appliedVersions, [223, 224]);
    assert.equal(migrated.latestVersion, 224);
    assert.deepEqual(await planChecks(admin, schema), freshChecks);
    assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.change_plans ORDER BY plan_id`)).rows, before.rows);
    await assertWidened(admin, schema);

    // Re-running is a no-op.
    assert.deepEqual((await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS)).appliedVersions, []);
  });

  // An older install (v2 renders no CHECKs; v145 named the origin CHECK) reaches v220 and v223 in one run.
  await withSchema("plan_plugin_older", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, upTo(219));
    await admin.query(
      `ALTER TABLE ${schema}.change_plans ADD CONSTRAINT change_plans_origin_surface_check
         CHECK(origin_surface IN ('chat', 'settings', 'system'))`,
    );
    await insertPlan(admin, schema, "plan-legacy-pack", "settings", "capability_pack");
    await assert.rejects(insertPlan(admin, schema, "plan-early", "capabilities", "plugin_install"), /check/iu);
    const before = await admin.query(`SELECT * FROM ${schema}.change_plans ORDER BY plan_id`);

    const migrated = await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
    assert.deepEqual(migrated.appliedVersions, [220, 221, 222, 223, 224]);
    assert.equal(migrated.latestVersion, 224);
    assert.deepEqual(await planChecks(admin, schema), freshChecks);
    assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.change_plans ORDER BY plan_id`)).rows, before.rows);
    await assertWidened(admin, schema);
  });
});

test("real PostgreSQL refuses to widen a drifted plan kind CHECK", { skip }, async () => {
  await withSchema("plan_plugin_drift", async ({ admin, schema, migrations }) => {
    await runPostgresMigrations(migrations, upTo(222));
    await admin.query(`ALTER TABLE ${schema}.change_plans DROP CONSTRAINT change_plans_kind_check`);
    await admin.query(
      `ALTER TABLE ${schema}.change_plans ADD CONSTRAINT change_plans_kind_check
         CHECK(kind IN ('session_model', 'capability_pack', 'connector_install'))`,
    );

    await assert.rejects(runPostgresMigrations(migrations, POSTGRES_MIGRATIONS), /drifted plan kind constraint/u);
    // The migration rolls back whole: no probe left, the kind CHECK not widened.
    const checks = await planChecks(admin, schema);
    assert.deepEqual(
      checks.map((check) => check.conname),
      ["change_plans_kind_check", "change_plans_origin_surface_check"],
    );
    assert.doesNotMatch(checks[0]!.definition, /plugin_install/u);
  });
});

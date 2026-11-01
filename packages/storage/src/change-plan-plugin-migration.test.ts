import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "node:test";
import {
  createChangePlanSchema,
  upgradeChangePlanConnectorInstallSchema,
  upgradeChangePlanPackSchema,
  upgradeChangePlanPluginInstallSchema,
} from "./change-plan-schema.js";
import { ChangePlanRepository } from "./change-plan-repo.js";
import type { DatabaseClient } from "./db.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

const TABLES = ["change_plans", "change_plan_events", "change_plan_links"] as const;

function memoryClient(database: DatabaseSync): DatabaseClient {
  return {
    dialect: "sqlite",
    prepare: (sql: string) => database.prepare(sql),
    exec: (sql: string) => database.exec(sql),
    transaction: (_mode: string, callback: () => unknown) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  } as DatabaseClient;
}

function createSettingsPlan(repo: ChangePlanRepository) {
  return repo.create({
    origin: { surface: "settings", workspaceId: "default", actorId: "operator" },
    request: { kind: "installation_default_model", providerId: "openai", model: "model" },
    adapter: { adapterId: "model", version: 1 },
    target: { ownerId: "settings", resourceId: "default" },
    title: "Legacy review",
    summary: "Preserve exact ledger",
    impact: "Reviewed default",
    risk: "caution",
    status: "awaiting_confirmation",
    requiredAction: {
      kind: "confirmation",
      actionId: "review-action",
      actionNonce: "preserved-review-nonce",
      title: "Confirm",
      confirmationText: "Confirm selected model",
    },
    evidenceRefs: ["evidence:legacy"],
    approvalRefs: ["approval:legacy"],
    idempotencyKey: "legacy-request",
  });
}

/** Copies a stored plan row as `planId` with the given column values, as raw SQL. */
function insertPlanCopy(
  db: DatabaseClient,
  sourceId: string,
  planId: string,
  overrides: Record<string, string | null>,
): void {
  const source = db.prepare("SELECT * FROM change_plans WHERE plan_id = ?").get(sourceId) as Record<string, unknown>;
  const row = { ...source, plan_id: planId, idempotency_key: null, active_target_key: null, ...overrides };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO change_plans (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as Array<string | number | null>),
  );
}

it("accepts plugin install and uninstall plans and keeps every older plan", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const db = memoryClient(database);
  try {
    // An upgraded install reaches this migration with the v271 (connector install) ledger.
    createChangePlanSchema(db);
    db.transaction("immediate", () => upgradeChangePlanPackSchema(db));
    db.transaction("immediate", () => upgradeChangePlanConnectorInstallSchema(db));
    database.exec(
      "CREATE TABLE chat_change_plans (plan_id TEXT, session_id TEXT, status TEXT, expires_at TEXT, created_at TEXT)",
    );
    database.exec("CREATE TABLE chat_session_meta (session_id TEXT, workspace_id TEXT)");
    const repo = new ChangePlanRepository(db);
    const original = createSettingsPlan(repo);
    insertPlanCopy(db, original.planId, "plan-pack", { kind: "capability_pack" });
    insertPlanCopy(db, original.planId, "plan-connector", {
      origin_surface: "capabilities",
      kind: "connector_install",
    });
    const before = TABLES.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    assert.ok(before[0]!.length === 3, "the fixture holds a settings, a pack and a connector plan");
    assert.ok(before[1]!.length > 0, "the fixture plan has events to preserve");
    assert.ok(before[2]!.length > 0, "the fixture plan has links to preserve");
    for (const kind of ["plugin_install", "plugin_uninstall"]) {
      assert.throws(
        () => insertPlanCopy(db, original.planId, `plan-early-${kind}`, { origin_surface: "capabilities", kind }),
        /CHECK/u,
        `${kind} is refused before the migration`,
      );
    }

    db.transaction("immediate", () => upgradeChangePlanPluginInstallSchema(db));

    assert.deepEqual(
      TABLES.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      before,
    );
    assert.deepEqual(new ChangePlanRepository(db).get(original.planId), original);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'gc_%'").all(),
      [],
      "the migration drops its temporary copies",
    );
    assert.throws(
      () => database.prepare("DELETE FROM change_plan_events WHERE plan_id = ?").run(original.planId),
      /append-only/u,
    );
    assert.throws(
      () => database.prepare("UPDATE change_plan_links SET link_id = 'other' WHERE plan_id = ?").run(original.planId),
      /immutable/u,
    );

    for (const kind of ["plugin_install", "plugin_uninstall"]) {
      insertPlanCopy(db, original.planId, `plan-${kind}`, { origin_surface: "capabilities", kind });
      assert.deepEqual(
        { ...database.prepare("SELECT origin_surface, kind FROM change_plans WHERE plan_id = ?").get(`plan-${kind}`) },
        { origin_surface: "capabilities", kind },
      );
    }
    // Every older kind and origin still stores.
    insertPlanCopy(db, original.planId, "plan-pack-after", { kind: "capability_pack" });
    insertPlanCopy(db, original.planId, "plan-connector-after", {
      origin_surface: "capabilities",
      kind: "connector_install",
    });
    assert.throws(
      () =>
        database.prepare("UPDATE change_plans SET origin_surface = 'anywhere' WHERE plan_id = ?").run(original.planId),
      /CHECK/u,
    );
    assert.throws(
      () =>
        database.prepare("UPDATE change_plans SET kind = 'arbitrary_writer' WHERE plan_id = ?").run(original.planId),
      /CHECK/u,
    );
  } finally {
    database.close();
  }
});

it("reads a plugin install plan back through the repository on a migrated database", () => {
  const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-plugin-install-plan") });
  const repo = new ChangePlanRepository(db);
  const created = repo.create({
    origin: { surface: "capabilities", workspaceId: "default", actorId: "operator" },
    request: {
      kind: "plugin_install",
      inspectionId: "inspection-1",
      manifestSha256: "a".repeat(64),
      snapshotTreeSha256: "b".repeat(64),
      workspaceId: "default",
    },
    adapter: { adapterId: "plugin-install", version: 1 },
    target: { ownerId: "capability_plugins", resourceId: "acme-helper" },
    title: "Add Acme Helper",
    summary: "Plugin install",
    impact: "Adds the plugin's pieces",
    risk: "caution",
    status: "awaiting_confirmation",
    requiredAction: {
      kind: "confirmation",
      actionId: "install-action",
      actionNonce: "plugin-install-nonce",
      title: "Confirm",
      confirmationText: "Confirm the install",
    },
  });
  const removed = repo.create({
    origin: { surface: "capabilities", workspaceId: "default", actorId: "operator" },
    request: { kind: "plugin_uninstall", pluginId: "acme-helper", installPlanId: created.planId },
    adapter: { adapterId: "plugin-uninstall", version: 1 },
    target: { ownerId: "capability_plugins", resourceId: "acme-helper:remove" },
    title: "Remove Acme Helper",
    summary: "Plugin uninstall",
    impact: "Removes the plugin's pieces",
    risk: "caution",
    status: "awaiting_confirmation",
    requiredAction: {
      kind: "confirmation",
      actionId: "uninstall-action",
      actionNonce: "plugin-uninstall-nonce",
      title: "Confirm",
      confirmationText: "Confirm the removal",
    },
  });

  assert.equal(created.request.kind, "plugin_install");
  assert.equal(created.scope, "capability");
  assert.deepEqual(repo.get(created.planId), created);
  assert.equal(removed.request.kind, "plugin_uninstall");
  assert.deepEqual(repo.get(removed.planId), removed);
});

it("lets a migrated database store plugin install and uninstall rows and still refuse other kinds", () => {
  const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-plugin-plan-rows") });
  const original = createSettingsPlan(new ChangePlanRepository(db));

  for (const kind of ["plugin_install", "plugin_uninstall"]) {
    insertPlanCopy(db, original.planId, `plan-${kind}`, { origin_surface: "capabilities", kind });
    assert.deepEqual(
      { ...db.prepare("SELECT origin_surface, kind FROM change_plans WHERE plan_id = ?").get<object>(`plan-${kind}`) },
      { origin_surface: "capabilities", kind },
    );
  }
  assert.throws(
    () => insertPlanCopy(db, original.planId, "plan-other", { origin_surface: "capabilities", kind: "plugin_remove" }),
    /CHECK/u,
  );
});

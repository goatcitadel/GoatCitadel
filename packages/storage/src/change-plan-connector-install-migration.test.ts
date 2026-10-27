import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "node:test";
import {
  createChangePlanSchema,
  upgradeChangePlanConnectorInstallSchema,
  upgradeChangePlanPackSchema,
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

it("widens the origin surface and plan kind while preserving plans, events, links and immutable constraints", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const db = memoryClient(database);
  try {
    // An upgraded install reaches this migration with the v205 (capability pack) ledger.
    createChangePlanSchema(db);
    db.transaction("immediate", () => upgradeChangePlanPackSchema(db));
    database.exec(
      "CREATE TABLE chat_change_plans (plan_id TEXT, session_id TEXT, status TEXT, expires_at TEXT, created_at TEXT)",
    );
    database.exec("CREATE TABLE chat_session_meta (session_id TEXT, workspace_id TEXT)");
    const repo = new ChangePlanRepository(db);
    const original = createSettingsPlan(repo);
    insertPlanCopy(db, original.planId, "plan-pack", { kind: "capability_pack" });
    const before = TABLES.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    assert.ok(before[1]!.length > 0, "the fixture plan has events to preserve");
    assert.ok(before[2]!.length > 0, "the fixture plan has links to preserve");
    assert.throws(
      () => insertPlanCopy(db, original.planId, "plan-early", { origin_surface: "capabilities" }),
      /CHECK/u,
    );

    db.transaction("immediate", () => upgradeChangePlanConnectorInstallSchema(db));

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

    insertPlanCopy(db, original.planId, "plan-install", { origin_surface: "capabilities", kind: "connector_install" });
    assert.deepEqual(
      { ...database.prepare("SELECT origin_surface, kind FROM change_plans WHERE plan_id = ?").get("plan-install") },
      { origin_surface: "capabilities", kind: "connector_install" },
    );
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

it("lets a migrated database store a Capabilities connector install plan", () => {
  const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-connector-install-plan") });
  const original = createSettingsPlan(new ChangePlanRepository(db));

  insertPlanCopy(db, original.planId, "plan-install", { origin_surface: "capabilities", kind: "connector_install" });

  assert.deepEqual(
    { ...db.prepare("SELECT origin_surface, kind FROM change_plans WHERE plan_id = ?").get<object>("plan-install") },
    { origin_surface: "capabilities", kind: "connector_install" },
  );
  assert.throws(
    () => db.prepare("UPDATE change_plans SET origin_surface = 'anywhere' WHERE plan_id = ?").run(original.planId),
    /CHECK/u,
  );
});

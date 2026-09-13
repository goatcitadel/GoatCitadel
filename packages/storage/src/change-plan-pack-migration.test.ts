import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { createChangePlanSchema, upgradeChangePlanPackSchema } from "./change-plan-schema.js";
import { ChangePlanRepository } from "./change-plan-repo.js";
import type { DatabaseClient } from "./db.js";

it("widens legacy plan kinds while preserving plans, events, links and immutable constraints", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const db = {
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
  try {
    createChangePlanSchema(db);
    database.exec(
      "CREATE TABLE chat_change_plans (plan_id TEXT, session_id TEXT, status TEXT, expires_at TEXT, created_at TEXT)",
    );
    database.exec("CREATE TABLE chat_session_meta (session_id TEXT, workspace_id TEXT)");
    const repo = new ChangePlanRepository(db);
    const original = repo.create({
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
    const before = ["change_plans", "change_plan_events", "change_plan_links"].map((table) =>
      database.prepare(`SELECT * FROM ${table}`).all(),
    );
    db.transaction("immediate", () => upgradeChangePlanPackSchema(db));
    assert.deepEqual(
      ["change_plans", "change_plan_events", "change_plan_links"].map((table) =>
        database.prepare(`SELECT * FROM ${table}`).all(),
      ),
      before,
    );
    assert.deepEqual(new ChangePlanRepository(db).get(original.planId), original);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(
      () => database.prepare("DELETE FROM change_plan_events WHERE plan_id = ?").run(original.planId),
      /append-only/u,
    );
    database.prepare("UPDATE change_plans SET kind = 'capability_pack' WHERE plan_id = ?").run(original.planId);
    assert.throws(
      () =>
        database.prepare("UPDATE change_plans SET kind = 'arbitrary_writer' WHERE plan_id = ?").run(original.planId),
      /CHECK/u,
    );
  } finally {
    database.close();
  }
});

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { createChangePlanSchema } from "./change-plan-schema.js";
import { ChangePlanRepository } from "./change-plan-repo.js";
import { ChatChangePlanRepository } from "./chat-change-plan-repo.js";

const files: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const file of files.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
  }
});

function createRepo(): { database: DatabaseClient; repo: ChangePlanRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-evolution-plan-${randomUUID()}.db`);
  files.push(dbPath);
  const database = createDatabase({ dbPath });
  createChangePlanSchema(database);
  databases.push(database);
  return { database, repo: new ChangePlanRepository(database) };
}

function createModelPlan(repo: ChangePlanRepository, overrides: { idempotencyKey?: string; model?: string } = {}) {
  return repo.create({
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator-1" },
    request: { kind: "session_model", providerId: "openai", model: overrides.model ?? "gpt-5" },
    adapter: { adapterId: "model-selection", version: 1 },
    target: { ownerId: "chat_session_prefs", resourceId: "session-1", expectedRevision: 7 },
    title: "Use GPT-5 in this Chat",
    summary: "Switch this Chat to the selected model.",
    impact: "Only the current Chat changes.",
    risk: "safe",
    status: "awaiting_confirmation",
    requiredAction: {
      kind: "confirmation",
      actionId: "action-1",
      actionNonce: "nonce-that-must-be-consumed-once",
      title: "Confirm model",
      confirmationText: "Use GPT-5 only in this Chat.",
    },
    ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

describe("ChangePlanRepository", () => {
  it("enforces exact CAS and nonce-bound confirmation before releasing the target claim", () => {
    const { repo } = createRepo();
    const plan = createModelPlan(repo);

    assert.throws(
      () => repo.transition(plan.planId, { expectedRevision: 1, status: "applying", actionNonce: "wrong" }),
      (error: unknown) => error instanceof ConflictError,
    );
    assert.throws(
      () =>
        repo.transition(plan.planId, {
          expectedRevision: 1,
          status: "applying",
          actionNonce: "nonce-that-must-be-consumed-once",
          target: { ownerId: "different_owner", resourceId: "session-1", expectedRevision: 8 },
        }),
      (error: unknown) => error instanceof ConflictError,
    );
    const applying = repo.transition(plan.planId, {
      expectedRevision: 1,
      status: "applying",
      actionNonce: "nonce-that-must-be-consumed-once",
      requiredAction: null,
      target: { ...plan.target, expectedRevision: 8 },
      actorId: "operator-1",
    });
    assert.equal(applying.status, "applying");
    assert.equal(applying.target.expectedRevision, 8);
    assert.equal(applying.requiredAction, undefined);
    assert.throws(
      () =>
        repo.transition(plan.planId, {
          expectedRevision: 1,
          status: "applying",
          actionNonce: "nonce-that-must-be-consumed-once",
        }),
      (error: unknown) => error instanceof ConflictError,
    );
    const verifying = repo.transition(plan.planId, {
      expectedRevision: 2,
      status: "verifying",
      internal: true,
      evidenceRefs: ["owner:revision:8"],
    });
    const completed = repo.transition(plan.planId, {
      expectedRevision: verifying.revision,
      status: "completed",
      internal: true,
      result: { summary: "The model owner matches the approved plan." },
    });
    assert.equal(completed.status, "completed");
    assert.equal(repo.listActive().length, 0);
    assert.deepEqual(
      repo.listEvents(plan.planId).map((event) => event.toStatus),
      ["awaiting_confirmation", "applying", "verifying", "completed"],
    );
  });

  it("deduplicates exact idempotent creates and denies competing target claims", () => {
    const { repo } = createRepo();
    const first = createModelPlan(repo, { idempotencyKey: "turn-1:tool-1" });
    const replay = createModelPlan(repo, { idempotencyKey: "turn-1:tool-1" });
    assert.equal(replay.planId, first.planId);
    assert.throws(
      () => createModelPlan(repo, { idempotencyKey: "turn-2:tool-1" }),
      (error: unknown) => error instanceof ConflictError,
    );
    assert.throws(
      () => createModelPlan(repo, { idempotencyKey: "turn-1:tool-1", model: "gpt-5-mini" }),
      (error: unknown) => error instanceof ConflictError,
    );
    repo.transition(first.planId, {
      expectedRevision: first.revision,
      status: "cancelled",
      actionNonce: "nonce-that-must-be-consumed-once",
    });
    const next = createModelPlan(repo, { idempotencyKey: "turn-2:tool-1" });
    assert.notEqual(next.planId, first.planId);
  });

  it("keeps event and link evidence append-only", () => {
    const { database, repo } = createRepo();
    const plan = createModelPlan(repo);
    assert.throws(() =>
      database.exec(`UPDATE change_plan_events SET event_type = 'tampered' WHERE plan_id = '${plan.planId}'`),
    );
    assert.throws(() => database.exec(`DELETE FROM change_plan_links WHERE plan_id = '${plan.planId}'`));
  });

  it("backfills legacy pending plans as manual-required without replaying them", () => {
    const { database, repo } = createRepo();
    const legacy = new ChatChangePlanRepository(database).create({
      sessionId: "legacy-session",
      requesterActorId: "operator-1",
      request: { kind: "session_model", providerId: "openai", model: "gpt-5" },
      expectedTargetRevision: 3,
      expiresAt: "2099-01-01T00:00:00.000Z",
      title: "Legacy model plan",
      summary: "A pending plan from the Chat-only ledger.",
    });
    assert.equal(repo.backfillLegacyChatPlans(), 1);
    assert.equal(repo.backfillLegacyChatPlans(), 0);
    const imported = repo.get(legacy.planId);
    assert.equal(imported.status, "manual_required");
    assert.equal(imported.result?.failureCode, "legacy_backfill_requires_replan");
    assert.equal(imported.origin.workspaceId, "default");
    assert.equal(repo.listEvents(imported.planId)[0]?.eventType, "legacy_chat_plan_imported");
  });
});

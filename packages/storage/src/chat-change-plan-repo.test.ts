import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatChangePlanRepository } from "./chat-change-plan-repo.js";

const files: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const file of files.splice(0)) {
    // Windows can retain SQLite's journal handles briefly after close. The
    // temporary file is unique, so a best-effort cleanup keeps the lifecycle
    // assertion from becoming platform-dependent.
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
  }
});

function createRepo(): ChatChangePlanRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-change-plan-${randomUUID()}.db`);
  files.push(dbPath);
  const database = createDatabase({ dbPath });
  databases.push(database);
  return new ChatChangePlanRepository(database);
}

describe("ChatChangePlanRepository", () => {
  it("creates a durable plan and advances it only through a revision-fenced lifecycle", () => {
    const repo = createRepo();
    const plan = repo.create({
      sessionId: "session-1",
      requesterActorId: "operator-1",
      request: { kind: "session_model", providerId: "openai", model: "gpt-5", thinkingLevel: "extended" },
      expectedTargetRevision: 7,
      expiresAt: "2099-01-01T00:00:00.000Z",
      title: "Use GPT-5 in this chat",
      summary: "Switch this conversation only; the installation default stays unchanged.",
    });

    assert.equal(plan.status, "awaiting_confirmation");
    assert.equal(plan.scope, "current_chat");
    assert.equal(repo.listBySession("session-1").length, 1);

    const applying = repo.transition(plan.planId, { expectedRevision: plan.revision, status: "applying" });
    const applied = repo.transition(applying.planId, {
      expectedRevision: applying.revision,
      status: "applied",
      result: { summary: "Updated this chat to GPT-5.", appliedRevision: 8, evidenceRefs: ["chat_session:session-1"] },
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.revision, 3);
    assert.equal(applied.result?.appliedRevision, 8);
    assert.ok(applied.appliedAt);
    assert.equal(applied.expiresAt, "2099-01-01T00:00:00.000Z");
  });

  it("rejects stale confirmation and forbidden terminal transitions", () => {
    const repo = createRepo();
    const plan = repo.create({
      sessionId: "session-2",
      request: { kind: "installation_default_model", providerId: "openai", model: "gpt-5" },
      expectedTargetRevision: 4,
      expiresAt: "2099-01-01T00:00:00.000Z",
      title: "Make GPT-5 the default",
      summary: "New chats will use GPT-5 unless they choose another model.",
    });
    assert.throws(
      () => repo.transition(plan.planId, { expectedRevision: 9, status: "cancelled" }),
      (error: unknown) => error instanceof ConflictError,
    );
    const cancelled = repo.transition(plan.planId, { expectedRevision: plan.revision, status: "cancelled" });
    assert.throws(
      () => repo.transition(cancelled.planId, { expectedRevision: cancelled.revision, status: "applying" }),
      /cannot transition/,
    );
  });
});

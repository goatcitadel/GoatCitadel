import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { buildPostgresRuntimeSchemaSql } from "./postgres/runtime-schema.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): PendingApprovalActionRepository {
  return createRepoWithDb().repo;
}

function createRepoWithDb(): { repo: PendingApprovalActionRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-pending-approval-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { repo: new PendingApprovalActionRepository(db), db };
}

describe("PendingApprovalActionRepository", () => {
  it("tracks pending to executed lifecycle", () => {
    const repo = createRepo();
    repo.upsertPending({
      approvalId: "ap-1",
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      expiresAt: "2026-03-21T00:15:00.000Z",
    });

    const pending = repo.find("ap-1");
    assert.equal(pending?.resolutionStatus, "pending");
    assert.equal(pending?.expiresAt, "2026-03-21T00:15:00.000Z");

    const resolved = repo.markResolved("ap-1", "executed", { ok: true });
    assert.equal(resolved.resolutionStatus, "executed");
    assert.equal(resolved.result?.ok, true);

    const secondResolve = repo.markResolved("ap-1", "failed", { ok: false });
    assert.equal(secondResolve.resolutionStatus, "executed");
    assert.equal(secondResolve.result?.ok, true);
  });

  it("creates the SQLite expiry column", () => {
    const { db } = createRepoWithDb();
    const columns = db.prepare("PRAGMA table_info(pending_approval_actions)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "expires_at"));
  });

  it("keeps Postgres runtime schema and migrations aligned for expiry and trace index", () => {
    const runtimeSql = buildPostgresRuntimeSchemaSql();
    const latestMigrationSql = POSTGRES_MIGRATIONS.at(-1)?.sql ?? "";

    assert.match(runtimeSql, /expires_at TEXT/);
    assert.match(runtimeSql, /idx_chat_turn_traces_session_status/);
    assert.match(latestMigrationSql, /ADD COLUMN IF NOT EXISTS expires_at TEXT/);
    assert.match(latestMigrationSql, /idx_chat_turn_traces_session_status/);
  });
});

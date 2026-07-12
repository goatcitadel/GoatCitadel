import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";
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

  it("reclassifies only the matching executed result as failed domain truth", () => {
    const repo = createRepo();
    repo.upsertPending({
      approvalId: "ap-domain-failure",
      actionType: "tool.invoke",
      request: { toolName: "http.post" },
    });
    const executedResult = {
      outcome: "executed",
      policyReason: "execution outcome unknown",
      result: { status: "failed", externalOutcome: "unknown_after_send" },
    };
    repo.markResolved("ap-domain-failure", "executed", executedResult);

    const corrected = repo.reclassifyExecutedAsFailed("ap-domain-failure", executedResult, {
      ...executedResult,
      failureKind: "manual_reconciliation",
    });

    assert.equal(corrected.resolutionStatus, "failed");
    assert.equal(corrected.result?.failureKind, "manual_reconciliation");
    const replay = repo.reclassifyExecutedAsFailed("ap-domain-failure", executedResult, {
      ...executedResult,
      failureKind: "manual_reconciliation",
    });
    assert.equal(replay.resolutionStatus, "failed");
  });

  it("does not reopen or overwrite a terminal action during a stale pending refresh", () => {
    const repo = createRepo();
    repo.upsertPending({
      approvalId: "ap-terminal-refresh",
      actionType: "tool.invoke",
      request: { toolName: "plugin.send", args: { before: true } },
      createdAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-10T00:10:00.000Z",
    });
    const resolved = repo.markResolved("ap-terminal-refresh", "executed", {
      outcome: "executed",
      auditEventId: "audit-terminal",
    });

    const refreshed = repo.upsertPending({
      approvalId: "ap-terminal-refresh",
      actionType: "tool.invoke",
      request: { toolName: "plugin.send", args: { after: true } },
      createdAt: "2026-07-10T00:01:00.000Z",
      expiresAt: "2026-07-10T00:20:00.000Z",
    });

    assert.equal(refreshed.resolutionStatus, "executed");
    assert.equal(refreshed.resolvedAt, resolved.resolvedAt);
    assert.deepEqual(refreshed.result, { outcome: "executed", auditEventId: "audit-terminal" });
    assert.deepEqual(refreshed.request, { toolName: "plugin.send", args: { before: true } });
    assert.equal(refreshed.createdAt, "2026-07-10T00:00:00.000Z");
    assert.equal(refreshed.expiresAt, "2026-07-10T00:10:00.000Z");
  });

  it("finds only database-fresh pending actions regardless of host-clock skew", () => {
    const { repo, db } = createRepoWithDb();
    const databaseNow = Date.now();
    repo.upsertPending({
      approvalId: "ap-fresh-explicit",
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      createdAt: new Date(databaseNow).toISOString(),
      expiresAt: new Date(databaseNow + 60_000).toISOString(),
    });
    repo.upsertPending({
      approvalId: "ap-expired-explicit",
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      createdAt: new Date(databaseNow - 120_000).toISOString(),
      expiresAt: new Date(databaseNow - 60_000).toISOString(),
    });
    repo.upsertPending({
      approvalId: "ap-fresh-legacy",
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      createdAt: new Date(databaseNow - 60_000).toISOString(),
    });
    repo.upsertPending({
      approvalId: "ap-expired-legacy",
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      createdAt: new Date(databaseNow - 20 * 60_000).toISOString(),
    });
    repo.upsertPending({
      approvalId: "ap-malformed-expiry",
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      createdAt: new Date(databaseNow).toISOString(),
      expiresAt: new Date(databaseNow + 120_000).toISOString(),
    });
    db.prepare("UPDATE pending_approval_actions SET expires_at = 'not-a-timestamp' WHERE approval_id = ?").run(
      "ap-malformed-expiry",
    );
    repo.upsertPending({
      approvalId: "ap-resolved",
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
      createdAt: new Date(databaseNow).toISOString(),
      expiresAt: new Date(databaseNow + 120_000).toISOString(),
    });
    repo.markResolved("ap-resolved", "executed");
    const originalDateNow = Date.now;

    try {
      for (const skewedNow of [0, Date.parse("2099-01-01T00:00:00.000Z")]) {
        Date.now = () => skewedNow;
        assert.equal(repo.findFreshPending("ap-fresh-explicit", 15 * 60_000)?.approvalId, "ap-fresh-explicit");
        assert.equal(repo.findFreshPending("ap-fresh-legacy", 15 * 60_000)?.approvalId, "ap-fresh-legacy");
        assert.equal(repo.findFreshPending("ap-expired-explicit", 15 * 60_000), undefined);
        assert.equal(repo.findFreshPending("ap-expired-legacy", 15 * 60_000), undefined);
        assert.equal(repo.findFreshPending("ap-malformed-expiry", 15 * 60_000), undefined);
        assert.equal(repo.findFreshPending("ap-resolved", 15 * 60_000), undefined);
      }
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("creates the SQLite expiry column", () => {
    const { db } = createRepoWithDb();
    const columns = db.prepare("PRAGMA table_info(pending_approval_actions)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "expires_at"));
  });

  it("keeps Postgres runtime schema and migrations aligned for expiry and trace index", () => {
    const runtimeSql = buildPostgresRuntimeSchemaSql();
    const migrationSql =
      POSTGRES_MIGRATIONS.find(
        (migration) => migration.name === "pending_approval_action_expiry_and_trace_index_parity",
      )?.sql ?? "";

    assert.match(runtimeSql, /expires_at TEXT/);
    assert.match(runtimeSql, /idx_chat_turn_traces_session_status/);
    assert.match(migrationSql, /ADD COLUMN IF NOT EXISTS expires_at TEXT/);
    assert.match(migrationSql, /idx_chat_turn_traces_session_status/);
  });
});

describe("PendingApprovalActionRepository sanitization", () => {
  it("quarantines a row whose request_json is malformed and falls back to empty request", () => {
    const dbPath = path.join(os.tmpdir(), `gc-paa-request-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new PendingApprovalActionRepository(db, { quarantine });

    const action = repo.upsertPending({
      approvalId: `ap-sanitize-req-${randomUUID()}`,
      actionType: "tool.invoke",
      request: { toolName: "fs.write" },
    });

    db.prepare("UPDATE pending_approval_actions SET request_json = ? WHERE approval_id = ?").run(
      "{not json",
      action.approvalId,
    );

    const reloaded = repo.find(action.approvalId);
    assert.ok(reloaded);
    assert.deepEqual(reloaded.request, {});
    assert.equal(quarantine.count(), 1);
    const entry0 = quarantine.list(10)[0];
    assert.ok(entry0);
    assert.equal(entry0.store, "pending_approval_action.request");
    assert.equal(entry0.rowId, action.approvalId);
  });

  it("quarantines a row whose result_json is malformed and falls back to empty result", () => {
    const dbPath = path.join(os.tmpdir(), `gc-paa-result-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new PendingApprovalActionRepository(db, { quarantine });

    const action = repo.upsertPending({
      approvalId: `ap-sanitize-res-${randomUUID()}`,
      actionType: "tool.invoke",
      request: { toolName: "fs.read" },
    });
    repo.markResolved(action.approvalId, "executed", { ok: true });

    db.prepare("UPDATE pending_approval_actions SET result_json = ? WHERE approval_id = ?").run(
      "{bad",
      action.approvalId,
    );

    const reloaded = repo.find(action.approvalId);
    assert.ok(reloaded);
    assert.deepEqual(reloaded.result, {});
    assert.equal(quarantine.count(), 1);
    const entry0 = quarantine.list(10)[0];
    assert.ok(entry0);
    assert.equal(entry0.store, "pending_approval_action.result");
    assert.equal(entry0.rowId, action.approvalId);
  });
});

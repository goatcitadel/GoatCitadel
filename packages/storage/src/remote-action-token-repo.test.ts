import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { RemoteActionTokenRepository } from "./remote-action-token-repo.js";
import type { DatabaseClient, DbStatement, DbTransactionMode } from "./db.js";

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

function createRepo(): RemoteActionTokenRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-remote-action-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new RemoteActionTokenRepository(db);
}

describe("RemoteActionTokenRepository", () => {
  it("creates and finds tokens by hash", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-1",
      actionType: "approval.resolve",
      approvalId: "apr-1",
      connectorId: "mission-control",
      mutation: { approvalId: "apr-1" },
      expiresAt: "2026-03-21T00:00:00.000Z",
    });

    const found = repo.findByTokenHash("hash-1");
    assert.ok(found);
    assert.equal(found?.tokenId, created.tokenId);
    assert.equal(found?.approvalId, "apr-1");
    assert.deepEqual(found?.mutation, { approvalId: "apr-1" });
  });

  it("updates token state and consumption metadata", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-2",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-21T00:00:00.000Z",
    });

    const consumed = repo.updateState(created.tokenId, "consumed", {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:mission-control",
    });

    assert.equal(consumed.state, "consumed");
    assert.equal(consumed.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(consumed.consumedBy, "connector:mission-control");
    const expired = repo.updateState(created.tokenId, "expired");
    assert.equal(expired.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(expired.consumedBy, "connector:mission-control");
  });

  it("atomically consumes pending tokens once and preserves the first consumer", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-atomic",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2099-03-21T00:00:00.000Z",
    });

    const first = repo.consumePending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:first",
    });
    const second = repo.consumePending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:01.000Z",
      consumedBy: "connector:second",
    });

    assert.equal(first?.state, "consumed");
    assert.equal(second, undefined);
    const persisted = repo.get(created.tokenId);
    assert.equal(persisted.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(persisted.consumedBy, "connector:first");
  });

  it("binds the first claim fingerprint and resumes only an identical claim", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-resumable",
      actionType: "approval.resolve",
      approvalId: "apr-resumable",
      connectorId: "mission-control",
      mutation: { approvalId: "apr-resumable", decisionHint: "approve" },
      expiresAt: "2099-03-21T00:00:00.000Z",
    });

    const first = repo.claimPending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:first",
      claimFingerprint: "sha256:request-a",
    });
    const resumed = repo.claimPending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:01.000Z",
      consumedBy: "connector:retry",
      claimFingerprint: "sha256:request-a",
    });
    const mismatch = repo.claimPending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:02.000Z",
      consumedBy: "connector:attacker",
      claimFingerprint: "sha256:request-b",
    });

    assert.equal(first.outcome, "claimed");
    assert.equal(resumed.outcome, "resumed");
    assert.equal(mismatch.outcome, "fingerprint_mismatch");
    assert.equal(first.record?.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(resumed.record?.consumedAt, "2026-03-20T10:00:00.000Z");
    assert.equal(resumed.record?.consumedBy, "connector:first");
    assert.equal(repo.readClaimFingerprint(resumed.record), "sha256:request-a");
    assert.deepEqual(resumed.record?.mutation, {
      approvalId: "apr-resumable",
      decisionHint: "approve",
      __remoteActionClaimFingerprint: "sha256:request-a",
    });
  });

  it("keeps a request claim single-winner when competing fingerprints race", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-race",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2099-03-21T00:00:00.000Z",
    });

    const first = repo.claimPending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:first",
      claimFingerprint: "sha256:first",
    });
    const competitor = repo.claimPending(created.tokenId, {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:second",
      claimFingerprint: "sha256:second",
    });

    assert.equal(first.outcome, "claimed");
    assert.equal(competitor.outcome, "fingerprint_mismatch");
    const persisted = repo.get(created.tokenId);
    assert.equal(repo.readClaimFingerprint(persisted), "sha256:first");
    assert.equal(persisted.consumedBy, "connector:first");
  });

  it("rejects empty claim fingerprints without changing pending state", () => {
    const repo = createRepo();
    const created = repo.create({
      tokenHash: "hash-empty-claim",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-21T00:00:00.000Z",
    });

    assert.throws(
      () =>
        repo.claimPending(created.tokenId, {
          consumedAt: "2026-03-20T10:00:00.000Z",
          consumedBy: "connector:first",
          claimFingerprint: "   ",
        }),
      /claimFingerprint is required/,
    );
    assert.equal(repo.get(created.tokenId).state, "pending");
  });

  it("expires only pending tokens and cannot overwrite a concurrent claim", () => {
    const repo = createRepo();
    const pending = repo.create({
      tokenHash: "hash-expire-pending",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-20T09:59:59.000Z",
    });
    const claimed = repo.create({
      tokenHash: "hash-expire-claimed",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2099-03-20T10:00:01.000Z",
    });
    repo.claimPending(claimed.tokenId, {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:first",
      claimFingerprint: "sha256:first",
    });

    assert.equal(repo.expirePending(pending.tokenId)?.state, "expired");
    assert.equal(repo.expirePending(claimed.tokenId), undefined);
    assert.equal(repo.get(claimed.tokenId).state, "consumed");
    assert.equal(repo.readClaimFingerprint(repo.get(claimed.tokenId)), "sha256:first");
  });

  it("lists every token for an approval and expires only its pending tokens", () => {
    const repo = createRepo();
    const approvalId = "apr-many-tokens";
    const pendingA = repo.create({
      tokenHash: "hash-many-a",
      actionType: "approval.resolve",
      approvalId,
      connectorId: "integration:a",
      expiresAt: "2099-03-21T00:00:00.000Z",
    });
    const consumed = repo.create({
      tokenHash: "hash-many-consumed",
      actionType: "approval.resolve",
      approvalId,
      connectorId: "integration:b",
      expiresAt: "2099-03-21T00:00:00.000Z",
    });
    const pendingB = repo.create({
      tokenHash: "hash-many-b",
      actionType: "approval.resolve",
      approvalId,
      connectorId: "mcp:server-1",
      expiresAt: "2099-03-21T00:00:00.000Z",
    });
    repo.create({
      tokenHash: "hash-other-approval",
      actionType: "approval.resolve",
      approvalId: "apr-other",
      connectorId: "integration:other",
      expiresAt: "2099-03-21T00:00:00.000Z",
    });
    repo.claimPending(consumed.tokenId, {
      consumedAt: "2026-03-20T10:00:00.000Z",
      consumedBy: "connector:integration:b",
      claimFingerprint: "sha256:winner",
    });

    const listed = (repo as unknown as { listByApprovalId(id: string): Array<{ tokenId: string }> }).listByApprovalId(
      approvalId,
    );
    assert.deepEqual(
      new Set(listed.map((token) => token.tokenId)),
      new Set([pendingA.tokenId, consumed.tokenId, pendingB.tokenId]),
    );
    assert.equal(
      (repo as unknown as { expirePendingByApprovalId(id: string): number }).expirePendingByApprovalId(approvalId),
      2,
    );
    assert.equal(repo.get(pendingA.tokenId).state, "expired");
    assert.equal(repo.get(pendingB.tokenId).state, "expired");
    assert.equal(repo.get(consumed.tokenId).state, "consumed");
  });

  it("does not consume a token at or beyond its expiry boundary", () => {
    const repo = createRepo();
    const resumable = repo.create({
      tokenHash: "hash-expiry-boundary-resumable",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-20T10:00:00.000Z",
    });
    const legacy = repo.create({
      tokenHash: "hash-expiry-boundary-legacy",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-20T10:00:00.000Z",
    });

    assert.equal(
      repo.claimPending(resumable.tokenId, {
        consumedAt: "2026-03-20T10:00:00.000Z",
        consumedBy: "connector:first",
        claimFingerprint: "sha256:first",
      }).outcome,
      "unavailable",
    );
    assert.equal(
      repo.consumePending(legacy.tokenId, {
        consumedAt: "2026-03-20T10:00:00.000Z",
        consumedBy: "connector:first",
      }),
      undefined,
    );
    assert.equal(repo.expirePendingAtOrBefore(resumable.tokenId, "2026-03-20T10:00:00.000Z").state, "expired");
    assert.equal(repo.expirePendingAtOrBefore(legacy.tokenId, "2026-03-20T10:00:00.000Z").state, "expired");
  });

  it("lists bounded pending expiry candidates without returning terminal tokens", () => {
    const repo = createRepo();
    const first = repo.create({
      tokenHash: "hash-expiry-sweep-first",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-20T09:00:00.000Z",
    });
    const second = repo.create({
      tokenHash: "hash-expiry-sweep-second",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2026-03-20T09:30:00.000Z",
    });
    const future = repo.create({
      tokenHash: "hash-expiry-sweep-future",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt: "2099-03-20T09:00:00.000Z",
    });
    repo.updateState(first.tokenId, "consumed", {
      consumedAt: "2026-03-20T08:30:00.000Z",
      consumedBy: "connector:mission-control",
    });

    assert.deepEqual(
      repo.listPendingExpiredAtOrBefore("2026-03-20T10:00:00.000Z", 10).map((token) => token.tokenId),
      [second.tokenId],
    );
    assert.equal(repo.get(future.tokenId).state, "pending");
    assert.throws(() => repo.listPendingExpiredAtOrBefore("not-a-date"), /valid timestamp/);
  });

  it("does not let a stale caller timestamp cross the database-clock expiry boundary", () => {
    const repo = createRepo();
    const now = Date.now();
    const expiresAt = new Date(now - 1_000).toISOString();
    const staleConsumedAt = new Date(now - 2_000).toISOString();
    const resumable = repo.create({
      tokenHash: "hash-stale-db-clock-resumable",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt,
    });
    const legacy = repo.create({
      tokenHash: "hash-stale-db-clock-legacy",
      actionType: "approval.resolve",
      connectorId: "mission-control",
      expiresAt,
    });

    assert.equal(
      repo.claimPending(resumable.tokenId, {
        consumedAt: staleConsumedAt,
        consumedBy: "connector:first",
        claimFingerprint: "sha256:first",
      }).outcome,
      "unavailable",
    );
    assert.equal(
      repo.consumePending(legacy.tokenId, {
        consumedAt: staleConsumedAt,
        consumedBy: "connector:first",
      }),
      undefined,
    );
  });

  it("uses a volatile database-clock expiry fence for PostgreSQL token claims", () => {
    const db = new RecordingDatabase("postgres");
    new RemoteActionTokenRepository(db);
    const claimStatements = db.statements.filter((sql) => sql.includes("UPDATE remote_action_tokens"));

    assert.equal(claimStatements.length >= 2, true);
    assert.equal(
      claimStatements
        .filter((sql) => sql.includes("state = 'consumed'"))
        .every((sql) => /gc_try_parse_timestamptz\(expires_at\) > clock_timestamp\(\)/.test(sql)),
      true,
    );
  });

  it("validates required token fields and reports missing reads", () => {
    const repo = createRepo();

    assert.throws(
      () =>
        repo.create({
          tokenHash: "   ",
          actionType: "approval.resolve",
          connectorId: "mission-control",
          expiresAt: "2026-03-21T00:00:00.000Z",
        }),
      /tokenHash is required/,
    );
    assert.throws(
      () =>
        repo.create({
          tokenHash: "hash-missing-connector",
          actionType: "approval.resolve",
          connectorId: "   ",
          expiresAt: "2026-03-21T00:00:00.000Z",
        }),
      /connectorId is required/,
    );
    assert.throws(() => repo.get("missing-token"), /Remote action token missing-token not found/);
    assert.throws(() => repo.updateState("missing-token", "consumed"), /Remote action token missing-token not found/);
  });
});

class RecordingDatabase implements DatabaseClient {
  public readonly statements: string[] = [];

  public constructor(public readonly dialect: DatabaseClient["dialect"]) {}

  public prepare(sql: string): DbStatement {
    this.statements.push(sql);
    return {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
  }

  public exec(): void {}

  public close(): void {}

  public transaction<T>(_mode: DbTransactionMode, callback: () => T): T {
    return callback();
  }
}

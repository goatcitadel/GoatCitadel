import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { MutationIdempotencyRepository } from "./mutation-idempotency-repo.js";

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

function createRepo(): MutationIdempotencyRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-mutation-idempotency-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new MutationIdempotencyRepository(db);
}

function createRepoWithDatabaseClock(nowIso: string): {
  repo: MutationIdempotencyRepository;
  getClockReads: () => number;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-mutation-idempotency-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  let clockReads = 0;
  const clockStatement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: <T = unknown>() => {
      clockReads += 1;
      return { now_iso: nowIso } as T;
    },
    all: () => [],
  };
  const clockedDb: DatabaseClient = {
    dialect: db.dialect,
    prepare(sql) {
      return sql.includes("strftime(") && sql.includes("AS now_iso") ? clockStatement : db.prepare(sql);
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
    transaction(mode, callback) {
      return db.transaction(mode, callback);
    },
  };
  return {
    repo: new MutationIdempotencyRepository(clockedDb),
    getClockReads: () => clockReads,
  };
}

describe("MutationIdempotencyRepository", () => {
  it("claims new mutations, blocks duplicates, and allows retries after failure", () => {
    const repo = createRepo();
    const input = {
      method: "POST",
      routePath: "/api/v1/tools/invoke",
      idempotencyKey: "idem-1",
      actorScope: "operator:test",
      payloadHash: "hash-1",
      now: "2026-04-19T00:00:00.000Z",
    };

    const claimed = repo.claim(input);
    assert.equal(claimed.outcome, "claimed");
    assert.equal(claimed.claimKind, "new");
    assert.equal(claimed.record.status, "pending");

    const inProgress = repo.claim(input);
    assert.equal(inProgress.outcome, "in_progress");

    repo.markCompleted(input);
    const duplicate = repo.claim(input);
    assert.equal(duplicate.outcome, "duplicate");

    repo.markFailed(input);
    const retried = repo.claim({
      ...input,
      now: "2026-04-19T00:00:10.000Z",
    });
    assert.equal(retried.outcome, "claimed");
    assert.equal(retried.claimKind, "retry_after_failure");
    assert.equal(retried.record.status, "pending");
  });

  it("rejects reused keys when the payload hash changes", () => {
    const repo = createRepo();
    const input = {
      method: "PATCH",
      routePath: "/api/v1/approvals/apr-1/resolve",
      idempotencyKey: "idem-2",
      actorScope: "",
      payloadHash: "hash-a",
      now: "2026-04-19T00:00:00.000Z",
    };

    assert.equal(repo.claim(input).outcome, "claimed");
    const mismatch = repo.claim({
      ...input,
      payloadHash: "hash-b",
      now: "2026-04-19T00:00:01.000Z",
    });

    assert.equal(mismatch.outcome, "payload_mismatch");
    assert.equal(mismatch.record.payloadHash, "hash-a");
  });

  it("discards only the owned pending generation", () => {
    const repo = createRepo();
    const identity = {
      method: "POST",
      routePath: "external_side_effect:integration_operator_action",
      idempotencyKey: "idem-discard-pending",
      actorScope: "operator:test",
      payloadHash: "hash-discard",
      now: "2026-04-19T00:00:00.000Z",
    };
    const claimed = repo.claim(identity);
    assert.equal(claimed.outcome, "claimed");
    assert.ok(claimed.record.claimToken);

    assert.equal(
      repo.discardPending({
        ...identity,
        claimToken: "wrong-generation",
      }),
      false,
    );
    assert.equal(repo.get(identity)?.status, "pending");
    assert.equal(
      repo.discardPending({
        ...identity,
        claimToken: claimed.record.claimToken,
      }),
      true,
    );
    assert.equal(repo.get(identity), undefined);

    const replacement = repo.claim({ ...identity, now: "2026-04-19T00:00:01.000Z" });
    assert.equal(replacement.outcome, "claimed");
    assert.equal(
      repo.markCompleted({
        ...identity,
        claimToken: replacement.record.claimToken,
      }),
      true,
    );
    assert.equal(
      repo.discardPending({
        ...identity,
        claimToken: replacement.record.claimToken!,
      }),
      false,
    );
    assert.equal(repo.get(identity)?.status, "completed");
  });

  it("rejects an active claim but reclaims a crash-stale claim with a new generation token", () => {
    const repo = createRepo();
    const input = {
      method: "POST",
      routePath: "/api/v1/chat/sessions/:sessionId/agent-send/stream",
      idempotencyKey: "idem-stale-claim",
      actorScope: "operator:test",
      payloadHash: "hash-stale",
      leaseDurationMs: 1_000,
    };

    const original = repo.claim({ ...input, now: "2026-07-11T12:00:00.000Z" });
    assert.equal(original.outcome, "claimed");
    assert.ok(original.record.claimToken);
    assert.equal(original.record.claimExpiresAt, "2026-07-11T12:00:01.000Z");

    const active = repo.claim({ ...input, now: "2026-07-11T12:00:00.999Z" });
    assert.equal(active.outcome, "in_progress");

    const reclaimed = repo.claim({ ...input, now: "2026-07-11T12:00:01.001Z" });
    assert.equal(reclaimed.outcome, "claimed");
    assert.equal(reclaimed.claimKind, "retry_after_stale_claim");
    assert.notEqual(reclaimed.record.claimToken, original.record.claimToken);
    assert.equal(reclaimed.record.claimExpiresAt, "2026-07-11T12:00:02.001Z");
  });

  it("uses the database clock for production lease acquisition instead of the host clock", () => {
    const { repo, getClockReads } = createRepoWithDatabaseClock("2035-08-09T10:11:12.345Z");
    const claimed = repo.claim({
      method: "POST",
      routePath: "/api/v1/chat/sessions/:sessionId/agent-send/stream",
      idempotencyKey: "idem-database-clock",
      actorScope: "operator:test",
      payloadHash: "hash-database-clock",
      leaseDurationMs: 1_000,
    });

    assert.equal(claimed.outcome, "claimed");
    assert.equal(claimed.record.createdAt, "2035-08-09T10:11:12.345Z");
    assert.equal(claimed.record.claimExpiresAt, "2035-08-09T10:11:13.345Z");
    assert.equal(getClockReads(), 1);
  });

  it("rejects stale-owner completion while allowing the winning owner to complete idempotently", () => {
    const repo = createRepo();
    const identity = {
      method: "POST",
      routePath: "/api/v1/chat/sessions/:sessionId/agent-send/stream",
      idempotencyKey: "idem-generation-fence",
      actorScope: "operator:test",
    };
    const original = repo.claim({
      ...identity,
      payloadHash: "hash-generation",
      now: "2026-07-11T12:00:00.000Z",
      leaseDurationMs: 1_000,
    });
    assert.equal(original.outcome, "claimed");
    const winner = repo.claim({
      ...identity,
      payloadHash: "hash-generation",
      now: "2026-07-11T12:00:02.000Z",
      leaseDurationMs: 1_000,
    });
    assert.equal(winner.outcome, "claimed");

    assert.equal(repo.markFailed({ ...identity, claimToken: original.record.claimToken }), false);
    assert.equal(repo.get(identity)?.status, "pending");
    assert.equal(repo.markCompleted({ ...identity, claimToken: original.record.claimToken }), false);
    assert.equal(repo.get(identity)?.status, "pending");
    assert.equal(repo.markCompleted({ ...identity, claimToken: winner.record.claimToken }), true);
    assert.equal(repo.markCompleted({ ...identity, claimToken: winner.record.claimToken }), true);
    assert.equal(repo.get(identity)?.status, "completed");
  });

  it("does not time-reclaim callers that did not opt into generation-fenced leases", () => {
    const repo = createRepo();
    const input = {
      method: "POST",
      routePath: "external_side_effect:channel.send",
      idempotencyKey: "external-send-1",
      actorScope: "workspace-1",
      payloadHash: "external-hash",
    };

    assert.equal(repo.claim({ ...input, now: "2026-07-11T12:00:00.000Z" }).outcome, "claimed");
    assert.equal(repo.claim({ ...input, now: "2027-07-11T12:00:00.000Z" }).outcome, "in_progress");
  });
});

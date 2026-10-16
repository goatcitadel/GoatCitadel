import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseClient, DbStatement } from "./db.js";
import { MutationIdempotencyRepository } from "./mutation-idempotency-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): MutationIdempotencyRepository {
  const dbPath = tempDbs.path("goatcitadel-mutation-idempotency");
  const db = tempDbs.open({ dbPath });
  return new MutationIdempotencyRepository(db);
}

function createRepoWithDatabaseClock(nowIso: string): {
  repo: MutationIdempotencyRepository;
  getClockReads: () => number;
} {
  const dbPath = tempDbs.path("goatcitadel-mutation-idempotency");
  const db = tempDbs.open({ dbPath });
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

  it("migrates mutation_idempotency with a nullable dispatched_at fence column", () => {
    const db = tempDbs.open({ dbPath: tempDbs.path("goatcitadel-mutation-idempotency") });
    const columns = db.prepare("PRAGMA table_info(mutation_idempotency)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const dispatchedAt = columns.find((column) => column.name === "dispatched_at");
    assert.ok(dispatchedAt, "dispatched_at column must exist after migration");
    assert.equal(dispatchedAt.type, "TEXT");
    assert.equal(dispatchedAt.notnull, 0);
  });

  it("refuses redispatch of a stale claim that crossed the dispatch boundary", () => {
    const repo = createRepo();
    const identity = {
      method: "POST",
      routePath: "external_side_effect:x",
      idempotencyKey: "k-sent",
      actorScope: "s",
      payloadHash: "h",
      leaseDurationMs: 1_000,
    };
    const first = repo.claim({ ...identity, now: "2026-10-16T00:00:00.000Z" });
    assert.equal(first.outcome, "claimed");
    const marked = repo.markDispatched({
      ...identity,
      claimToken: first.record.claimToken!,
      now: "2026-10-16T00:00:00.100Z",
    });
    assert.equal(marked.outcome, "dispatched");
    assert.ok(marked.outcome === "dispatched" && marked.record.dispatchedAt);
    assert.notEqual(marked.outcome === "dispatched" ? marked.record.claimToken : undefined, first.record.claimToken);
    assert.equal(
      marked.outcome === "dispatched" ? marked.record.claimExpiresAt : undefined,
      "2026-10-16T00:00:01.100Z",
    );
    const takeover = repo.claim({ ...identity, now: "2026-10-16T00:00:05.000Z" });
    assert.equal(takeover.outcome, "unknown_after_send");
    assert.equal(repo.get(identity)?.status, "unknown_after_send");
    assert.equal(repo.get(identity)?.claimExpiresAt, undefined);
    assert.equal(repo.claim({ ...identity, now: "2026-10-16T00:10:00.000Z" }).outcome, "unknown_after_send");
    const heldToken = marked.outcome === "dispatched" ? marked.record.claimToken! : "";
    assert.equal(repo.markCompleted({ ...identity, claimToken: heldToken }), false);
    assert.equal(repo.markFailed({ ...identity, claimToken: heldToken }), false);
    assert.equal(repo.get(identity)?.status, "unknown_after_send");
  });

  it("takes over an unmarked stale claim and fences the old holder at the boundary", () => {
    const repo = createRepo();
    const identity = {
      method: "POST",
      routePath: "external_side_effect:x",
      idempotencyKey: "k-unsent",
      actorScope: "s",
      payloadHash: "h",
      leaseDurationMs: 1_000,
    };
    const first = repo.claim({ ...identity, now: "2026-10-16T00:00:00.000Z" });
    const second = repo.claim({ ...identity, now: "2026-10-16T00:00:05.000Z" });
    assert.equal(second.outcome, "claimed");
    assert.equal(second.outcome === "claimed" ? second.claimKind : undefined, "retry_after_stale_claim");
    assert.equal(
      repo.markDispatched({ ...identity, claimToken: first.record.claimToken!, now: "2026-10-16T00:00:05.100Z" })
        .outcome,
      "claim_lost",
    );
    assert.equal(repo.markCompleted({ ...identity, claimToken: first.record.claimToken! }), false);
    const marked = repo.markDispatched({
      ...identity,
      claimToken: second.record.claimToken!,
      now: "2026-10-16T00:00:05.200Z",
    });
    assert.equal(marked.outcome, "dispatched");
    assert.equal(
      repo.markCompleted({
        ...identity,
        claimToken: marked.outcome === "dispatched" ? marked.record.claimToken : undefined,
      }),
      true,
    );
    assert.equal(repo.get(identity)?.status, "completed");
  });

  it("allows redispatch of a sent stale claim only with a provider-enforced idempotency key", () => {
    const repo = createRepo();
    const identity = {
      method: "POST",
      routePath: "external_side_effect:x",
      idempotencyKey: "k-provider",
      actorScope: "s",
      payloadHash: "h",
      leaseDurationMs: 1_000,
    };
    const first = repo.claim({ ...identity, now: "2026-10-16T00:00:00.000Z" });
    repo.markDispatched({ ...identity, claimToken: first.record.claimToken!, now: "2026-10-16T00:00:00.100Z" });
    const takeover = repo.claim({ ...identity, providerIdempotencyKeyEnforced: true, now: "2026-10-16T00:00:05.000Z" });
    assert.equal(takeover.outcome, "claimed");
    assert.equal(takeover.outcome === "claimed" ? takeover.claimKind : undefined, "redispatch_after_stale_send");
    assert.equal(takeover.record.status, "pending");
    assert.notEqual(takeover.record.claimToken, first.record.claimToken);
  });

  it("settles an owned dispatched claim as unknown_after_send", () => {
    const repo = createRepo();
    const identity = {
      method: "POST",
      routePath: "external_side_effect:x",
      idempotencyKey: "k-ambiguous",
      actorScope: "s",
      payloadHash: "h",
    };
    const first = repo.claim(identity);
    const marked = repo.markDispatched({ ...identity, claimToken: first.record.claimToken! });
    assert.equal(marked.outcome, "dispatched");
    assert.equal(marked.outcome === "dispatched" ? marked.record.claimExpiresAt : "unset", undefined);
    const token = marked.outcome === "dispatched" ? marked.record.claimToken! : "";
    assert.equal(repo.markUnknownAfterSend({ ...identity, claimToken: "wrong" }), false);
    assert.equal(repo.markUnknownAfterSend({ ...identity, claimToken: "  " }), false);
    assert.equal(repo.get(identity)?.status, "pending");
    assert.equal(repo.markUnknownAfterSend({ ...identity, claimToken: token }), true);
    assert.equal(repo.claim(identity).outcome, "unknown_after_send");
    assert.equal(repo.claim({ ...identity, payloadHash: "other" }).outcome, "payload_mismatch");
    assert.equal(repo.markFailed(identity), false);
    assert.equal(repo.markCompleted(identity), false);
    assert.equal(repo.get(identity)?.status, "unknown_after_send");
  });

  it("clears the dispatch fence when a failed claim is revived", () => {
    const repo = createRepo();
    const identity = {
      method: "POST",
      routePath: "external_side_effect:x",
      idempotencyKey: "k-revive",
      actorScope: "s",
      payloadHash: "h",
    };
    const first = repo.claim({ ...identity, now: "2026-10-16T00:00:00.000Z" });
    const marked = repo.markDispatched({ ...identity, claimToken: first.record.claimToken! });
    const token = marked.outcome === "dispatched" ? marked.record.claimToken : undefined;
    assert.equal(repo.markFailed({ ...identity, claimToken: token }), true);
    const revived = repo.claim({ ...identity, now: "2026-10-16T00:00:01.000Z" });
    assert.equal(revived.outcome, "claimed");
    assert.equal(revived.outcome === "claimed" ? revived.claimKind : undefined, "retry_after_failure");
    assert.equal(revived.record.dispatchedAt, undefined);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./sqlite.js";
import { OrchestrationWorktreeLeaseRepository } from "./orchestration-worktree-lease-repo.js";

describe("OrchestrationWorktreeLeaseRepository", () => {
  it("blocks active owners and fences stale operations after an expired generation is reclaimed", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const repo = new OrchestrationWorktreeLeaseRepository(db);
    const worktreePath = "F:/code/personal-ai/.worktrees/orchestration/run-1";

    const first = repo.claim({
      worktreePath,
      runId: "run-1",
      ownerId: "owner-a",
      leaseDurationMs: 60_000,
      now: "2026-07-12T00:00:00.000Z",
    });
    assert.equal(first.outcome, "claimed");
    if (first.outcome !== "claimed") {
      assert.fail("expected first worktree lease claim");
    }
    assert.equal(first.claimKind, "new");
    assert.equal(first.lease.generation, 1);

    const blocked = repo.claim({
      worktreePath,
      runId: "run-1",
      ownerId: "owner-b",
      leaseDurationMs: 60_000,
      now: "2026-07-12T00:00:30.000Z",
    });
    assert.equal(blocked.outcome, "blocked");
    assert.equal(blocked.lease.ownerId, "owner-a");
    assert.equal(blocked.lease.generation, 1);

    assert.equal(
      repo.renew({
        worktreePath,
        runId: "run-1",
        ownerId: "owner-a",
        generation: 1,
        leaseDurationMs: 60_000,
        now: "2026-07-12T00:02:00.000Z",
      }),
      undefined,
      "an expired generation must not resurrect itself before a competing claim",
    );

    const reclaimed = repo.claim({
      worktreePath,
      runId: "run-1",
      ownerId: "owner-b",
      leaseDurationMs: 60_000,
      now: "2026-07-12T00:02:00.000Z",
    });
    assert.equal(reclaimed.outcome, "claimed");
    if (reclaimed.outcome !== "claimed") {
      assert.fail("expected expired worktree lease reclamation");
    }
    assert.equal(reclaimed.claimKind, "reclaimed");
    assert.equal(reclaimed.lease.generation, 2);

    assert.equal(
      repo.renew({
        worktreePath,
        runId: "run-1",
        ownerId: "owner-a",
        generation: 1,
        leaseDurationMs: 60_000,
        now: "2026-07-12T00:02:01.000Z",
      }),
      undefined,
    );
    assert.equal(
      repo.release({
        worktreePath,
        runId: "run-1",
        ownerId: "owner-a",
        generation: 1,
        releasedAt: "2026-07-12T00:02:01.000Z",
      }),
      false,
    );
    assert.equal(repo.get(worktreePath)?.ownerId, "owner-b");
    assert.equal(repo.get(worktreePath)?.generation, 2);
    db.close();
  });

  it("renews without advancing generation and releases idempotently", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const repo = new OrchestrationWorktreeLeaseRepository(db);
    const worktreePath = "F:/code/personal-ai/.worktrees/orchestration/run-2";
    const first = repo.claim({
      worktreePath,
      runId: "run-2",
      ownerId: "owner-a",
      leaseDurationMs: 60_000,
      now: "2026-07-12T00:00:00.000Z",
    });
    assert.equal(first.outcome, "claimed");
    if (first.outcome !== "claimed") {
      assert.fail("expected initial worktree lease claim");
    }

    const renewed = repo.claim({
      worktreePath,
      runId: "run-2",
      ownerId: "owner-a",
      leaseDurationMs: 60_000,
      now: "2026-07-12T00:00:30.000Z",
    });
    assert.equal(renewed.outcome, "claimed");
    if (renewed.outcome !== "claimed") {
      assert.fail("expected same-owner worktree lease renewal");
    }
    assert.equal(renewed.claimKind, "renewed");
    assert.equal(renewed.lease.generation, 1);
    assert.equal(renewed.lease.leaseExpiresAt, "2026-07-12T00:01:30.000Z");

    const token = {
      worktreePath,
      runId: "run-2",
      ownerId: "owner-a",
      generation: 1,
      releasedAt: "2026-07-12T00:00:45.000Z",
    };
    assert.equal(repo.release(token), true);
    assert.equal(repo.release(token), true);
    assert.equal(repo.get(worktreePath)?.releasedAt, token.releasedAt);

    const next = repo.claim({
      worktreePath,
      runId: "run-2",
      ownerId: "owner-c",
      leaseDurationMs: 60_000,
      now: "2026-07-12T00:00:46.000Z",
    });
    assert.equal(next.outcome, "claimed");
    if (next.outcome !== "claimed") {
      assert.fail("expected released worktree lease reclamation");
    }
    assert.equal(next.lease.generation, 2);
    db.close();
  });
});

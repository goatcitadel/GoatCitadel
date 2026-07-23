import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  computeImprovementLifecycleRequestSha256,
  computeImprovementLifecycleResultSha256,
  type ImprovementLifecycleOperationRecord,
  type ImprovementLifecycleSettlementRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ImprovementLifecycleOperationRepository } from "./improvement-lifecycle-operation-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];
const openedDatabases: DatabaseClient[] = [];
const OBSERVED_SHA = "b".repeat(64);

afterEach(() => {
  for (const db of openedDatabases.splice(0)) db.close();
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

function createStore(): { db: DatabaseClient; repo: ImprovementLifecycleOperationRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-improvement-lifecycle-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  openedDatabases.push(db);
  return { db, repo: new ImprovementLifecycleOperationRepository(db) };
}

function intent(overrides: Partial<ImprovementLifecycleOperationRecord> = {}): ImprovementLifecycleOperationRecord {
  const base = {
    operationId: "improvement-op-1",
    idempotencyKey: "improvement:activate:activation-1",
    workspaceId: "workspace-1",
    operationKind: "activate" as const,
    targetKind: "improvement_activation" as const,
    targetId: "activation-1",
    actorId: "operator-1",
    sessionId: "session-1",
    createdAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
  const {
    approvalId: _approvalId,
    requestSha256: _requestSha256,
    ...request
  } = base as Record<string, unknown> & {
    approvalId?: string;
    requestSha256?: string;
  };
  return {
    ...base,
    approvalId: (overrides.approvalId ?? "approval-improvement-1") as string,
    requestSha256:
      overrides.requestSha256 ??
      computeImprovementLifecycleRequestSha256(
        request as Omit<ImprovementLifecycleOperationRecord, "requestSha256" | "approvalId">,
      ),
  };
}

const FUTURE_LEASE = "2126-07-23T12:05:00.000Z";
const EXPIRED_LEASE_CLAIMED_AT = "2020-07-23T12:00:00.000Z";
const EXPIRED_LEASE = "2020-07-23T12:05:00.000Z";

function settlement(
  overrides: Partial<ImprovementLifecycleSettlementRecord> = {},
): ImprovementLifecycleSettlementRecord {
  const result = overrides.result ?? { disposition: "applied", chunk: 1 };
  return {
    settlementId: "improvement-settlement-1",
    operationId: "improvement-op-1",
    claimGeneration: 1,
    inspectionId: "inspection-1",
    disposition: "applied",
    observedStateSha256: OBSERVED_SHA,
    result,
    resultSha256: computeImprovementLifecycleResultSha256(result),
    settledAt: "2026-07-23T12:10:00.000Z",
    ...overrides,
  };
}

describe("ImprovementLifecycleOperationRepository (fresh-chain SQLite through migration 175)", () => {
  it("stores an exact intent, replays it byte-identically, and conflicts on drifted material", () => {
    const { repo } = createStore();
    const input = intent();
    assert.deepEqual(repo.createIntent(input), input);
    assert.deepEqual(repo.createIntent(intent()), input);
    assert.throws(() => repo.createIntent(intent({ targetId: "activation-2" })), /conflicts with an immutable record/u);
    assert.deepEqual(repo.findIntentByApprovalId("approval-improvement-1"), input);
  });

  it("binds one fresh approval to exactly one operation: approval reuse conflicts", () => {
    const { repo } = createStore();
    repo.createIntent(intent());
    assert.throws(
      () =>
        repo.createIntent(
          intent({
            operationId: "improvement-op-2",
            idempotencyKey: "improvement:pause:activation-1",
            operationKind: "pause",
          }),
        ),
      /conflicts with an immutable record/u,
    );
  });

  it("self-verifies the request digest on intent creation so a mis-computed digest never persists", () => {
    const { repo } = createStore();
    // HX-402 P3 fold-in: validateOperation recomputes requestSha256 exactly like
    // validateSettlement recomputes resultSha256. A drifted digest is rejected
    // BEFORE any insert, so nothing immutable can carry a wrong request hash.
    assert.throws(
      () => repo.createIntent(intent({ requestSha256: "a".repeat(64) })),
      /request digest does not match canonical JSON/u,
    );
    assert.equal(repo.findIntent("improvement-op-1"), undefined);
    // Well-formed but non-matching material is equally rejected pre-insert.
    const drifted = intent();
    assert.throws(
      () => repo.createIntent({ ...drifted, targetId: "activation-tampered" }),
      /request digest does not match canonical JSON/u,
    );
    assert.equal(repo.findIntent("improvement-op-1"), undefined);
    // The exact digest still persists and replays byte-identically.
    const stored = repo.createIntent(intent());
    assert.deepEqual(repo.createIntent(intent()), stored);
    // Replay conflict detection still precedes digest verification for rows
    // that already exist, so same-ID/different-material keeps its immutable
    // WRITE_CONFLICT contract (the stored row's digest was verified at insert).
    assert.throws(
      () => repo.createIntent({ ...stored, targetId: "activation-2" }),
      /conflicts with an immutable record/u,
    );
  });

  it("keeps intents immutable at the database layer", () => {
    const { db, repo } = createStore();
    repo.createIntent(intent());
    assert.throws(
      () =>
        db
          .prepare("UPDATE improvement_lifecycle_operations SET target_id = 'x' WHERE operation_id = ?")
          .run("improvement-op-1"),
      /immutable/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM improvement_lifecycle_operations WHERE operation_id = ?").run("improvement-op-1"),
      /immutable/u,
    );
  });

  it("admits one claim winner, fences a live lease, and reclaims after expiry with the next generation", () => {
    const { repo } = createStore();
    repo.createIntent(intent());
    const first = repo.claim({
      operationId: "improvement-op-1",
      workerId: "worker-a",
      claimedAt: EXPIRED_LEASE_CLAIMED_AT,
      leaseExpiresAt: EXPIRED_LEASE,
    });
    assert.equal(first.claimGeneration, 1);
    // The expired lease is reclaimable by a second worker at generation 2.
    const second = repo.claim({
      operationId: "improvement-op-1",
      workerId: "worker-b",
      claimedAt: "2026-07-23T12:00:00.000Z",
      leaseExpiresAt: FUTURE_LEASE,
    });
    assert.equal(second.claimGeneration, 2);
    assert.equal(second.workerId, "worker-b");
    // The live far-future lease now fences any further claim.
    assert.throws(
      () =>
        repo.claim({
          operationId: "improvement-op-1",
          workerId: "worker-c",
          claimedAt: "2026-07-23T12:01:00.000Z",
          leaseExpiresAt: "2126-07-23T12:06:00.000Z",
        }),
      /fenced|live prior lease/u,
    );
    assert.equal(repo.findCurrentClaim("improvement-op-1")?.workerId, "worker-b");
  });

  it("rejects claims against unknown operations and raw non-sequential generations", () => {
    const { db, repo } = createStore();
    assert.throws(
      () =>
        repo.claim({
          operationId: "improvement-op-missing",
          workerId: "worker-a",
          claimedAt: "2026-07-23T12:00:00.000Z",
          leaseExpiresAt: FUTURE_LEASE,
        }),
      /fenced|FOREIGN KEY/iu,
    );
    repo.createIntent(intent());
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO improvement_lifecycle_operation_claims (
               operation_id, claim_generation, worker_id, claimed_at, lease_expires_at
             ) VALUES ('improvement-op-1', 5, 'worker-x', '2026-07-23T12:00:00.000Z', '2126-07-23T12:05:00.000Z')`,
          )
          .run(),
      /non-sequential|claim admission violated/u,
    );
  });

  it("records inspections only for the current claim generation", () => {
    const { repo } = createStore();
    repo.createIntent(intent());
    repo.claim({
      operationId: "improvement-op-1",
      workerId: "worker-a",
      claimedAt: EXPIRED_LEASE_CLAIMED_AT,
      leaseExpiresAt: EXPIRED_LEASE,
    });
    repo.claim({
      operationId: "improvement-op-1",
      workerId: "worker-b",
      claimedAt: "2026-07-23T12:00:00.000Z",
      leaseExpiresAt: FUTURE_LEASE,
    });
    // The fenced generation-1 worker cannot record an inspection.
    assert.throws(
      () =>
        repo.recordInspection({
          inspectionId: "inspection-stale",
          operationId: "improvement-op-1",
          claimGeneration: 1,
          observedStateSha256: OBSERVED_SHA,
          disposition: "matches_intent",
          observedAt: "2026-07-23T12:02:00.000Z",
        }),
      /fenced stale claim|inspection admission violated/u,
    );
    const inspection = repo.recordInspection({
      inspectionId: "inspection-1",
      operationId: "improvement-op-1",
      claimGeneration: 2,
      observedStateSha256: OBSERVED_SHA,
      disposition: "matches_intent",
      observedAt: "2026-07-23T12:02:00.000Z",
    });
    assert.equal(inspection.claimGeneration, 2);
  });

  it("settles once with an exact same-claim re-inspection, immutably, and replays byte-identically", () => {
    const { db, repo } = createStore();
    repo.createIntent(intent());
    repo.claim({
      operationId: "improvement-op-1",
      workerId: "worker-a",
      claimedAt: "2026-07-23T12:00:00.000Z",
      leaseExpiresAt: FUTURE_LEASE,
    });
    repo.recordInspection({
      inspectionId: "inspection-1",
      operationId: "improvement-op-1",
      claimGeneration: 1,
      observedStateSha256: OBSERVED_SHA,
      disposition: "matches_intent",
      observedAt: "2026-07-23T12:02:00.000Z",
    });
    const stored = repo.settle(settlement());
    assert.equal(stored.disposition, "applied");
    assert.deepEqual(repo.settle(settlement()), stored);
    assert.throws(() => repo.settle(settlement({ disposition: "failed" })), /conflicts with an immutable record/u);
    assert.throws(
      () => db.prepare("UPDATE improvement_lifecycle_operation_settlements SET disposition = 'failed'").run(),
      /immutable/u,
    );
    assert.throws(() => db.prepare("DELETE FROM improvement_lifecycle_operation_settlements").run(), /immutable/u);
    // A settled operation admits no further claims.
    assert.throws(
      () =>
        repo.claim({
          operationId: "improvement-op-1",
          workerId: "worker-d",
          claimedAt: "2026-07-23T12:20:00.000Z",
          leaseExpiresAt: "2126-07-23T12:25:00.000Z",
        }),
      /settled|fenced/u,
    );
    assert.deepEqual(repo.listUnsettled("workspace-1"), []);
  });

  it("never reports applied without a matches_intent observation and never settles from a fenced claim", () => {
    const { repo } = createStore();
    repo.createIntent(intent());
    repo.claim({
      operationId: "improvement-op-1",
      workerId: "worker-a",
      claimedAt: "2026-07-23T12:00:00.000Z",
      leaseExpiresAt: FUTURE_LEASE,
    });
    repo.recordInspection({
      inspectionId: "inspection-diverged",
      operationId: "improvement-op-1",
      claimGeneration: 1,
      observedStateSha256: OBSERVED_SHA,
      disposition: "diverged",
      observedAt: "2026-07-23T12:02:00.000Z",
    });
    // A diverged observation cannot back an applied settlement.
    assert.throws(
      () => repo.settle(settlement({ inspectionId: "inspection-diverged" })),
      /false applied claim|settlement admission violated/u,
    );
    // The same observation honestly backs a failed settlement.
    const failedResult = { disposition: "failed", reason: "external state diverged" };
    const failed = repo.settle(
      settlement({
        inspectionId: "inspection-diverged",
        disposition: "failed",
        result: failedResult,
        resultSha256: computeImprovementLifecycleResultSha256(failedResult),
      }),
    );
    assert.equal(failed.disposition, "failed");
  });

  it("rejects settlements that cite a different claim's inspection or a drifted observed state", () => {
    const { repo } = createStore();
    repo.createIntent(intent());
    repo.claim({
      operationId: "improvement-op-1",
      workerId: "worker-a",
      claimedAt: "2026-07-23T12:00:00.000Z",
      leaseExpiresAt: FUTURE_LEASE,
    });
    repo.recordInspection({
      inspectionId: "inspection-1",
      operationId: "improvement-op-1",
      claimGeneration: 1,
      observedStateSha256: OBSERVED_SHA,
      disposition: "matches_intent",
      observedAt: "2026-07-23T12:02:00.000Z",
    });
    assert.throws(
      () => repo.settle(settlement({ observedStateSha256: "c".repeat(64) })),
      /missing exact same-claim re-inspection|settlement admission violated/u,
    );
    assert.throws(
      () => repo.settle(settlement({ claimGeneration: 2 })),
      /fenced|missing exact|settlement admission violated|FOREIGN KEY/iu,
    );
  });

  it("lists unsettled intents for crash recovery in stable order", () => {
    const { repo } = createStore();
    repo.createIntent(intent());
    repo.createIntent(
      intent({
        operationId: "improvement-op-2",
        idempotencyKey: "improvement:pause:activation-2",
        operationKind: "pause",
        targetId: "activation-2",
        approvalId: "approval-improvement-2",
        createdAt: "2026-07-23T12:01:00.000Z",
      }),
    );
    assert.deepEqual(
      repo.listUnsettled("workspace-1").map((operation) => operation.operationId),
      ["improvement-op-1", "improvement-op-2"],
    );
    assert.deepEqual(repo.listUnsettled("workspace-2"), []);
  });
});

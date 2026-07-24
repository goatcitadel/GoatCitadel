import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import {
  SkillAggregateRevisionRepository,
  type SkillAggregateRevisionMutation,
} from "./skill-aggregate-revision-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
  }
});

function assertWriteConflict(
  action: () => unknown,
  expected: {
    resourceKind: string;
    resourceId: string;
    expectedRevision: number;
    currentRevision: number;
  },
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, "WRITE_CONFLICT");
    assert.deepEqual(error.details, expected);
    return true;
  });
}

function createSharedClients(): { dbPath: string; clientA: DatabaseClient; clientB: DatabaseClient } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-aggregate-cas-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return {
    dbPath,
    clientA: createDatabase({ dbPath }),
    clientB: createDatabase({ dbPath }),
  };
}

describe("SkillAggregateRevisionRepository", () => {
  it("creates revision one atomically and rejects duplicate creators before domain mutation", () => {
    const { clientA, clientB } = createSharedClients();
    try {
      clientA.exec("CREATE TABLE skill_initial_probe (probe_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const revisionsA = new SkillAggregateRevisionRepository(clientA);
      const revisionsB = new SkillAggregateRevisionRepository(clientB);
      const createdAt = "2026-07-13T00:00:00.000Z";

      const created = revisionsA.createWithInitialRevision(
        "candidate_skill",
        "candidate.initial",
        () => {
          clientA
            .prepare("INSERT INTO skill_initial_probe (probe_id, value) VALUES ('candidate.initial', 'created')")
            .run();
          return { value: "created", changed: true };
        },
        createdAt,
      );
      assert.deepEqual(created, { value: "created", changed: true, revision: 1 });
      assert.equal(revisionsB.get("candidate_skill", "candidate.initial")?.revision, 1);

      let duplicateMutationCalled = false;
      assert.throws(
        () =>
          revisionsB.createWithInitialRevision("candidate_skill", "candidate.initial", () => {
            duplicateMutationCalled = true;
            return { value: "duplicate", changed: true };
          }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.equal(error.code, "WRITE_CONFLICT");
          assert.deepEqual(error.details, {
            resourceKind: "candidate_skill",
            resourceId: "candidate.initial",
            expectedState: "absent",
            currentRevision: 1,
          });
          return true;
        },
      );
      assert.equal(duplicateMutationCalled, false);

      assert.throws(
        () =>
          revisionsA.createWithInitialRevision("candidate_skill", "candidate.rollback", () => {
            clientA
              .prepare("INSERT INTO skill_initial_probe (probe_id, value) VALUES ('candidate.rollback', 'created')")
              .run();
            throw new Error("initial domain mutation failed");
          }),
        /initial domain mutation failed/,
      );
      assert.equal(revisionsA.get("candidate_skill", "candidate.rollback"), undefined);
      assert.equal(
        clientA.prepare("SELECT value FROM skill_initial_probe WHERE probe_id = 'candidate.rollback'").get(),
        undefined,
      );
    } finally {
      clientB.close();
      clientA.close();
    }
  });

  it("fences stale writers, preserves semantic no-ops, and returns structured conflicts", () => {
    const { clientA, clientB } = createSharedClients();
    try {
      clientA.exec("CREATE TABLE skill_revision_probe (probe_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      clientA.prepare("INSERT INTO skill_revision_probe (probe_id, value) VALUES ('runtime', 'initial')").run();
      const revisionsA = new SkillAggregateRevisionRepository(clientA);
      const revisionsB = new SkillAggregateRevisionRepository(clientB);
      const createdAt = "2026-07-13T00:00:00.000Z";
      const updatedAt = "2026-07-13T00:01:00.000Z";

      assert.deepEqual(revisionsA.ensure("runtime_skill", "  skill.alpha  ", createdAt), {
        aggregateKind: "runtime_skill",
        aggregateId: "skill.alpha",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      });
      assert.equal(revisionsB.get("runtime_skill", "skill.alpha")?.revision, 1);

      const winner = revisionsA.runWithRevision(
        "runtime_skill",
        "skill.alpha",
        1,
        () => {
          clientA.prepare("UPDATE skill_revision_probe SET value = 'winner' WHERE probe_id = 'runtime'").run();
          return { value: "winner", changed: true };
        },
        updatedAt,
      );
      assert.deepEqual(winner, { value: "winner", changed: true, revision: 2 });
      assert.equal(revisionsB.get("runtime_skill", "skill.alpha")?.updatedAt, updatedAt);

      let staleMutationCalled = false;
      assertWriteConflict(
        () =>
          revisionsB.runWithRevision("runtime_skill", "skill.alpha", 1, () => {
            staleMutationCalled = true;
            clientB.prepare("UPDATE skill_revision_probe SET value = 'stale' WHERE probe_id = 'runtime'").run();
            return { value: "stale", changed: true };
          }),
        {
          resourceKind: "runtime_skill",
          resourceId: "skill.alpha",
          expectedRevision: 1,
          currentRevision: 2,
        },
      );
      assert.equal(staleMutationCalled, false, "the stale mutation must be fenced before domain side effects");
      assert.equal(
        clientA.prepare("SELECT value FROM skill_revision_probe WHERE probe_id = 'runtime'").get<{ value: string }>()
          ?.value,
        "winner",
      );

      const noOp = revisionsB.runWithRevision(
        "runtime_skill",
        "skill.alpha",
        2,
        () => ({ value: "already-winner", changed: false }),
        "2026-07-13T00:02:00.000Z",
      );
      assert.deepEqual(noOp, { value: "already-winner", changed: false, revision: 2 });
      assert.equal(
        revisionsA.get("runtime_skill", "skill.alpha")?.updatedAt,
        updatedAt,
        "semantic no-ops must not rewrite aggregate metadata",
      );
    } finally {
      clientB.close();
      clientA.close();
    }
  });

  it("lazily fences unbackfilled aggregates without persisting failed stale initialization", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      const revisions = new SkillAggregateRevisionRepository(db);
      assert.equal(revisions.get("activation_policy", "global"), undefined);
      assertWriteConflict(
        () =>
          revisions.runWithRevision("activation_policy", "global", 2, () => ({
            value: "must-not-run",
            changed: true,
          })),
        {
          resourceKind: "activation_policy",
          resourceId: "global",
          expectedRevision: 2,
          currentRevision: 1,
        },
      );
      assert.equal(
        revisions.get("activation_policy", "global"),
        undefined,
        "the lazy revision-one insert must roll back with the stale request",
      );

      assert.throws(
        () => revisions.ensure("runtime_skill", " "),
        (error: unknown) => error instanceof ValidationError && error.code === "FIELD_REQUIRED",
      );
      assert.throws(
        () => revisions.runWithRevision("candidate_skill", "candidate-a", 0, () => ({ value: null, changed: false })),
        (error: unknown) => error instanceof ValidationError && error.code === "FIELD_INVALID",
      );
    } finally {
      db.close();
    }
  });

  it("locks multi-aggregate mutations in deterministic order and rolls them back atomically", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    try {
      db.exec("CREATE TABLE skill_batch_probe (probe_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO skill_batch_probe (probe_id, value) VALUES ('batch', 'initial')").run();
      const revisions = new SkillAggregateRevisionRepository(db);
      const initialAt = "2026-07-13T01:00:00.000Z";
      revisions.ensure("runtime_skill", "skill.alpha", initialAt);
      revisions.ensure("candidate_skill", "candidate.beta", initialAt);

      const changedAt = "2026-07-13T01:01:00.000Z";
      const batch = revisions.runWithRevisions(
        [
          { aggregateKind: "runtime_skill", aggregateId: "skill.alpha", expectedRevision: 1 },
          { aggregateKind: "candidate_skill", aggregateId: "candidate.beta", expectedRevision: 1 },
        ],
        () => {
          db.prepare("UPDATE skill_batch_probe SET value = 'changed' WHERE probe_id = 'batch'").run();
          return { value: "changed", changed: true };
        },
        changedAt,
      );
      assert.deepEqual(
        batch.revisions.map((record) => [record.aggregateKind, record.aggregateId, record.revision]),
        [
          ["candidate_skill", "candidate.beta", 2],
          ["runtime_skill", "skill.alpha", 2],
        ],
        "returned revisions expose the canonical lock order",
      );

      const noOp = revisions.runWithRevisions(
        [
          { aggregateKind: "runtime_skill", aggregateId: "skill.alpha", expectedRevision: 2 },
          { aggregateKind: "candidate_skill", aggregateId: "candidate.beta", expectedRevision: 2 },
          { aggregateKind: "candidate_skill", aggregateId: "candidate.beta", expectedRevision: 2 },
        ],
        () => ({ value: "unchanged", changed: false }),
        "2026-07-13T01:02:00.000Z",
      );
      assert.equal(noOp.revisions.length, 2, "identical duplicate locks should be coalesced");
      assert.ok(noOp.revisions.every((record) => record.revision === 2 && record.updatedAt === changedAt));

      let staleMutationCalled = false;
      assertWriteConflict(
        () =>
          revisions.runWithRevisions(
            [
              { aggregateKind: "runtime_skill", aggregateId: "skill.alpha", expectedRevision: 1 },
              { aggregateKind: "candidate_skill", aggregateId: "candidate.beta", expectedRevision: 1 },
            ],
            () => {
              staleMutationCalled = true;
              return { value: "stale", changed: true };
            },
          ),
        {
          resourceKind: "candidate_skill",
          resourceId: "candidate.beta",
          expectedRevision: 1,
          currentRevision: 2,
        },
      );
      assert.equal(staleMutationCalled, false, "canonical candidate lock must fail before the callback");

      assert.throws(
        () =>
          revisions.runWithRevisions(
            [
              { aggregateKind: "candidate_skill", aggregateId: "candidate.beta", expectedRevision: 2 },
              { aggregateKind: "runtime_skill", aggregateId: "skill.alpha", expectedRevision: 2 },
            ],
            () => {
              db.prepare("UPDATE skill_batch_probe SET value = 'rolled-back' WHERE probe_id = 'batch'").run();
              throw new Error("mutation failed");
            },
          ),
        /mutation failed/,
      );
      assert.equal(
        db.prepare("SELECT value FROM skill_batch_probe WHERE probe_id = 'batch'").get<{ value: string }>()?.value,
        "changed",
      );
      assert.equal(revisions.get("candidate_skill", "candidate.beta")?.revision, 2);
      assert.equal(revisions.get("runtime_skill", "skill.alpha")?.revision, 2);

      assert.throws(
        () => revisions.runWithRevisions([], () => ({ value: null, changed: false })),
        (error: unknown) => error instanceof ValidationError && error.code === "FIELD_REQUIRED",
      );
      assert.throws(
        () =>
          revisions.runWithRevisions(
            [
              { aggregateKind: "candidate_skill", aggregateId: "candidate.beta", expectedRevision: 2 },
              { aggregateKind: "candidate_skill", aggregateId: "candidate.beta", expectedRevision: 3 },
            ],
            () => ({ value: null, changed: false }),
          ),
        (error: unknown) => error instanceof ValidationError && error.code === "FIELD_INVALID",
      );

      const invalidAsyncMutation = (() =>
        Promise.resolve({ value: "async", changed: true })) as unknown as () => SkillAggregateRevisionMutation<string>;
      assert.throws(
        () => revisions.runWithRevision("runtime_skill", "async.skill", 1, invalidAsyncMutation),
        /must be synchronous/,
      );
      assert.equal(revisions.get("runtime_skill", "async.skill"), undefined);
    } finally {
      db.close();
    }
  });
});

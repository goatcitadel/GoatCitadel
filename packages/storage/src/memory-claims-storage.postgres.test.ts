import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryLearningRecord } from "@goatcitadel/contracts";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { MemoryLearningRepository } from "./memory-learning-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL preserves one trusted scalar claim and rejects a raced exact-target correction",
  { skip: !connectionString },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "memory_claims");
    try {
      const repo = new MemoryLearningRepository(scope.db);
      const record: MemoryLearningRecord = {
        learningId: "first",
        workspaceId: "default",
        key: "reply",
        type: "operator_preference",
        insight: "Prefer concise replies",
        confidence: 0.8,
        status: "trusted",
        authority: "operator",
        sourceRefs: [],
        fileRefs: [],
        claim: {
          identity: {
            subject: "operator",
            predicate: "reply_length",
            scope: { kind: "workspace", id: "default" },
            cardinality: "scalar",
          },
          value: "concise",
        },
        createdAt: "2026-11-18T00:00:00.000Z",
        updatedAt: "2026-11-18T00:00:00.000Z",
      };
      const first = repo.insert(record);
      assert.throws(() => repo.insert({ ...record, learningId: "duplicate" }));
      assert.throws(() =>
        repo.supersede({ learningId: "first", expectedSourceHash: "stale", next: { ...record, learningId: "next" } }),
      );
      const result = repo.supersede({
        learningId: "first",
        expectedSourceHash: first.sourceHash!,
        next: {
          ...record,
          learningId: "next",
          insight: "Prefer detailed replies",
          claim: { ...record.claim!, value: "detailed" },
        },
      });
      assert.equal(result.previous.status, "superseded");
      assert.equal(result.previous.supersededById, "next");
      assert.equal(repo.findClaim("default", record.claim!).length, 1);
      assert.throws(() =>
        repo.supersede({
          learningId: "first",
          expectedSourceHash: first.sourceHash!,
          next: { ...record, learningId: "raced" },
        }),
      );
      assert.deepEqual(repo.list({ workspaceId: "foreign" }), []);
    } finally {
      await scope.teardown();
    }
  },
);

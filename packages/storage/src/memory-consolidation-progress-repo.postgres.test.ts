import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { MemoryConsolidationProgressRepository } from "./memory-consolidation-progress-repo.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL consolidation checkpoint CAS excludes stale and foreign workers",
  { skip: !connectionString },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "memory_consolidation_progress");
    try {
      const repo = new MemoryConsolidationProgressRepository(new SystemSettingsRepository(scope.db), scope.db);
      const now = "2026-11-18T00:00:00.000Z";
      const claim = repo.claimProgress("A", 0, "worker-a", now)!;
      assert.ok(claim);
      assert.equal(repo.claimProgress("A", 0, "worker-b", now), undefined);
      assert.throws(() => repo.commitProgress("A", claim.revision, "worker-b", undefined, now));
      const cursor = { finishedAt: now, turnId: "turn-b" };
      const exclusion={...cursor,sessionId:"source-session",sourceHash:"a".repeat(64),reason:"source_size_limit" as const};
      repo.commitProgress("A", claim.revision, "worker-a", cursor, now,[exclusion]);
      assert.deepEqual(repo.readProgress("A").cursor, cursor);
      assert.equal(new MemoryConsolidationProgressRepository(new SystemSettingsRepository(scope.db),scope.db).readProgress("A").sourceExclusionCount,1);
      const next=repo.claimProgress("A",repo.readProgress("A").revision,"next",now)!;
      assert.equal(repo.commitProgress("A",next.revision,"next",cursor,now,[exclusion]).sourceExclusionCount,1);
      assert.deepEqual(repo.readProgress("B"), { revision: 0 });
    } finally {
      await scope.teardown();
    }
  },
);

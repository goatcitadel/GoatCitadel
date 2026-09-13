import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";
import { policyDefaults, raceMemoryPolicySaves, verifyMemoryPolicyRevisions } from "./memory-policy-revision.test-support.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL policy saves compare revisions, settle recommendations atomically, and reject concurrent overwrites", { skip: !connectionString }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "memory_policy_revision");
  try {
    verifyMemoryPolicyRevisions(scope.db);
    const repo = new MemoryMaintenanceRepository(scope.db);
    const base = repo.ensurePolicy(policyDefaults("race-workspace"));
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    const results = await raceMemoryPolicySaves({ kind: "postgres", workerOptions: {
      connectionString: url.toString(), database: decodeURIComponent(url.pathname.slice(1)) || "postgres", pool: { max: 1 },
    }, workspaceId: base.workspaceId, expectedRevision: base.revision });
    assert.deepEqual(results.map((item) => item.outcome).sort(), ["conflict", "saved"]);
    const winner = results.find((item) => item.outcome === "saved")!;
    const current = repo.requirePolicy(base.workspaceId);
    assert.equal(current.enabled, winner.enabled);
    assert.equal(current.minChangedSessions, winner.threshold);
    assert.equal(current.timeZone, base.timeZone);
  } finally { await scope.teardown(); }
});

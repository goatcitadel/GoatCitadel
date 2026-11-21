import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";
import { ImprovementWatchEvidenceRepository } from "./improvement-watch-evidence-repo.js";
import { seedImprovementWatch, seedWatchSignal } from "./improvement-watch-evidence.test-support.js";
const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL freezes pre-work bindings across independent writers and rejects stale eligibility",
  { skip: !connectionString, timeout: 120000 },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "prompt_watch");
    try {
      const watches = new ImprovementWatchEvidenceRepository(scope.db),
        runs = new PromptPackRunRepository(scope.db);
      seedImprovementWatch(scope.db);
      const capturedAt = new Date().toISOString(),
        bindings = watches.captureForWork({
          workspaceId: "default",
          fingerprint: "fingerprint",
          capability: "routing",
          capturedAt,
        });
      assert.equal(bindings.length, 1);
      runs.create({
        runId: "observed",
        packId: "pack",
        testId: "test",
        startedAt: capturedAt,
        improvementWatchBindings: bindings,
      });
      assert.deepEqual(runs.get("observed").improvementWatchBindings, bindings);
      await assert.rejects(
        scope.scopedPool.query("UPDATE prompt_pack_runs SET improvement_watch_bindings_json=NULL WHERE run_id=$1", [
          "observed",
        ]),
        /immutable/iu,
      );
      runs.create({ runId: "legacy", packId: "pack", testId: "test" });
      await assert.rejects(
        scope.scopedPool.query("UPDATE prompt_pack_runs SET improvement_watch_bindings_json=$1 WHERE run_id=$2", [
          JSON.stringify(bindings),
          "legacy",
        ]),
        /immutable/iu,
      );
      assert.equal(runs.get("legacy").improvementWatchBindings, undefined);
      await scope.scopedPool.query(
        "UPDATE improvement_candidates SET current_revision_id=NULL WHERE candidate_id='candidate'",
      );
      assert.deepEqual(
        watches.captureForWork({
          workspaceId: "default",
          fingerprint: "fingerprint",
          capability: "routing",
          capturedAt,
        }),
        [],
      );
      await scope.scopedPool.query(
        "UPDATE improvement_candidates SET current_revision_id='revision' WHERE candidate_id='candidate'",
      );
      for (let i = 0; i < 5; i++) seedWatchSignal(scope.db, `positive-${i}`, "positive");
      assert.equal(watches.reconcile("watch").status, "stable");
      seedWatchSignal(scope.db, "late-negative", "negative");
      assert.equal(watches.reconcile("watch").status, "alerting");
    } finally {
      await scope.teardown();
    }
  },
);

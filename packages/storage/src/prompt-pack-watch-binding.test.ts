import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";
import { ImprovementWatchEvidenceRepository } from "./improvement-watch-evidence-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { seedImprovementWatch } from "./improvement-watch-evidence.test-support.js";
const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
const binding = {
  activationId: "watch",
  revisionId: "revision",
  changeHash: "a".repeat(64),
  workspaceId: "default",
  fingerprint: "fingerprint",
  capability: "routing",
  capturedAt: "2026-11-19T00:00:00.000Z",
};
it("persists the pre-work binding at creation and rejects later attachment or alteration", () => {
  const db = files.open({ dbPath: files.path("prompt-watch-binding") }),
    repo = new PromptPackRunRepository(db);
  const run = repo.create({
    runId: "observed",
    packId: "pack",
    testId: "test",
    startedAt: binding.capturedAt,
    improvementWatchBindings: [binding],
  });
  assert.deepEqual(run.improvementWatchBindings, [binding]);
  repo.patch(run.runId, { status: "completed" });
  assert.deepEqual(repo.get(run.runId).improvementWatchBindings, [binding]);
  assert.throws(
    () => db.prepare("UPDATE prompt_pack_runs SET improvement_watch_bindings_json=NULL WHERE run_id=?").run(run.runId),
    /immutable/iu,
  );
  repo.create({ runId: "legacy", packId: "pack", testId: "test" });
  assert.throws(
    () =>
      db
        .prepare("UPDATE prompt_pack_runs SET improvement_watch_bindings_json=? WHERE run_id='legacy'")
        .run(JSON.stringify([binding])),
    /immutable/iu,
  );
  assert.equal(repo.get("legacy").improvementWatchBindings, undefined);
});
it("refuses a post-work timestamp, partial change hash or repeated capability at initial persistence", () => {
  const db = files.open({ dbPath: files.path("prompt-watch-invalid") }),
    repo = new PromptPackRunRepository(db);
  for (const [id, bindings] of [
    ["after", [{ ...binding, capturedAt: "2026-11-20T00:00:00.000Z" }]],
    ["short", [{ ...binding, changeHash: "partial" }]],
    ["duplicate", [binding, binding]],
    ["over-limit", Array.from({ length: 14 }, (_, index) => ({ ...binding, capability: `metric-${index}` }))],
  ] as const)
    assert.throws(
      () =>
        repo.create({
          runId: id,
          packId: "pack",
          testId: "test",
          startedAt: binding.capturedAt,
          improvementWatchBindings: [...bindings],
        }),
      /binding/iu,
    );
});
it("captures only the active current revision, complete hash and watch window in the requested scope", () => {
  const db = files.open({ dbPath: files.path("prompt-watch-capture") }),
    repo = new ImprovementWatchEvidenceRepository(db);
  seedImprovementWatch(db);
  db.prepare("UPDATE improvement_activations SET applied_change_hash=? WHERE activation_id='watch'").run(
    binding.changeHash,
  );
  db.prepare("UPDATE improvement_candidate_revisions SET change_hash=? WHERE revision_id='revision'").run(
    binding.changeHash,
  );
  const capturedAt = new Date().toISOString(),
    input = { workspaceId: "default", fingerprint: "fingerprint", capability: "routing", capturedAt };
  assert.deepEqual(repo.captureForWork(input), [{ ...binding, capturedAt }]);
  assert.deepEqual(repo.captureForWork({ ...input, workspaceId: "foreign" }), []);
  db.prepare("UPDATE improvement_candidates SET current_revision_id=NULL WHERE candidate_id='candidate'").run();
  assert.deepEqual(repo.captureForWork(input), []);
  db.prepare("UPDATE improvement_candidates SET current_revision_id='revision' WHERE candidate_id='candidate'").run();
  db.prepare("UPDATE improvement_activations SET watch_ends_at=? WHERE activation_id='watch'").run(
    new Date(Date.parse(capturedAt) - 1).toISOString(),
  );
  assert.deepEqual(repo.captureForWork(input), []);
});

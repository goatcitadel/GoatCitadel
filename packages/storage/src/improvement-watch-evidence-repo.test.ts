import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { ImprovementWatchEvidenceRepository } from "./improvement-watch-evidence-repo.js";
import { seedImprovementWatch, seedWatchSignal } from "./improvement-watch-evidence.test-support.js";
const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
it("finds a bound regression after more than 2000 unrelated observations and preserves its count on replay", () => {
  const db = files.open({ dbPath: files.path("watch-busy-stream") }),
    repo = new ImprovementWatchEvidenceRepository(db);
  seedImprovementWatch(db);
  db.transaction("immediate", () => {
    for (let i = 0; i < 2100; i++)
      seedWatchSignal(db, `noise-${i}`, i % 2 ? "neutral" : "positive", {
        bound: false,
        occurredAt: new Date(Date.now() - 30_000).toISOString(),
      });
  });
  seedWatchSignal(db, "late-negative", "negative");
  assert.deepEqual(repo.reconcile("watch"), { changed: true, status: "alerting", shouldRestore: true });
  assert.equal(repo.reconcile("watch").changed, false);
  assert.equal(
    db
      .prepare("SELECT regression_count FROM improvement_activations WHERE activation_id='watch'")
      .get<{ regression_count: number }>()?.regression_count,
    1,
  );
});
it("counts only relevant exact-revision positives, converges on replay and retains legacy evidence", () => {
  const db = files.open({ dbPath: files.path("watch-evidence") }),
    repo = new ImprovementWatchEvidenceRepository(db);
  seedImprovementWatch(db);
  for (const [id, options] of [
    ["unbound", { bound: false }],
    ["stale", { revision: "old" }],
    ["foreign", { workspaceId: "foreign" }],
  ] as const)
    seedWatchSignal(db, id, "positive", options);
  seedWatchSignal(db, "neutral", "neutral");
  assert.equal(repo.reconcile("watch").status, "watching");
  assert.equal(
    db
      .prepare("SELECT positive_signal_count AS count FROM improvement_activations WHERE activation_id='watch'")
      .get<{ count: number }>()!.count,
    0,
  );
  for (let i = 0; i < 5; i++) seedWatchSignal(db, `positive-${i}`, "positive");
  assert.equal(repo.reconcile("watch").status, "stable");
  assert.equal(repo.reconcile("watch").changed, false);
  assert.equal(
    db
      .prepare("SELECT positive_signal_count AS count FROM improvement_activations WHERE activation_id='watch'")
      .get<{ count: number }>()!.count,
    5,
  );
});
it("expiry is insufficient and a bound negative produces a governed recovery request", () => {
  const db = files.open({ dbPath: files.path("watch-expiry") }),
    repo = new ImprovementWatchEvidenceRepository(db);
  seedImprovementWatch(db);
  db.prepare("UPDATE improvement_activations SET watch_ends_at=? WHERE activation_id='watch'").run(
    new Date(Date.now() - 1).toISOString(),
  );
  assert.equal(repo.reconcile("watch").status, "insufficient_evidence");
  seedWatchSignal(db, "negative", "negative", { occurredAt: new Date(Date.now() - 30_000).toISOString() });
  assert.deepEqual(repo.reconcile("watch"), { changed: true, status: "alerting", shouldRestore: true });
});
it("a current regression still alerts after enough earlier positives established stability", () => {
  const db = files.open({ dbPath: files.path("watch-later-regression") }),
    repo = new ImprovementWatchEvidenceRepository(db);
  seedImprovementWatch(db);
  for (let i = 0; i < 5; i++) seedWatchSignal(db, `positive-${i}`, "positive");
  assert.equal(repo.reconcile("watch").status, "stable");
  seedWatchSignal(db, "late-negative", "negative");
  assert.deepEqual(repo.listForSignal("late-negative"), ["watch"]);
  assert.equal(repo.reconcile("watch").status, "alerting");
});
it("does not borrow another activation's binding or accept a retrospective eligibility timestamp", () => {
  const db = files.open({ dbPath: files.path("watch-binding-origin") }),
    repo = new ImprovementWatchEvidenceRepository(db);
  seedImprovementWatch(db);
  for (const [id, patch] of [
    ["legacy", { activationId: undefined }],
    ["other-watch", { activationId: "foreign-watch" }],
    ["after-work", { capturedAt: new Date(Date.now() + 60_000).toISOString() }],
  ] as const) {
    seedWatchSignal(db, id, "positive");
    const raw = db
      .prepare("SELECT metadata_json FROM improvement_signals WHERE signal_id=?")
      .get<{ metadata_json: string }>(id)!;
    const metadata = JSON.parse(raw.metadata_json);
    metadata.improvementWatchRevision = { ...metadata.improvementWatchRevision, ...patch };
    db.prepare("UPDATE improvement_signals SET metadata_json=? WHERE signal_id=?").run(JSON.stringify(metadata), id);
  }
  repo.reconcile("watch");
  assert.equal(
    db
      .prepare("SELECT positive_signal_count AS count FROM improvement_activations WHERE activation_id='watch'")
      .get<{ count: number }>()!.count,
    0,
  );
});
it("rescoring one work pair cannot inflate positives and a corrected negative still alerts", () => {
  const db = files.open({ dbPath: files.path("watch-work-dedupe") }),
    repo = new ImprovementWatchEvidenceRepository(db);
  seedImprovementWatch(db);
  for (let i = 0; i < 5; i++) {
    const id = `rescore-${i}`;
    seedWatchSignal(db, id, "positive");
    const raw = db
      .prepare("SELECT metadata_json FROM improvement_signals WHERE signal_id=?")
      .get<{ metadata_json: string }>(id)!;
    const metadata = {
      ...JSON.parse(raw.metadata_json),
      observedWork: { currentRunId: "current", baselineRunId: "baseline" },
    };
    db.prepare("UPDATE improvement_signals SET metadata_json=? WHERE signal_id=?").run(JSON.stringify(metadata), id);
  }
  assert.equal(repo.reconcile("watch").status, "watching");
  assert.equal(
    db
      .prepare("SELECT positive_signal_count AS count FROM improvement_activations WHERE activation_id='watch'")
      .get<{ count: number }>()!.count,
    1,
  );
  seedWatchSignal(db, "corrected-negative", "negative");
  const raw = db
    .prepare("SELECT metadata_json FROM improvement_signals WHERE signal_id='corrected-negative'")
    .get<{ metadata_json: string }>()!;
  db.prepare("UPDATE improvement_signals SET metadata_json=? WHERE signal_id='corrected-negative'").run(
    JSON.stringify({
      ...JSON.parse(raw.metadata_json),
      observedWork: { currentRunId: "current", baselineRunId: "baseline" },
    }),
  );
  assert.equal(repo.reconcile("watch").status, "alerting");
});

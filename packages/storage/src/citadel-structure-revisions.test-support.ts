import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ConflictError, ValidationError, type CitadelStructureSnapshot, type CitadelStructureChange } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CitadelRepository } from "./citadel-repo.js";

const isConflict = (error: unknown) => error instanceof ConflictError
  && error.code === "WRITE_CONFLICT" && error.details?.reason === "CITADEL_STRUCTURE_REVISION_CONFLICT";
const charterChange = (purpose: string): CitadelStructureChange => ({ type: "charter", charter: { purpose, kind: "custom" } });

export function verifyCitadelStructureRevisions(db: DatabaseClient): void {
  const repo = new CitadelRepository(db);
  const initial = repo.getStructureSnapshot("structure-review");
  assert.equal(initial.charter, null);
  assert.equal(initial.record, undefined);
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(initial.revision, repo.getStructureSnapshot("other-structure").revision);
  const mutate = (base: CitadelStructureSnapshot, change: CitadelStructureChange) => repo.mutateStructure({ citadelId: base.citadelId, expectedRevision: base.revision, change });
  for (const expectedRevision of [undefined, null, "", "invalid", 7]) {
    assert.throws(() => repo.mutateStructure({ citadelId: initial.citadelId, expectedRevision: expectedRevision as never, change: charterChange("Rejected") }), ValidationError);
  }
  assert.deepEqual(repo.getStructureSnapshot(initial.citadelId), initial);
  const created = mutate(initial, { type: "setup", charter: { purpose: "Original", kind: "custom" }, chambers: [{ name: "Retained", sealed: true }] });
  assert.notEqual(created.revision, initial.revision);
  assert.equal(created.chambers.length, 1);
  for (const change of [charterChange("Stale"), { type: "chamber", chamber: { name: "Stale chamber" } }, { type: "setup", charter: { purpose: "Stale", kind: "custom" }, chambers: [{ name: "Stale setup" }] }] as CitadelStructureChange[]) {
    assert.throws(() => mutate(initial, change), isConflict);
  }
  assert.deepEqual(repo.getStructureSnapshot(initial.citadelId), created);
  // A real NOT NULL failure after the Charter and first Chamber were written.
  assert.throws(() => mutate(created, { type: "setup", charter: { purpose: "Must roll back", kind: "company" }, chambers: [{ name: "Must roll back" }, { name: null as never }] }), /null|constraint/i);
  assert.deepEqual(repo.getStructureSnapshot(initial.citadelId), created, "a failed setup must leave no partial writes");
  const otherChamber = repo.createChamber({ citadelId: "other-structure", name: "Foreign" });
  assert.throws(() => mutate(created, { type: "charter", charter: { purpose: "Cross scope", kind: "custom", defaultChamberId: otherChamber.chamberId } }), ValidationError);
  assert.deepEqual(repo.getStructureSnapshot(initial.citadelId), created);
  const edited = mutate(created, charterChange("Edited"));
  const repeated = mutate(edited, charterChange("Edited"));
  const returned = mutate(repeated, charterChange("Original"));
  assert.notEqual(edited.revision, repeated.revision, "same-value saves consume the review");
  assert.notEqual(returned.revision, created.revision, "ABA cannot revive a consumed review");
  assert.ok(returned.charter!.updatedAt > repeated.charter!.updatedAt);
  const added = mutate(returned, { type: "chamber", chamber: { name: "Reviewed addition" } });
  assert.equal(added.chambers.length, 2);
  assert.throws(() => mutate(returned, charterChange("Missed Chamber")), isConflict);
  const profile = repo.createRecord({ name: "Structure Review" });
  assert.equal(profile.citadelId, initial.citadelId);
  assert.throws(() => mutate(added, charterChange("Missed profile")), isConflict);
  const withProfile = repo.getStructureSnapshot(initial.citadelId);
  repo.updateRecord(profile.citadelId, { expectedRevision: profile.revision, description: "New profile" });
  assert.throws(() => mutate(withProfile, charterChange("Stale profile")), isConflict);
  const beforeArchive = repo.getStructureSnapshot(initial.citadelId);
  const archived = repo.archiveRecord(profile.citadelId, repo.getRecord(profile.citadelId).revision);
  assert.throws(() => mutate(beforeArchive, charterChange("Missed archive")), isConflict);
  const archivedStructure = repo.getStructureSnapshot(initial.citadelId);
  assert.throws(() => mutate(archivedStructure, charterChange("Archived")), (error: unknown) => error instanceof ConflictError && error.details?.reason === "CITADEL_ARCHIVED");
  repo.restoreRecord(profile.citadelId, archived.revision);
  assert.throws(() => mutate(archivedStructure, charterChange("Missed restore")), isConflict);
  const restored = repo.getStructureSnapshot(initial.citadelId);
  const retry = mutate(restored, charterChange("Explicit reviewed retry"));
  assert.equal(retry.charter?.purpose, "Explicit reviewed retry");
  assert.equal(repo.getRecord(profile.citadelId).revision, restored.record!.revision, "Charter edits must not consume profile revisions");

  let armed = true;
  const delayed = new CitadelRepository({
    dialect: db.dialect, prepare: db.prepare.bind(db), exec: db.exec.bind(db), close: db.close.bind(db),
    transaction: (mode, callback) => {
      const saved = db.transaction(mode, callback);
      if (armed) {
        armed = false;
        mutate(repo.getStructureSnapshot(initial.citadelId), charterChange("Peer after commit"));
      }
      return saved;
    },
  });
  const acknowledged = delayed.mutateStructure({ citadelId: initial.citadelId, expectedRevision: retry.revision, change: charterChange("Own acknowledgement") });
  assert.equal(acknowledged.charter?.purpose, "Own acknowledgement");
  assert.equal(repo.getCharter(initial.citadelId)?.purpose, "Peer after commit");
  assert.notEqual(acknowledged.revision, repo.getStructureSnapshot(initial.citadelId).revision);
}

type Operation = "setup" | "charter" | "chamber" | "profile" | "archive";
type WriterResult = { outcome: "saved"; snapshot: CitadelStructureSnapshot } | { outcome: "conflict" };

export async function verifyCitadelStructureRaces(db: DatabaseClient, workerOptions: Record<string, unknown>): Promise<void> {
  const repo = new CitadelRepository(db);
  const cases: Array<{ empty?: boolean; operations: [Operation, Operation] }> = [
    { empty: true, operations: ["setup", "setup"] },
    { empty: true, operations: ["chamber", "charter"] },
    { operations: ["charter", "setup"] },
    { operations: ["setup", "chamber"] },
    { operations: ["chamber", "charter"] },
    { operations: ["profile", "setup"] },
    { operations: ["archive", "charter"] },
  ];
  for (const [index, scenario] of cases.entries()) {
    const citadelId = `structure-race-${index}`;
    if (!scenario.empty) {
      repo.createRecord({ name: `Structure Race ${index}` });
      repo.upsertCharter({ citadelId, purpose: "Before race", kind: "custom" });
    }
    const base = repo.getStructureSnapshot(citadelId);
    const results = await raceWriters(db.dialect, workerOptions, base, scenario.operations);
    assert.equal(results[0]!.outcome, "saved");
    assert.equal(results[1]!.outcome, "conflict", `${scenario.operations.join(" / ")} must reject the consumed review`);
    const winner = results[0];
    assert.ok(winner?.outcome === "saved");
    assert.deepEqual(repo.getStructureSnapshot(citadelId), winner.snapshot);
    assert.notEqual(winner.snapshot.revision, base.revision);
  }
}

async function raceWriters(kind: DatabaseClient["dialect"], workerOptions: Record<string, unknown>, base: CitadelStructureSnapshot, operations: [Operation, Operation]): Promise<WriterResult[]> {
  const gate = new SharedArrayBuffer(12);
  const states = new Int32Array(gate);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = operations.map((operation, index) => new Worker(WORKER_SOURCE, { eval: true, workerData: {
    kind, workerOptions, base, operation, index, gate,
    tsxApiUrl: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
    repoUrl: new URL(`./citadel-repo${extension}`, import.meta.url).href,
    sqliteUrl: new URL(`./sqlite${extension}`, import.meta.url).href,
    postgresUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
  } }));
  const channels = workers.map((worker) => {
    const deferred = <T>() => {
      let resolve!: (value: T) => void; let reject!: (error: Error) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => undefined);
      return { promise, resolve, reject };
    };
    const ready = deferred<void>(), held = deferred<void>(), attempt = deferred<void>(), done = deferred<WriterResult>();
    const fail = (error: Error) => { for (const pending of [ready, held, attempt, done]) pending.reject(error); };
    worker.on("message", (message) => {
      if (message.type === "ready") ready.resolve();
      else if (message.type === "held") held.resolve();
      else if (message.type === "attempt") attempt.resolve();
      else if (message.type === "done") done.resolve(message.result);
      else if (message.type === "error") fail(new Error(message.error));
    });
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Structure writer exited ${code} before completing its protocol`)));
    return { ready, held, attempt, done, fail };
  });
  const timeout = setTimeout(() => { for (const channel of channels) channel.fail(new Error("Structure race timed out")); }, 45_000);
  const release = (slot: number) => { Atomics.store(states, slot, 1); Atomics.notify(states, slot); };
  try {
    await Promise.all(channels.map((channel) => channel.ready.promise));
    release(0);
    await channels[0]!.held.promise;
    release(1);
    await channels[1]!.attempt.promise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    release(2);
    return await Promise.all(channels.map((channel) => channel.done.promise));
  } finally {
    clearTimeout(timeout); release(0); release(1); release(2);
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData: d } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(d.tsxApiUrl);
  const { CitadelRepository } = await tsImport(d.repoUrl, d.repoUrl);
  const db = d.kind === "sqlite"
    ? (await tsImport(d.sqliteUrl, d.repoUrl)).createDatabase(d.workerOptions)
    : new (await tsImport(d.postgresUrl, d.repoUrl)).PostgresSyncDatabaseClient(d.workerOptions);
  let armed = false; let result;
  try {
    const wrapped = { dialect: db.dialect, exec: db.exec.bind(db), close: db.close.bind(db), transaction: db.transaction.bind(db),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith("SELECT * FROM citadel_records WHERE citadel_id = ?")) return statement;
        return { run: statement.run.bind(statement), all: statement.all.bind(statement), get(...args) {
          const row = statement.get(...args);
          if (armed && d.index === 0) {
            armed = false; parentPort.postMessage({ type: "held" });
            if (Atomics.wait(new Int32Array(d.gate), 2, 0, 40_000) === "timed-out") throw new Error("Structure lock release timed out");
          }
          return row;
        } };
      },
    };
    const repo = new CitadelRepository(wrapped);
    if (repo.getStructureSnapshot(d.base.citadelId).revision !== d.base.revision) throw new Error("Writers did not review the same structure");
    parentPort.postMessage({ type: "ready" });
    if (Atomics.wait(new Int32Array(d.gate), d.index, 0, 40_000) === "timed-out") throw new Error("Writer start timed out");
    parentPort.postMessage({ type: "attempt" }); armed = true;
    try {
      const charter = { purpose: "Writer " + d.index, kind: "custom" };
      let snapshot;
      if (d.operation === "profile" || d.operation === "archive") {
        if (d.operation === "profile") repo.updateRecord(d.base.citadelId, { expectedRevision: d.base.record.revision, name: "Profile winner" });
        else repo.archiveRecord(d.base.citadelId, d.base.record.revision);
        snapshot = repo.getStructureSnapshot(d.base.citadelId);
      } else {
        const change = d.operation === "charter" ? { type: "charter", charter }
          : d.operation === "chamber" ? { type: "chamber", chamber: { name: "Winner chamber" } }
          : { type: "setup", charter, chambers: [{ name: "Winner setup" }] };
        snapshot = repo.mutateStructure({ citadelId: d.base.citadelId, expectedRevision: d.base.revision, change });
      }
      result = { outcome: "saved", snapshot };
    } catch (error) {
      if (error.code !== "WRITE_CONFLICT" || error.details?.reason !== "CITADEL_STRUCTURE_REVISION_CONFLICT") throw error;
      result = { outcome: "conflict" };
    }
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

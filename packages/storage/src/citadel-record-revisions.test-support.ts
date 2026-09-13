import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ConflictError, ValidationError, type CitadelRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CitadelRepository } from "./citadel-repo.js";

const isRevisionConflict = (error: unknown) => error instanceof ConflictError
  && error.code === "WRITE_CONFLICT" && error.details?.reason === "CITADEL_RECORD_REVISION_CONFLICT";

export function verifyCitadelRecordRevisions(db: DatabaseClient): void {
  const repo = new CitadelRepository(db);
  const now = "2090-01-01T00:00:00.000Z";
  const initial = repo.createRecord({ name: "Reviewed Citadel", description: "Retained description", defaultWorkspaceId: "default" }, now);
  const other = repo.createRecord({ name: "Other Citadel" }, now);
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(initial.revision, other.revision);
  assert.equal(repo.findRecord(initial.citadelId)?.revision, initial.revision);
  assert.equal(repo.findRecordBySlug(initial.slug)?.revision, initial.revision);
  const charter = repo.upsertCharter({ citadelId: initial.citadelId, purpose: "Preserve the charter", kind: "custom" });
  const chamber = repo.createChamber({ citadelId: initial.citadelId, name: "Private chamber", sealed: true });
  const listed = repo.listRecords("all").find((record) => record.citadelId === initial.citadelId)!;
  assert.equal(listed.hasCharter, true);
  assert.equal(listed.revision, initial.revision, "derived charter presence must not invalidate profile reviews");
  for (const expectedRevision of [undefined, null, "", "invalid", 7]) {
    assert.throws(() => repo.updateRecord(initial.citadelId, { expectedRevision: expectedRevision as never }), ValidationError);
    assert.throws(() => repo.archiveRecord(initial.citadelId, expectedRevision as never), ValidationError);
    assert.throws(() => repo.restoreRecord(initial.citadelId, expectedRevision as never), ValidationError);
  }
  assert.throws(() => repo.updateRecord(initial.citadelId, { expectedRevision: other.revision, name: "Wrong record" }), isRevisionConflict);
  assert.deepEqual(repo.getRecord(initial.citadelId), initial);
  const edited = repo.updateRecord(initial.citadelId, { expectedRevision: initial.revision, name: "Edited Citadel" }, "2000-01-01T00:00:00.000Z");
  assert.equal(edited.updatedAt, "2090-01-01T00:00:00.001Z");
  assert.equal(edited.defaultWorkspaceId, initial.defaultWorkspaceId);
  assert.equal(edited.description, initial.description);
  assert.throws(() => repo.updateRecord(initial.citadelId, { expectedRevision: initial.revision, description: "Lost winner" }), isRevisionConflict);
  assert.throws(() => repo.archiveRecord(initial.citadelId, initial.revision), isRevisionConflict);
  assert.throws(() => repo.restoreRecord(initial.citadelId, initial.revision), isRevisionConflict);
  assert.deepEqual(repo.getRecord(initial.citadelId), edited);
  const repeated = repo.updateRecord(initial.citadelId, { expectedRevision: edited.revision, name: edited.name }, now);
  assert.notEqual(repeated.revision, edited.revision, "same-value saves still consume their review");
  const returned = repo.updateRecord(initial.citadelId, { expectedRevision: repeated.revision, name: initial.name }, now);
  assert.notEqual(returned.revision, initial.revision, "an ABA edit cannot revive an old review");
  assert.throws(() => db.transaction("immediate", () => {
    repo.updateRecord(initial.citadelId, { expectedRevision: returned.revision, description: "Must roll back" });
    throw new Error("injected profile rollback");
  }), /injected profile rollback/);
  assert.deepEqual(repo.getRecord(initial.citadelId), returned);
  const archived = repo.archiveRecord(initial.citadelId, returned.revision, now);
  assert.equal(archived.lifecycleStatus, "archived");
  assert.deepEqual(repo.archiveRecord(initial.citadelId, archived.revision), archived);
  assert.throws(() => repo.archiveRecord(initial.citadelId, returned.revision), isRevisionConflict);
  const restored = repo.restoreRecord(initial.citadelId, archived.revision, now);
  assert.equal(restored.lifecycleStatus, "active");
  assert.deepEqual(repo.restoreRecord(initial.citadelId, restored.revision), restored);
  assert.throws(() => repo.restoreRecord(initial.citadelId, archived.revision), isRevisionConflict);
  assert.deepEqual(repo.getCharter(initial.citadelId), charter);
  assert.deepEqual(repo.listChambers(initial.citadelId), [chamber]);
  assert.deepEqual(repo.getRecord(other.citadelId), other);
  assert.throws(() => repo.createRecord({ name: other.name }), (error: unknown) => error instanceof ConflictError && error.code === "ALREADY_EXISTS");
  assert.throws(() => repo.updateRecord(initial.citadelId, { expectedRevision: restored.revision, slug: other.slug }), ConflictError);
  assert.deepEqual(repo.getRecord(initial.citadelId), restored);

  // A peer commits immediately after the transaction. The response must still
  // acknowledge this transaction, not re-read and acknowledge the peer instead.
  let armed = true;
  const delayed = new CitadelRepository({
    dialect: db.dialect, prepare: db.prepare.bind(db), exec: db.exec.bind(db), close: db.close.bind(db),
    transaction: (mode, callback) => {
      const saved = db.transaction(mode, callback);
      if (armed) {
        armed = false;
        repo.updateRecord(initial.citadelId, { expectedRevision: repo.getRecord(initial.citadelId).revision, description: "Peer after commit" });
      }
      return saved;
    },
  });
  const acknowledged = delayed.updateRecord(initial.citadelId, { expectedRevision: restored.revision, description: "This writer" });
  assert.equal(acknowledged.description, "This writer");
  assert.equal(repo.getRecord(initial.citadelId).description, "Peer after commit");
  assert.notEqual(acknowledged.revision, repo.getRecord(initial.citadelId).revision);
}

type Operation = "update" | "archive" | "restore";
type WriterResult = { outcome: "saved"; record: CitadelRecord } | { outcome: "conflict" };

export async function verifyCitadelRecordRaces(db: DatabaseClient, workerOptions: Record<string, unknown>): Promise<void> {
  const repo = new CitadelRepository(db);
  const pairs: [Operation, Operation][] = [["update", "update"], ["update", "archive"], ["update", "restore"], ["archive", "archive"], ["restore", "restore"]];
  for (const [index, operations] of pairs.entries()) {
    let base = repo.createRecord({ name: `Race Citadel ${index}`, description: "Keep this description" });
    if (operations.includes("restore")) base = repo.archiveRecord(base.citadelId, base.revision);
    const results = await raceCitadelRecords(db.dialect, workerOptions, base, operations);
    assert.equal(results[0]!.outcome, "saved");
    assert.equal(results[1]!.outcome, "conflict", `the blocked ${operations[1]} must reject the consumed review`);
    const winner = results[0];
    assert.ok(winner?.outcome === "saved");
    assert.deepEqual(repo.getRecord(base.citadelId), winner.record);
    assert.notEqual(winner.record.revision, base.revision);
    assert.equal(winner.record.description, base.description);
  }
}

async function raceCitadelRecords(kind: DatabaseClient["dialect"], workerOptions: Record<string, unknown>, base: CitadelRecord, operations: [Operation, Operation]): Promise<WriterResult[]> {
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
    worker.on("exit", (code) => { fail(new Error(`Citadel writer exited ${code} before completing its protocol`)); });
    return { ready, held, attempt, done, fail };
  });
  const timeout = setTimeout(() => { for (const channel of channels) channel.fail(new Error("Citadel concurrency proof timed out")); }, 45_000);
  const release = (slot: number) => { Atomics.store(states, slot, 1); Atomics.notify(states, slot); };
  try {
    // Both connections finish migrations before the first writer takes its lock.
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
            armed = false;
            parentPort.postMessage({ type: "held" });
            if (Atomics.wait(new Int32Array(d.gate), 2, 0, 40_000) === "timed-out") throw new Error("Row-lock release timed out");
          }
          return row;
        } };
      },
    };
    const repo = new CitadelRepository(wrapped);
    if (repo.getRecord(d.base.citadelId).revision !== d.base.revision) throw new Error("Writers did not review the same profile");
    parentPort.postMessage({ type: "ready" });
    if (Atomics.wait(new Int32Array(d.gate), d.index, 0, 40_000) === "timed-out") throw new Error("Writer start timed out");
    parentPort.postMessage({ type: "attempt" }); armed = true;
    try {
      const record = d.operation === "update"
        ? repo.updateRecord(d.base.citadelId, { expectedRevision: d.base.revision, name: d.base.name + " writer " + d.index })
        : d.operation === "archive" ? repo.archiveRecord(d.base.citadelId, d.base.revision) : repo.restoreRecord(d.base.citadelId, d.base.revision);
      result = { outcome: "saved", record };
    } catch (error) {
      if (error.code !== "WRITE_CONFLICT" || error.details?.reason !== "CITADEL_RECORD_REVISION_CONFLICT") throw error;
      result = { outcome: "conflict" };
    }
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ConflictError, NotFoundError, ValidationError, type IntegrationConnection } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";
import { createIntegrationConnectionRevisionSchema, INTEGRATION_CONNECTION_REVISION_POSTGRES_SQL } from "./integration-connection-revision-schema.js";

const input = { catalogId: "productivity.github", kind: "productivity" as const, key: "github", label: "Reviewed", config: { apiKey: "synthetic-original", owner: "fixture" } };
const isConflict = (error: unknown) => error instanceof ConflictError && error.details?.reason === "INTEGRATION_CONNECTION_REVISION_CONFLICT";

export function verifyIntegrationConnectionRevisions(db: DatabaseClient): void {
  const repo = new IntegrationConnectionRepository(db);
  const initial = repo.create(input, "2026-09-13T00:00:00.000Z");
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.equal(repo.get(initial.connectionId).revision, initial.revision);
  assert.equal(repo.list().find(item => item.connectionId === initial.connectionId)?.revision, initial.revision);
  assert.notEqual(repo.create(input).revision, initial.revision);
  for (const expectedRevision of [null, "", "bad", 7]) {
    assert.throws(() => repo.update(initial.connectionId, { expectedRevision: expectedRevision as never, label: "Rejected" }), ValidationError);
    assert.throws(() => repo.delete(initial.connectionId, expectedRevision as never), ValidationError);
  }
  assert.deepEqual(repo.get(initial.connectionId), initial);
  // Even a timestamp collision and identical values consume the reviewed generation.
  let current = repo.update(initial.connectionId, { expectedRevision: initial.revision, ...input }, initial.updatedAt);
  assert.ok(current.updatedAt > initial.updatedAt);
  assert.notEqual(current.revision, initial.revision);
  assert.throws(() => repo.update(initial.connectionId, { expectedRevision: initial.revision, label: "Stale" }), isConflict);
  assert.throws(() => repo.delete(initial.connectionId, initial.revision), isConflict);
  const beforeSecret = current;
  current = repo.update(current.connectionId, { config: { ...current.config, apiKey: "synthetic-new" } });
  assert.throws(() => repo.update(current.connectionId, { expectedRevision: beforeSecret.revision, config: beforeSecret.config }), isConflict);
  // The generation is independent of credential bytes, including on a migrated row.
  db.prepare("UPDATE integration_connections SET config_json = @config WHERE connection_id = @id").run({ id: current.connectionId, config: JSON.stringify({ ...current.config, apiKey: "synthetic-direct-fixture" }) });
  assert.equal(repo.get(current.connectionId).revision, current.revision);
  current = repo.update(current.connectionId, { expectedRevision: current.revision, ...input });
  assert.notEqual(current.revision, initial.revision, "A-B-A must not revive an old review");
  const beforeFailure = repo.get(current.connectionId);
  const failing = new IntegrationConnectionRepository({ dialect: db.dialect, close: db.close.bind(db), exec: db.exec.bind(db), transaction: db.transaction.bind(db), prepare(sql) {
    const stmt = db.prepare(sql);
    return sql.startsWith("INSERT INTO integration_connection_revisions")
      ? { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt), run: () => { throw new Error("Counter write failed"); } } : stmt;
  } });
  const count = repo.list().length;
  assert.throws(() => failing.create(input), /Counter write failed/);
  assert.equal(repo.list().length, count);
  assert.throws(() => failing.update(current.connectionId, { expectedRevision: current.revision, label: "Rollback" }), /Counter write failed/);
  assert.throws(() => failing.delete(current.connectionId, current.revision), /Counter write failed/);
  assert.deepEqual(repo.get(current.connectionId), beforeFailure);
  let armed = true;
  const delayed = new IntegrationConnectionRepository({ dialect: db.dialect, close: db.close.bind(db), exec: db.exec.bind(db), prepare: db.prepare.bind(db), transaction(mode, callback) {
    const result = db.transaction(mode, callback);
    if (armed) { armed = false; repo.update(current.connectionId, { label: "Peer after commit" }); }
    return result;
  } });
  const acknowledged = delayed.update(current.connectionId, { expectedRevision: current.revision, label: "Own acknowledgement" });
  assert.equal(acknowledged.label, "Own acknowledgement");
  assert.equal(repo.get(current.connectionId).label, "Peer after commit");
  assert.notEqual(acknowledged.revision, repo.get(current.connectionId).revision);
  current = repo.get(current.connectionId);
  repo.delete(current.connectionId, current.revision);
  assert.throws(() => repo.delete(current.connectionId, current.revision), NotFoundError);
  assert.throws(() => repo.update(current.connectionId, { expectedRevision: current.revision, label: "Deleted" }), NotFoundError);
  assert.equal(repo.delete(current.connectionId), false);
  assert.ok(db.prepare("SELECT generation FROM integration_connection_revisions WHERE connection_id = ?").get(current.connectionId), "retain the deletion generation");
  const legacy = repo.create(input);
  const fields = (record: IntegrationConnection) => ({ ...record, revision: undefined });
  const beforeMigration = repo.list().map(fields);
  db.exec("DROP TABLE integration_connection_revisions");
  if (db.dialect === "postgres") db.exec(INTEGRATION_CONNECTION_REVISION_POSTGRES_SQL);
  else createIntegrationConnectionRevisionSchema(db);
  assert.deepEqual(repo.list().map(fields), beforeMigration);
  assert.equal(db.prepare("SELECT count(*) AS count FROM integration_connection_revisions").get<{ count: number }>()?.count, 0);
  const migrated = repo.get(legacy.connectionId);
  assert.equal(repo.update(migrated.connectionId, { expectedRevision: migrated.revision, label: "First migrated write" }).label, "First migrated write");
}

type Operation = "update" | "delete" | "primitive";
type WriterResult = { outcome: "saved"; connection?: IntegrationConnection } | { outcome: "conflict" | "missing" };

export async function verifyIntegrationConnectionRaces(db: DatabaseClient, workerOptions: Record<string, unknown>): Promise<void> {
  const repo = new IntegrationConnectionRepository(db);
  const pairs: [Operation, Operation][] = [["update", "update"], ["update", "delete"], ["delete", "update"], ["delete", "delete"], ["primitive", "update"]];
  for (const operations of pairs) {
    const base = repo.create(input);
    const results = await raceWriters(db.dialect, workerOptions, base, operations);
    assert.equal(results[0]!.outcome, "saved");
    assert.equal(results[1]!.outcome, operations[0] === "delete" ? "missing" : "conflict", operations.join(" / "));
    assert.ok(results[0]?.outcome === "saved");
    if (results[0].connection) assert.deepEqual(repo.get(base.connectionId), results[0].connection);
    else assert.throws(() => repo.get(base.connectionId), NotFoundError);
  }
}

async function raceWriters(kind: DatabaseClient["dialect"], workerOptions: Record<string, unknown>, base: IntegrationConnection, operations: [Operation, Operation]): Promise<WriterResult[]> {
  const gate = new SharedArrayBuffer(12), states = new Int32Array(gate);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = operations.map((operation, index) => new Worker(WORKER_SOURCE, { eval: true, workerData: {
    kind, workerOptions, base, operation, index, gate,
    tsxApiUrl: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
    repoUrl: new URL(`./integration-connection-repo${extension}`, import.meta.url).href,
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
    worker.on("exit", (code) => fail(new Error(`Integration writer exited ${code} before completing its protocol`)));
    return { ready, held, attempt, done, fail };
  });
  const timeout = setTimeout(() => { for (const channel of channels) channel.fail(new Error("Integration race timed out")); }, 45_000);
  const release = (slot: number) => { Atomics.store(states, slot, 1); Atomics.notify(states, slot); };
  try {
    await Promise.all(channels.map((channel) => channel.ready.promise));
    release(0); await channels[0]!.held.promise;
    release(1); await channels[1]!.attempt.promise;
    await new Promise((resolve) => setTimeout(resolve, 300));
    release(2);
    return await Promise.all(channels.map((channel) => channel.done.promise));
  } finally { clearTimeout(timeout); release(0); release(1); release(2); await Promise.allSettled(workers.map(worker => worker.terminate())); }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData: d } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(d.tsxApiUrl);
  const { IntegrationConnectionRepository } = await tsImport(d.repoUrl, d.repoUrl);
  const db = d.kind === "sqlite" ? (await tsImport(d.sqliteUrl, d.repoUrl)).createDatabase(d.workerOptions)
    : new (await tsImport(d.postgresUrl, d.repoUrl)).PostgresSyncDatabaseClient(d.workerOptions);
  let armed = false; let result;
  try {
    const wrapped = { dialect: db.dialect, exec: db.exec.bind(db), close: db.close.bind(db), transaction: db.transaction.bind(db), prepare(sql) {
      const stmt = db.prepare(sql);
      if (!sql.includes("WHERE c.connection_id = ?")) return stmt;
      return { run: stmt.run.bind(stmt), all: stmt.all.bind(stmt), get(...args) {
        const row = stmt.get(...args);
        if (armed && d.index === 0) {
          armed = false; parentPort.postMessage({ type: "held" });
          if (Atomics.wait(new Int32Array(d.gate), 2, 0, 40_000) === "timed-out") throw new Error("Integration lock release timed out");
        }
        return row;
      } };
    } };
    const repo = new IntegrationConnectionRepository(wrapped);
    if (repo.get(d.base.connectionId).revision !== d.base.revision) throw new Error("Writers did not review the same connection");
    parentPort.postMessage({ type: "ready" });
    if (Atomics.wait(new Int32Array(d.gate), d.index, 0, 40_000) === "timed-out") throw new Error("Writer start timed out");
    parentPort.postMessage({ type: "attempt" }); armed = true;
    try {
      let connection;
      if (d.operation === "delete") repo.delete(d.base.connectionId, d.base.revision);
      else connection = repo.update(d.base.connectionId, { expectedRevision: d.operation === "primitive" ? undefined : d.base.revision, label: "Writer " + d.index, config: { apiKey: "synthetic-writer-" + d.index } });
      result = { outcome: "saved", connection };
    } catch (error) {
      if (error.code === "ENTITY_NOT_FOUND") result = { outcome: "missing" };
      else if (error.code === "WRITE_CONFLICT" && error.details?.reason === "INTEGRATION_CONNECTION_REVISION_CONFLICT") result = { outcome: "conflict" };
      else throw error;
    }
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch(error => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

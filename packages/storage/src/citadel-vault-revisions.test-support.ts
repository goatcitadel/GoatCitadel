import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ConflictError, NotFoundError, ValidationError, type CitadelVaultSnapshot, type CitadelVaultMutation } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CitadelRepository } from "./citadel-repo.js";
import { createCitadelVaultRevisionSchema, CITADEL_VAULT_REVISION_POSTGRES_SQL } from "./citadel-vault-revision-schema.js";

const sealedValue = { iv: "synthetic-iv", ciphertext: "synthetic-ciphertext", tag: "synthetic-tag" };
const storeChange = (secretName: string): CitadelVaultMutation["change"] => ({ type: "store", secretName, sealedValue });
const isConflict = (error: unknown) => error instanceof ConflictError && error.details?.reason === "CITADEL_VAULT_REVISION_CONFLICT";

export function verifyCitadelVaultRevisions(db: DatabaseClient): void {
  const repo = new CitadelRepository(db);
  const initial = repo.getVaultSnapshot("vault-review");
  const mutate = (base: CitadelVaultSnapshot, change: CitadelVaultMutation["change"]) => repo.mutateVault({ citadelId: base.citadelId, expectedRevision: base.revision, change });
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(initial.revision, repo.getVaultSnapshot("foreign").revision);
  assert.equal(db.prepare("SELECT count(*) AS count FROM citadel_vault_revisions").get<{ count: number }>()?.count, 0);
  for (const revision of [undefined, null, "", "bad", 7]) {
    assert.throws(() => repo.mutateVault({ citadelId: initial.citadelId, expectedRevision: revision as never, change: storeChange("Rejected") }), ValidationError);
  }
  let current = mutate(initial, storeChange("Reviewed"));
  const original = current.items[0]!;
  for (const change of [storeChange("Stale"), { type: "delete", secretId: original.secretId }] as CitadelVaultMutation["change"][]) {
    assert.throws(() => mutate(initial, change), isConflict);
  }
  current = mutate(current, storeChange("Reviewed"));
  assert.equal(current.items[0]!.secretId, original.secretId);
  assert.equal(current.items[0]!.createdAt, original.createdAt);
  assert.ok(current.items[0]!.updatedAt > original.updatedAt);
  assert.doesNotMatch(JSON.stringify(current), /synthetic-|ciphertext|sealedValue/);
  // A direct fixture-only ciphertext change cannot influence the metadata digest.
  db.prepare("UPDATE citadel_vault_secrets SET sealed_value_json = @value WHERE secret_id = @id")
    .run({ value: JSON.stringify({ ...sealedValue, ciphertext: "synthetic-other" }), id: original.secretId });
  assert.deepEqual(repo.getVaultSnapshot(initial.citadelId), current);
  const foreign = repo.storeVaultSecret({ citadelId: "foreign", secretName: "Foreign", sealedValue });
  for (const secretId of [foreign.secretId, "missing"]) assert.throws(() => mutate(current, { type: "delete", secretId }), NotFoundError);
  assert.deepEqual(repo.getVaultSnapshot(initial.citadelId), current);
  assert.equal(repo.getVaultSecret(initial.citadelId, foreign.secretId), undefined);
  current = mutate(current, { type: "delete", secretId: original.secretId });
  assert.deepEqual(current.items, initial.items);
  assert.notEqual(current.revision, initial.revision, "add/delete must not revive an empty review");
  const raw = repo.storeVaultSecret({ citadelId: initial.citadelId, secretName: "Raw", sealedValue });
  assert.throws(() => mutate(current, storeChange("Stale raw")), isConflict);
  current = repo.getVaultSnapshot(initial.citadelId);
  repo.deleteVaultSecret(initial.citadelId, raw.secretId);
  assert.throws(() => mutate(current, storeChange("Stale raw delete")), isConflict);
  current = repo.getVaultSnapshot(initial.citadelId);
  const profile = repo.createRecord({ citadelId: initial.citadelId, name: "Vault review" });
  assert.throws(() => mutate(current, storeChange("Changed profile")), isConflict);
  current = repo.getVaultSnapshot(initial.citadelId);
  const archived = repo.archiveRecord(initial.citadelId, profile.revision);
  assert.throws(() => mutate(current, storeChange("Changed archive")), isConflict);
  assert.throws(() => mutate(repo.getVaultSnapshot(initial.citadelId), storeChange("Archived")), (error: unknown) => error instanceof ConflictError && error.details?.reason === "CITADEL_ARCHIVED");
  repo.restoreRecord(initial.citadelId, archived.revision);
  current = repo.getVaultSnapshot(initial.citadelId);
  const access = repo.getAccessSnapshot(initial.citadelId);
  current = mutate(current, storeChange("Explicit retry"));
  assert.deepEqual(repo.getAccessSnapshot(initial.citadelId), access);

  const failing = new CitadelRepository({ dialect: db.dialect, exec: db.exec.bind(db), close: db.close.bind(db), transaction: db.transaction.bind(db),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return sql.startsWith("INSERT INTO citadel_vault_revisions") ? { get: statement.get.bind(statement), all: statement.all.bind(statement), run: () => { throw new Error("Counter write failed"); } } : statement;
    },
  });
  for (const change of [storeChange("Rollback"), { type: "delete", secretId: current.items[0]!.secretId }] as CitadelVaultMutation["change"][]) {
    assert.throws(() => failing.mutateVault({ citadelId: initial.citadelId, expectedRevision: current.revision, change }), /Counter write failed/);
    assert.deepEqual(repo.getVaultSnapshot(initial.citadelId), current);
  }
  let depth = 0, armed = true;
  const delayed = new CitadelRepository({ dialect: db.dialect, prepare: db.prepare.bind(db), exec: db.exec.bind(db), close: db.close.bind(db), transaction: (mode, callback) => {
    depth += 1; let saved;
    try { saved = db.transaction(mode, callback); } finally { depth -= 1; }
    if (armed && depth === 0) { armed = false; repo.storeVaultSecret({ citadelId: initial.citadelId, secretName: "Peer after commit", sealedValue }); }
    return saved;
  } });
  const acknowledged = delayed.mutateVault({ citadelId: initial.citadelId, expectedRevision: current.revision, change: storeChange("Own acknowledgement") });
  assert.ok(acknowledged.items.some((item) => item.secretName === "Own acknowledgement"));
  assert.ok(!acknowledged.items.some((item) => item.secretName === "Peer after commit"));
  assert.notEqual(acknowledged.revision, repo.getVaultSnapshot(initial.citadelId).revision);
  const beforeMigration = { snapshot: repo.getVaultSnapshot(initial.citadelId), sealed: repo.listVaultSecrets(initial.citadelId) };
  db.exec("DROP TABLE citadel_vault_revisions");
  if (db.dialect === "postgres") db.exec(CITADEL_VAULT_REVISION_POSTGRES_SQL);
  else createCitadelVaultRevisionSchema(db);
  assert.deepEqual(repo.listVaultSecrets(initial.citadelId), beforeMigration.sealed);
  current = repo.getVaultSnapshot(initial.citadelId);
  assert.deepEqual({ ...current, revision: undefined }, { ...beforeMigration.snapshot, revision: undefined });
  assert.equal(db.prepare("SELECT count(*) AS count FROM citadel_vault_revisions").get<{ count: number }>()?.count, 0);
  assert.ok(mutate(current, storeChange("First migrated write")).items.some((item) => item.secretName === "First migrated write"));
}

type Operation = "store" | "delete" | "primitive" | "archive" | "profile";
type WriterResult = { outcome: "saved"; snapshot: CitadelVaultSnapshot } | { outcome: "conflict" };

export async function verifyCitadelVaultRaces(db: DatabaseClient, workerOptions: Record<string, unknown>): Promise<void> {
  const repo = new CitadelRepository(db);
  const pairs: [Operation, Operation][] = [["store", "store"], ["store", "delete"], ["delete", "store"], ["primitive", "store"], ["archive", "store"], ["profile", "store"]];
  for (const [index, operations] of pairs.entries()) {
    const citadelId = "vault-race-" + index;
    if (index > 0) repo.createRecord({ citadelId, name: "Vault race " + index });
    if (index > 0) repo.storeVaultSecret({ citadelId, secretName: "Seed", sealedValue });
    const before = repo.getVaultSnapshot(citadelId);
    const results = await raceWriters(db.dialect, workerOptions, before, operations);
    assert.equal(results[0]!.outcome, "saved");
    assert.equal(results[1]!.outcome, "conflict", operations.join(" / "));
    assert.ok(results[0]?.outcome === "saved");
    assert.deepEqual(repo.getVaultSnapshot(citadelId), results[0].snapshot);
  }
}

async function raceWriters(kind: DatabaseClient["dialect"], workerOptions: Record<string, unknown>, base: CitadelVaultSnapshot, operations: [Operation, Operation]): Promise<WriterResult[]> {
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
    worker.on("exit", (code) => fail(new Error(`Vault writer exited ${code} before completing its protocol`)));
    return { ready, held, attempt, done, fail };
  });
  const timeout = setTimeout(() => { for (const channel of channels) channel.fail(new Error("Vault race timed out")); }, 45_000);
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
            if (Atomics.wait(new Int32Array(d.gate), 2, 0, 40_000) === "timed-out") throw new Error("Vault lock release timed out");
          }
          return row;
        } };
      },
    };
    const repo = new CitadelRepository(wrapped);
    if (repo.getVaultSnapshot(d.base.citadelId).revision !== d.base.revision) throw new Error("Writers did not review the same vault");
    parentPort.postMessage({ type: "ready" });
    if (Atomics.wait(new Int32Array(d.gate), d.index, 0, 40_000) === "timed-out") throw new Error("Writer start timed out");
    parentPort.postMessage({ type: "attempt" }); armed = true;
    try {
      let snapshot;
      const sealedValue = { iv: "synthetic-iv", ciphertext: "synthetic-ciphertext", tag: "synthetic-tag" };
      if (d.operation === "archive" || d.operation === "profile" || d.operation === "primitive") {
        if (d.operation === "archive") repo.archiveRecord(d.base.citadelId, d.base.record.revision);
        else if (d.operation === "profile") repo.updateRecord(d.base.citadelId, { expectedRevision: d.base.record.revision, name: "Peer profile" });
        else repo.storeVaultSecret({ citadelId: d.base.citadelId, secretName: "Seed", sealedValue });
        snapshot = repo.getVaultSnapshot(d.base.citadelId);
      } else {
        const change = d.operation === "delete" ? { type: "delete", secretId: d.base.items[0].secretId }
          : { type: "store", secretName: d.base.items[0]?.secretName ?? "Seed", sealedValue };
        snapshot = repo.mutateVault({ citadelId: d.base.citadelId, expectedRevision: d.base.revision, change });
      }
      result = { outcome: "saved", snapshot };
    } catch (error) {
      if (error.code !== "WRITE_CONFLICT" || error.details?.reason !== "CITADEL_VAULT_REVISION_CONFLICT") throw error;
      result = { outcome: "conflict" };
    }
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

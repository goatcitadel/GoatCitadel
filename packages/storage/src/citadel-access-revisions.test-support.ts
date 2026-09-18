import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ConflictError, NotFoundError, ValidationError, type CitadelAccessSnapshot, type CitadelAccessChange } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CitadelRepository } from "./citadel-repo.js";
import { createCitadelAccessRevisionSchema, CITADEL_ACCESS_REVISION_POSTGRES_SQL } from "./citadel-access-revision-schema.js";

const isConflict = (error: unknown) => error instanceof ConflictError && error.details?.reason === "CITADEL_ACCESS_REVISION_CONFLICT";
const wardChange = (name: string): CitadelAccessChange => ({ type: "add_ward", ward: { name, actionPattern: "shell.*", effect: "deny" } });

export function verifyCitadelAccessRevisions(db: DatabaseClient): void {
  const repo = new CitadelRepository(db);
  const initial = repo.getAccessSnapshot("access-review");
  const mutate = (base: CitadelAccessSnapshot, change: CitadelAccessChange) => repo.mutateAccess({ citadelId: base.citadelId, expectedRevision: base.revision, change });
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(initial.revision, repo.getAccessSnapshot("foreign").revision);
  assert.equal(db.prepare("SELECT count(*) AS count FROM citadel_access_revisions").get<{ count: number }>()?.count, 0, "reads must not create revision rows");
  for (const revision of [undefined, null, "", "bad", 7]) {
    assert.throws(() => repo.mutateAccess({ citadelId: initial.citadelId, expectedRevision: revision as never, change: wardChange("Rejected") }), ValidationError);
  }
  let current = mutate(initial, wardChange("Reviewed"));
  const changes: CitadelAccessChange[] = [
    { type: "assign_agent", assignment: { agentId: "agent" } }, { type: "unassign_agent", agentId: "agent" },
    wardChange("Stale"), { type: "remove_ward", wardId: current.wards[0]!.wardId },
    { type: "create_passage", passage: { destinationCitadelId: "foreign", allowedFields: ["availability"] } }, { type: "remove_passage", passageId: "missing" },
    { type: "upsert_member", member: { subjectId: "alice", role: "viewer" } }, { type: "remove_member", subjectId: "alice" },
    { type: "add_integration", integration: { provider: "calendar", capabilities: ["read"], mode: "read" } }, { type: "remove_integration", grantId: "missing" },
  ];
  for (const change of changes) assert.throws(() => mutate(initial, change), isConflict);
  assert.deepEqual(repo.getAccessSnapshot(initial.citadelId), current);
  current = mutate(current, { type: "remove_ward", wardId: current.wards[0]!.wardId });
  assert.deepEqual(current.wards, initial.wards);
  assert.notEqual(current.revision, initial.revision, "add/remove must not revive the empty review");
  assert.throws(() => mutate(initial, wardChange("ABA")), isConflict);
  const foreign = repo.addWard({ citadelId: "foreign", name: "Foreign", actionPattern: "*", effect: "deny" });
  for (const change of [
    { type: "unassign_agent", agentId: "missing" }, { type: "remove_ward", wardId: foreign.wardId },
    { type: "remove_passage", passageId: "missing" }, { type: "remove_member", subjectId: "missing" }, { type: "remove_integration", grantId: "missing" },
  ] as CitadelAccessChange[]) assert.throws(() => mutate(current, change), NotFoundError);
  assert.deepEqual(repo.getAccessSnapshot(initial.citadelId), current, "missing or foreign removals must not consume the review");
  const foreignChamber = repo.createChamber({ citadelId: "foreign", name: "Private" });
  assert.throws(() => mutate(current, { type: "create_passage", passage: { sourceChamberId: foreignChamber.chamberId, destinationCitadelId: "foreign", allowedFields: [] } }), ValidationError);
  assert.throws(() => mutate(current, { type: "upsert_member", member: { subjectId: "bad", role: null as never } }), /null|constraint/i);
  assert.deepEqual(repo.getAccessSnapshot(initial.citadelId), current);

  // Every trusted primitive participates, including writes that return to the same visible state.
  const id = initial.citadelId;
  let assignment = repo.assignAgent({ citadelId: id, agentId: "agent" });
  let ward = repo.addWard({ citadelId: id, name: "Rule", actionPattern: "*", effect: "deny" });
  let passage = repo.createPassage({ sourceCitadelId: id, destinationCitadelId: "foreign", allowedFields: [] });
  repo.upsertMember({ citadelId: id, subjectId: "alice", role: "viewer" });
  let grant = repo.addIntegrationGrant({ citadelId: id, provider: "calendar", capabilities: [], mode: "read" });
  const writes = [
    () => { assignment = repo.assignAgent({ citadelId: id, agentId: assignment.agentId }); },
    () => repo.unassignAgent(id, assignment.agentId),
    () => { ward = repo.addWard({ citadelId: id, name: "Rule", actionPattern: "*", effect: "deny" }); },
    () => repo.removeWard(id, ward.wardId),
    () => { passage = repo.createPassage({ sourceCitadelId: id, destinationCitadelId: "foreign", allowedFields: [] }); },
    () => repo.removePassage(id, passage.passageId),
    () => repo.upsertMember({ citadelId: id, subjectId: "alice", role: "viewer" }),
    () => repo.removeMember(id, "alice"),
    () => { grant = repo.addIntegrationGrant({ citadelId: id, provider: "calendar", capabilities: [], mode: "read" }); },
    () => repo.removeIntegrationGrant(id, grant.grantId),
  ];
  for (const write of writes) {
    const before = repo.getAccessSnapshot(id); write();
    assert.throws(() => mutate(before, wardChange("Primitive stale")), isConflict);
  }
  current = repo.getAccessSnapshot(id);
  repo.storeVaultSecret({ citadelId: id, secretName: "synthetic", sealedValue: { iv: "fixture-iv", ciphertext: "fixture-ciphertext", tag: "fixture-tag" } });
  assert.deepEqual(repo.getAccessSnapshot(id), current, "Vault values and metadata stay outside this nonsecret review");
  assert.doesNotMatch(JSON.stringify(current), /fixture-ciphertext|sealedValue|secretName/);
  const profile = repo.createRecord({ citadelId: id, name: "Access review" });
  assert.throws(() => mutate(current, wardChange("Profile changed")), isConflict);
  current = repo.getAccessSnapshot(id);
  repo.upsertCharter({ citadelId: id, purpose: "Changed policy context", kind: "custom" });
  assert.throws(() => mutate(current, wardChange("Charter changed")), isConflict);
  current = repo.getAccessSnapshot(id);
  const archived = repo.archiveRecord(id, profile.revision);
  assert.throws(() => mutate(current, wardChange("Archive changed")), isConflict);
  assert.throws(() => mutate(repo.getAccessSnapshot(id), wardChange("Archived")), (error: unknown) => error instanceof ConflictError && error.details?.reason === "CITADEL_ARCHIVED");
  repo.restoreRecord(id, archived.revision);
  current = repo.getAccessSnapshot(id);
  const structure = repo.getStructureSnapshot(id);
  current = mutate(current, wardChange("Explicit retry"));
  assert.deepEqual(repo.getStructureSnapshot(id), structure, "access writes must not consume the profile or structure review");

  // A failure after the row write but before the counter write rolls everything back.
  const failing = new CitadelRepository({ ...db, dialect: db.dialect, exec: db.exec.bind(db), close: db.close.bind(db), transaction: db.transaction.bind(db),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return sql.startsWith("INSERT INTO citadel_access_revisions") ? { ...statement, get: statement.get.bind(statement), all: statement.all.bind(statement), run: () => { throw new Error("Counter write failed"); } } : statement;
    },
  });
  assert.throws(() => failing.mutateAccess({ citadelId: id, expectedRevision: current.revision, change: wardChange("Must roll back") }), /Counter write failed/);
  assert.deepEqual(repo.getAccessSnapshot(id), current);
  let depth = 0, armed = true;
  const delayed = new CitadelRepository({ dialect: db.dialect, prepare: db.prepare.bind(db), exec: db.exec.bind(db), close: db.close.bind(db), transaction: (mode, callback) => {
    depth += 1; let saved;
    try { saved = db.transaction(mode, callback); } finally { depth -= 1; }
    if (armed && depth === 0) { armed = false; repo.addWard({ citadelId: id, name: "Peer after commit", actionPattern: "*", effect: "deny" }); }
    return saved;
  } });
  const acknowledged = delayed.mutateAccess({ citadelId: id, expectedRevision: current.revision, change: wardChange("Own acknowledgement") });
  assert.ok(acknowledged.wards.some((item) => item.name === "Own acknowledgement"));
  assert.ok(!acknowledged.wards.some((item) => item.name === "Peer after commit"));
  assert.notEqual(acknowledged.revision, repo.getAccessSnapshot(id).revision);

  // Reapply the new additive migration to populated legacy tables in this owned fixture.
  const beforeMigration = { ...repo.getAccessSnapshot(id), vault: repo.listVaultSecrets(id) };
  db.exec("DROP TABLE citadel_access_revisions");
  if (db.dialect === "postgres") db.exec(CITADEL_ACCESS_REVISION_POSTGRES_SQL);
  else createCitadelAccessRevisionSchema(db);
  const afterMigration = { ...repo.getAccessSnapshot(id), vault: repo.listVaultSecrets(id) };
  assert.deepEqual({ ...afterMigration, revision: undefined }, { ...beforeMigration, revision: undefined });
  assert.equal(db.prepare("SELECT count(*) AS count FROM citadel_access_revisions").get<{ count: number }>()?.count, 0);
  assert.equal(mutate(afterMigration, wardChange("First migrated write")).wards.at(-1)?.name, "First migrated write");
}

type Operation = "ward" | "member" | "council" | "passage" | "integration" | "primitive" | "archive" | "charter";
type WriterResult = { outcome: "saved"; snapshot: CitadelAccessSnapshot } | { outcome: "conflict" };

export async function verifyCitadelAccessRaces(db: DatabaseClient, workerOptions: Record<string, unknown>): Promise<void> {
  const repo = new CitadelRepository(db);
  const pairs: [Operation, Operation][] = [["ward", "member"], ["member", "ward"], ["council", "ward"], ["passage", "ward"], ["integration", "ward"], ["primitive", "ward"], ["archive", "ward"], ["charter", "ward"]];
  for (const [index, operations] of pairs.entries()) {
    const citadelId = "access-race-" + index;
    if (index > 0) repo.createRecord({ citadelId, name: "Access race " + index });
    const before = repo.getAccessSnapshot(citadelId);
    const results = await raceWriters(db.dialect, workerOptions, before, operations);
    assert.equal(results[0]!.outcome, "saved");
    assert.equal(results[1]!.outcome, "conflict", operations.join(" / "));
    assert.ok(results[0]?.outcome === "saved");
    assert.deepEqual(repo.getAccessSnapshot(citadelId), results[0].snapshot);
  }
}

async function raceWriters(kind: DatabaseClient["dialect"], workerOptions: Record<string, unknown>, base: CitadelAccessSnapshot, operations: [Operation, Operation]): Promise<WriterResult[]> {
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
    worker.on("exit", (code) => fail(new Error(`Access writer exited ${code} before completing its protocol`)));
    return { ready, held, attempt, done, fail };
  });
  const timeout = setTimeout(() => { for (const channel of channels) channel.fail(new Error("Access race timed out")); }, 45_000);
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
            if (Atomics.wait(new Int32Array(d.gate), 2, 0, 40_000) === "timed-out") throw new Error("Access lock release timed out");
          }
          return row;
        } };
      },
    };
    const repo = new CitadelRepository(wrapped);
    if (repo.getAccessSnapshot(d.base.citadelId).revision !== d.base.revision) throw new Error("Writers did not review the same access");
    parentPort.postMessage({ type: "ready" });
    if (Atomics.wait(new Int32Array(d.gate), d.index, 0, 40_000) === "timed-out") throw new Error("Writer start timed out");
    parentPort.postMessage({ type: "attempt" }); armed = true;
    try {
      let snapshot;
      if (d.operation === "archive") {
        repo.archiveRecord(d.base.citadelId, d.base.structure.record.revision);
        snapshot = repo.getAccessSnapshot(d.base.citadelId);
      } else if (d.operation === "charter" || d.operation === "primitive") {
        if (d.operation === "charter") repo.upsertCharter({ citadelId: d.base.citadelId, purpose: "Peer policy", kind: "custom" });
        else repo.addWard({ citadelId: d.base.citadelId, name: "Primitive winner", actionPattern: "*", effect: "deny" });
        snapshot = repo.getAccessSnapshot(d.base.citadelId);
      } else {
        const change = d.operation === "council" ? { type: "assign_agent", assignment: { agentId: "agent" } }
          : d.operation === "member" ? { type: "upsert_member", member: { subjectId: "alice", role: "viewer" } }
          : d.operation === "passage" ? { type: "create_passage", passage: { destinationCitadelId: "foreign", allowedFields: [] } }
          : d.operation === "integration" ? { type: "add_integration", integration: { provider: "calendar", mode: "read", capabilities: [] } }
          : { type: "add_ward", ward: { name: "Writer " + d.index, actionPattern: "*", effect: "deny" } };
        snapshot = repo.mutateAccess({ citadelId: d.base.citadelId, expectedRevision: d.base.revision, change });
      }
      result = { outcome: "saved", snapshot };
    } catch (error) {
      if (error.code !== "WRITE_CONFLICT" || error.details?.reason !== "CITADEL_ACCESS_REVISION_CONFLICT") throw error;
      result = { outcome: "conflict" };
    }
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

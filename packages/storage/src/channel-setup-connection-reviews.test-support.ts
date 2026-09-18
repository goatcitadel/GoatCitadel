import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ChannelSetupDraftRepository } from "./channel-setup-draft-repo.js";
import { IntegrationConnectionRepository } from "./integration-connection-repo.js";
import { CHANNEL_SETUP_CONNECTION_REVIEW_POSTGRES_SQL, createChannelSetupConnectionReviewSchema } from "./channel-setup-connection-review-schema.js";

function fixture(db: DatabaseClient) {
  const drafts = new ChannelSetupDraftRepository(db), connections = new IntegrationConnectionRepository(db);
  const connection = connections.create({ catalogId: "channel.telegram", kind: "channel", key: "telegram", label: "Original", config: { botToken: "synthetic-old", defaultChatId: "fixture" } });
  const draft = drafts.create({ catalogId: connection.catalogId, connectionId: connection.connectionId, connectionRevision: connection.revision, lifecycleMode: "repair", label: "Local draft", enabled: true, draft: { defaultChatId: "local" }, contentVersion: "1", adapterVersion: "1", validationVersion: "1", testVersion: "1" });
  const input = { ...connection, label: "Finalized", config: { botToken: "synthetic-new", defaultChatId: "local" }, lastSyncAt: "2026-09-13T00:00:00.000Z" };
  return { drafts, connections, connection, draft, input };
}

export function verifyChannelSetupConnectionReviews(db: DatabaseClient): void {
  const f = fixture(db);
  assert.equal(f.drafts.get(f.draft.draftId).connectionRevision, f.connection.revision);
  const updated = f.drafts.update(f.draft.draftId, { expectedRevision: f.draft.revision, label: "Saved draft" });
  assert.equal(updated.connectionRevision, f.connection.revision);
  assert.equal(f.drafts.listByConnection(f.connection.connectionId)[0]?.connectionRevision, f.connection.revision);
  assert.throws(() => f.drafts.finalizeConnection(f.draft.draftId, f.draft.revision, f.input), ConflictError);
  assert.deepEqual(f.connections.get(f.connection.connectionId), f.connection);
  const peer = f.connections.update(f.connection.connectionId, { expectedRevision: f.connection.revision, config: { botToken: "peer", allowedUserIds: ["peer-only"] } });
  assert.throws(() => f.drafts.finalizeConnection(updated.draftId, updated.revision, f.input), ConflictError);
  assert.deepEqual(f.connections.get(peer.connectionId), peer);
  assert.deepEqual(f.drafts.get(updated.draftId), updated);
  const reviewed = f.drafts.update(updated.draftId, { expectedRevision: updated.revision, connectionRevision: peer.revision });
  const finalized = f.drafts.finalizeConnection(reviewed.draftId, reviewed.revision, f.input);
  assert.equal(finalized.label, "Finalized"); assert.notEqual(finalized.revision, peer.revision);
  assert.equal(finalized.lastSyncAt, f.input.lastSyncAt);
  assert.throws(() => f.drafts.get(reviewed.draftId), NotFoundError);
  assert.throws(() => f.drafts.finalizeConnection(reviewed.draftId, reviewed.revision, f.input), NotFoundError);

  const legacy = fixture(db);
  db.prepare("UPDATE channel_setup_drafts SET connection_revision = NULL WHERE draft_id = ?").run(legacy.draft.draftId);
  assert.equal(legacy.drafts.get(legacy.draft.draftId).connectionRevision, undefined);
  assert.throws(() => legacy.drafts.finalizeConnection(legacy.draft.draftId, legacy.draft.revision, legacy.input), ConflictError);
  assert.deepEqual(legacy.connections.get(legacy.connection.connectionId), legacy.connection);
  legacy.connections.delete(legacy.connection.connectionId, legacy.connection.revision);
  const stale = legacy.drafts.update(legacy.draft.draftId, { expectedRevision: legacy.draft.revision, connectionRevision: legacy.connection.revision });
  assert.throws(() => legacy.drafts.finalizeConnection(stale.draftId, stale.revision, legacy.input), NotFoundError);

  for (const creating of [false, true]) {
    const failed = fixture(db);
    if (creating) db.prepare("UPDATE channel_setup_drafts SET connection_id = NULL, connection_revision = NULL WHERE draft_id = ?").run(failed.draft.draftId);
    const input = { ...failed.input, connectionId: creating ? randomUUID() : failed.connection.connectionId };
    const fault = new ChannelSetupDraftRepository({ dialect: db.dialect, close: db.close.bind(db), exec: db.exec.bind(db), transaction: db.transaction.bind(db), prepare(sql) {
      const stmt = db.prepare(sql);
      return sql.startsWith("DELETE FROM channel_setup_drafts") ? { get: stmt.get.bind(stmt), all: stmt.all.bind(stmt), run() { throw new Error("Draft deletion failed"); } } : stmt;
    } });
    const before = failed.drafts.get(failed.draft.draftId);
    assert.throws(() => fault.finalizeConnection(before.draftId, before.revision, input), /Draft deletion failed/);
    assert.deepEqual(failed.drafts.get(before.draftId), before);
    assert.deepEqual(failed.connections.get(failed.connection.connectionId), failed.connection);
    if (creating) assert.throws(() => failed.connections.get(input.connectionId), NotFoundError);
  }
  const own = fixture(db);
  let depth = 0, armed = true;
  const delayed = new ChannelSetupDraftRepository({ dialect: db.dialect, close: db.close.bind(db), exec: db.exec.bind(db), prepare: db.prepare.bind(db), transaction(mode, callback) {
    depth += 1;
    let value;
    try { value = db.transaction(mode, callback); } finally { depth -= 1; }
    if (!depth && armed) { armed = false; own.connections.update(own.connection.connectionId, { label: "After commit" }); }
    return value;
  } });
  const ack = delayed.finalizeConnection(own.draft.draftId, own.draft.revision, own.input);
  assert.equal(ack.label, "Finalized");
  assert.equal(own.connections.get(own.connection.connectionId).label, "After commit");
  assert.notEqual(ack.revision, own.connections.get(own.connection.connectionId).revision);
  const migrated = fixture(db);
  const beforeUpgrade = { ...migrated.draft, connectionRevision: undefined };
  db.exec("ALTER TABLE channel_setup_drafts DROP COLUMN connection_revision");
  if (db.dialect === "postgres") db.exec(CHANNEL_SETUP_CONNECTION_REVIEW_POSTGRES_SQL);
  else createChannelSetupConnectionReviewSchema(db);
  assert.deepEqual(migrated.drafts.get(migrated.draft.draftId), beforeUpgrade);
  assert.deepEqual(migrated.connections.get(migrated.connection.connectionId), migrated.connection);
}

type Operation = "finalize" | "connection-edit" | "draft-edit" | "draft-delete";
export async function verifyChannelSetupConnectionRaces(db: DatabaseClient, workerOptions: Record<string, unknown>): Promise<void> {
  for (const operations of [["finalize", "finalize"], ["connection-edit", "finalize"], ["draft-edit", "finalize"], ["draft-delete", "finalize"], ["finalize", "draft-edit"]] as [Operation, Operation][]) {
    const f = fixture(db), gate = new SharedArrayBuffer(12), states = new Int32Array(gate);
    const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
    const result = { kind: db.dialect, workerOptions, draft: f.draft, connection: f.connection, input: f.input, gate,
      tsxApiUrl: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
      draftsUrl: new URL(`./channel-setup-draft-repo${extension}`, import.meta.url).href,
      connectionsUrl: new URL(`./integration-connection-repo${extension}`, import.meta.url).href,
      sqliteUrl: new URL(`./sqlite${extension}`, import.meta.url).href, postgresUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href };
    const workers = operations.map((operation, index) => new Worker(WORKER_SOURCE, { eval: true, workerData: { ...result, operation, index } }));
    const pending = workers.map(worker => {
      const promises = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void; promise: Promise<string> }>();
      for (const key of ["ready", "held", "attempt", "done"]) {
        let resolve!: (value: string) => void, reject!: (error: Error) => void;
        const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => undefined);
        promises.set(key, { resolve, reject, promise });
      }
      const fail = (error: Error) => { for (const value of promises.values()) value.reject(error); };
      worker.on("message", message => message.type === "error" ? fail(new Error(message.error)) : promises.get(message.type)?.resolve(message.outcome));
      worker.on("error", fail); worker.on("exit", code => fail(new Error(`Channel writer exited ${code}`)));
      return { wait: (key: string) => promises.get(key)!.promise, fail };
    });
    const release = (slot: number) => { Atomics.store(states, slot, 1); Atomics.notify(states, slot); };
    const timeout = setTimeout(() => pending.forEach(item => item.fail(new Error("Channel race timeout"))), 45_000);
    try {
      await Promise.all(pending.map(item => item.wait("ready")));
      release(0); await pending[0]!.wait("held"); release(1); await pending[1]!.wait("attempt");
      await new Promise(resolve => setTimeout(resolve, 100)); release(2);
      const outcomes = await Promise.all(pending.map(item => item.wait("done")));
      assert.deepEqual(outcomes, ["saved", operations[0] === "draft-delete" || operations[0] === "finalize" ? "missing" : "conflict"], operations.join(" / "));
      if (operations[0] === "finalize") assert.equal(f.connections.get(f.connection.connectionId).label, "Finalized");
      if (operations[0] === "connection-edit") assert.equal(f.connections.get(f.connection.connectionId).label, "Peer connection");
      if (operations[0] === "draft-edit") assert.equal(f.drafts.get(f.draft.draftId).label, "Peer draft");
    } finally { clearTimeout(timeout); release(0); release(1); release(2); await Promise.allSettled(workers.map(worker => worker.terminate())); }
  }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData: d } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(d.tsxApiUrl);
  const { ChannelSetupDraftRepository } = await tsImport(d.draftsUrl,d.draftsUrl);
  const { IntegrationConnectionRepository } = await tsImport(d.connectionsUrl,d.draftsUrl);
  const db = d.kind === "sqlite" ? (await tsImport(d.sqliteUrl,d.draftsUrl)).createDatabase(d.workerOptions) : new (await tsImport(d.postgresUrl,d.draftsUrl)).PostgresSyncDatabaseClient(d.workerOptions);
  let armed=false;
  const wrapped={ dialect:db.dialect, close:db.close.bind(db), exec:db.exec.bind(db), transaction:db.transaction.bind(db), prepare(sql) {
    const stmt=db.prepare(sql);
    const target=d.operation === "connection-edit" ? sql.includes("WHERE c.connection_id = ?") : sql === "SELECT * FROM channel_setup_drafts WHERE draft_id = ?";
    return !target ? stmt : { run:stmt.run.bind(stmt),all:stmt.all.bind(stmt),get(...args) {
      const value=stmt.get(...args);
      if(armed && d.index===0) { armed=false; parentPort.postMessage({type:"held"}); if(Atomics.wait(new Int32Array(d.gate),2,0,40000)==="timed-out") throw new Error("Held timeout"); }
      return value;
    } };
  } };
  try {
    const drafts=new ChannelSetupDraftRepository(wrapped), connections=new IntegrationConnectionRepository(wrapped);
    if(drafts.get(d.draft.draftId).revision!==d.draft.revision || connections.get(d.connection.connectionId).revision!==d.connection.revision) throw new Error("Mismatched review");
    parentPort.postMessage({type:"ready"});
    if(Atomics.wait(new Int32Array(d.gate),d.index,0,40000)==="timed-out") throw new Error("Start timeout");
    parentPort.postMessage({type:"attempt"}); armed=true;
    let outcome;
    try {
      if(d.operation==="finalize") drafts.finalizeConnection(d.draft.draftId,d.draft.revision,d.input);
      if(d.operation==="connection-edit") connections.update(d.connection.connectionId,{expectedRevision:d.connection.revision,label:"Peer connection"});
      if(d.operation==="draft-edit") drafts.update(d.draft.draftId,{expectedRevision:d.draft.revision,label:"Peer draft"});
      if(d.operation==="draft-delete") drafts.delete(d.draft.draftId,d.draft.revision);
      outcome="saved";
    } catch(error) { if(error.code==="WRITE_CONFLICT") outcome="conflict"; else if(error.code==="ENTITY_NOT_FOUND") outcome="missing"; else throw error; }
    parentPort.postMessage({type:"done",outcome});
  } finally { db.close(); }
})().catch(error => { parentPort.postMessage({type:"error",error:String(error.stack ?? error)}); process.exitCode=1; });
`;

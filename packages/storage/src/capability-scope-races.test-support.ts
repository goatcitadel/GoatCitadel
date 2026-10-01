import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { CapabilityScopeSelectionReview } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CapabilityScopeRepository } from "./capability-scope-repo.js";
import { CitadelRepository } from "./citadel-repo.js";
import { WorkspaceRepository } from "./workspace-repo.js";

type Operation = "reviewed" | "legacy" | "parent" | "archive-citadel" | "archive-workspace" | "reparent";
type Result = { outcome: "saved" | "conflict" };
export async function verifyCapabilityScopeRaces(db: DatabaseClient, workerOptions: Record<string, unknown>) {
  const repo = new CapabilityScopeRepository(db),
    citadels = new CitadelRepository(db),
    workspaces = new WorkspaceRepository(db);
  for (const operation of [
    "reviewed",
    "legacy",
    "parent",
    "archive-citadel",
    "archive-workspace",
    "reparent",
  ] as const) {
    const parent = citadels.createRecord({ name: `Scope race ${operation}` });
    const other = citadels.createRecord({ name: `Scope race other ${operation}` });
    const workspace = workspaces.create({ name: `Scope race ${operation}`, citadelId: parent.citadelId });
    const before = repo.getSelectionReview("workspace", workspace.workspaceId, "skill")!;
    const results = await race(db.dialect, workerOptions, before, operation, other.citadelId);
    assert.deepEqual(
      results,
      [{ outcome: "saved" }, { outcome: "conflict" }],
      `${operation} must serialize before a stale reviewed write`,
    );
    assert.notEqual(repo.getSelectionReview("workspace", workspace.workspaceId, "skill")?.revision, before.revision);
    assert.ok(!repo.list("workspace", workspace.workspaceId, "skill").some((row) => row.resourceRef === "second"));
  }
}

async function race(
  kind: DatabaseClient["dialect"],
  workerOptions: Record<string, unknown>,
  before: CapabilityScopeSelectionReview,
  operation: Operation,
  otherCitadelId: string,
): Promise<Result[]> {
  const gate = new SharedArrayBuffer(12),
    state = new Int32Array(gate);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = [0, 1].map(
    (index) =>
      new Worker(SOURCE, {
        eval: true,
        workerData: {
          index,
          kind,
          workerOptions,
          before,
          operation,
          otherCitadelId,
          gate,
          tsx: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
          scope: new URL(`./capability-scope-repo${extension}`, import.meta.url).href,
          citadel: new URL(`./citadel-repo${extension}`, import.meta.url).href,
          workspace: new URL(`./workspace-repo${extension}`, import.meta.url).href,
          sqlite: new URL(`./sqlite${extension}`, import.meta.url).href,
          postgres: new URL(`./postgres/sync${extension}`, import.meta.url).href,
        },
      }),
  );
  const channels = workers.map((worker) => {
    const deferred = <T>() => {
      let resolve!: (value: T) => void, reject!: (error: Error) => void;
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void promise.catch(() => undefined);
      return { promise, resolve, reject };
    };
    const ready = deferred<void>(),
      held = deferred<void>(),
      attempt = deferred<void>(),
      done = deferred<Result>();
    const fail = (error: Error) => {
      for (const pending of [ready, held, attempt, done]) pending.reject(error);
    };
    worker.on("message", (message) => {
      if (message.type === "ready") ready.resolve();
      else if (message.type === "held") held.resolve();
      else if (message.type === "attempt") attempt.resolve();
      else if (message.type === "done") done.resolve(message.result);
      else if (message.type === "error") fail(new Error(message.error));
    });
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Scope race worker exited ${code}`)));
    return { ready, held, attempt, done, fail };
  });
  const release = (slot: number) => {
    Atomics.store(state, slot, 1);
    Atomics.notify(state, slot);
  };
  const timeout = setTimeout(
    () => channels.forEach((channel) => channel.fail(new Error("Scope race timed out"))),
    45_000,
  );
  try {
    await Promise.all(channels.map((channel) => channel.ready.promise));
    release(0);
    await channels[0]!.held.promise;
    release(1);
    await channels[1]!.attempt.promise;
    await new Promise((resolve) => setTimeout(resolve, 150));
    release(2);
    return await Promise.all(channels.map((channel) => channel.done.promise));
  } finally {
    clearTimeout(timeout);
    release(0);
    release(1);
    release(2);
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

const SOURCE = String.raw`
const { parentPort, workerData: d } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(d.tsx);
  const db = d.kind === "sqlite" ? (await tsImport(d.sqlite, d.scope)).createDatabase(d.workerOptions)
    : new (await tsImport(d.postgres, d.scope)).PostgresSyncDatabaseClient(d.workerOptions);
  let armed = false, depth = 0;
  const wrapped = { dialect: db.dialect, prepare: db.prepare.bind(db), exec: db.exec.bind(db), close: db.close.bind(db),
    transaction(mode, callback) {
      return db.transaction(mode, () => {
        depth += 1;
        try {
          const result = callback();
          if (armed && depth === 1 && d.index === 0) {
            armed = false; parentPort.postMessage({ type: "held" });
            if (Atomics.wait(new Int32Array(d.gate), 2, 0, 40_000) === "timed-out") throw new Error("Scope release timed out");
          }
          return result;
        } finally { depth -= 1; }
      });
    },
  };
  let result;
  try {
    const repo = new (await tsImport(d.scope, d.scope)).CapabilityScopeRepository(wrapped);
    const citadels = new (await tsImport(d.citadel, d.scope)).CitadelRepository(wrapped);
    const workspaces = new (await tsImport(d.workspace, d.scope)).WorkspaceRepository(wrapped);
    if (repo.getSelectionReview("workspace", d.before.scopeId, "skill").revision !== d.before.revision) throw new Error("Different initial scope review");
    parentPort.postMessage({ type: "ready" });
    if (Atomics.wait(new Int32Array(d.gate), d.index, 0, 40_000) === "timed-out") throw new Error("Scope start timed out");
    parentPort.postMessage({ type: "attempt" }); armed = true;
    try {
      const action = d.index === 1 ? "reviewed" : d.operation;
      if (action === "reviewed") repo.replaceReviewed("workspace", d.before.scopeId, { resourceType: "skill", expectedRevision: d.before.revision,
        assignments: [{ resourceRef: d.index ? "second" : "first", enabled: true }] });
      else if (action === "legacy") repo.setEnabled("workspace", d.before.scopeId, "skill", "legacy", false);
      else if (action === "parent") repo.setEnabled("citadel", d.before.citadelId, "skill", "parent", false);
      else if (action === "archive-citadel") citadels.archiveRecord(d.before.citadelId, citadels.getRecord(d.before.citadelId).revision);
      else if (action === "archive-workspace") workspaces.archive(d.before.scopeId);
      else workspaces.update(d.before.scopeId, { citadelId: d.otherCitadelId });
      result = { outcome: "saved" };
    } catch (error) {
      if (error.code !== "WRITE_CONFLICT" || error.details?.reason !== "CAPABILITY_SCOPE_REVISION_CONFLICT") throw error;
      result = { outcome: "conflict" };
    }
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch(error => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

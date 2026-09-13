import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { PermissionProfileRepository } from "./permission-profile-repo.js";

export function profileInput(label = "Reviewed profile") {
  return { label, scope: "workspace" as const, scopeRef: "revision-workspace", approvalMode: "approve_all" as const,
    toolPatterns: ["session.status"], allow: ["session.status"], deny: ["shell.exec"], createdBy: "reviewer" };
}

export function verifyPermissionProfileRevisions(db: DatabaseClient): void {
  const repo = new PermissionProfileRepository(db);
  const now = "2026-09-13T00:00:00.000Z";
  const original = repo.createProfile(profileInput(), now);
  const other = repo.createProfile(profileInput(), now);
  assert.match(original.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(original.revision, other.revision);
  assert.equal(repo.listProfiles().find((profile) => profile.profileId === original.profileId)?.revision, original.revision);
  assert.throws(() => repo.updateProfile(original.profileId, { updatedBy: "reviewer", expectedRevision: undefined as never }), ValidationError);
  assert.throws(() => repo.archiveProfile(original.profileId, undefined as never), ValidationError);
  assert.throws(() => repo.updateProfile(original.profileId, { updatedBy: "reviewer", expectedRevision: other.revision, label: "wrong scope" }), ConflictError);
  const updated = repo.updateProfile(original.profileId, { updatedBy: "reviewer", expectedRevision: original.revision, label: "Changed" }, now);
  assert.equal(updated.updatedAt, "2026-09-13T00:00:00.001Z");
  assert.deepEqual(updated.deny, original.deny);
  assert.throws(() => repo.updateProfile(original.profileId, { updatedBy: "reviewer", expectedRevision: original.revision, deny: [] }), ConflictError);
  assert.throws(() => repo.archiveProfile(original.profileId, original.revision), ConflictError);
  const restored = repo.updateProfile(original.profileId, { updatedBy: "reviewer", expectedRevision: updated.revision, label: original.label }, now);
  assert.equal(restored.updatedAt, "2026-09-13T00:00:00.002Z");
  assert.notEqual(restored.revision, original.revision, "returning to identical values must not revive an old revision");
  assert.throws(() => db.transaction("immediate", () => {
    repo.updateProfile(original.profileId, { expectedRevision: restored.revision, updatedBy: "reviewer", label: "must roll back" });
    throw new Error("injected permission transaction failure");
  }), /injected permission transaction failure/);
  assert.deepEqual(repo.getProfile(original.profileId), restored);
  assert.equal(repo.archiveProfile(original.profileId, restored.revision, now), true);
  const archived = repo.getProfile(original.profileId);
  assert.equal(archived.status, "archived");
  assert.equal(archived.updatedAt, "2026-09-13T00:00:00.003Z");
  assert.throws(() => repo.updateProfile(original.profileId, { expectedRevision: archived.revision, updatedBy: "reviewer", label: "revive" }), ConflictError);
  assert.throws(() => repo.archiveProfile(original.profileId, archived.revision), ConflictError);
  assert.deepEqual(repo.getProfile(other.profileId), other);
  for (const builtin of repo.listProfiles().filter((profile) => profile.builtin)) {
    assert.throws(() => repo.updateProfile(builtin.profileId, { expectedRevision: builtin.revision, updatedBy: "reviewer" }), ConflictError);
    assert.throws(() => repo.archiveProfile(builtin.profileId, builtin.revision), ConflictError);
  }
}

type WriterResult = { outcome: "saved" | "conflict"; operation: "update" | "archive"; label: string };
export async function racePermissionProfileMutations(input: {
  kind: "sqlite" | "postgres"; workerOptions: Record<string, unknown>; profileId: string; expectedRevision: string; includeArchive?: boolean;
}): Promise<WriterResult[]> {
  const startGate = new SharedArrayBuffer(4);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = [0, 1].map((index) => new Worker(WORKER_SOURCE, { eval: true, workerData: {
    ...input, operation: input.includeArchive && index === 1 ? "archive" : "update", label: `writer-${index}`, startGate,
    tsxApiUrl: import.meta.resolve("tsx/esm/api"), repoUrl: new URL(`./permission-profile-repo${extension}`, import.meta.url).href,
    sqliteUrl: new URL(`./sqlite${extension}`, import.meta.url).href, postgresUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
  } }));
  const completions = workers.map((worker) => {
    let readyResolve!: () => void; let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise<WriterResult>((resolve, reject) => {
      const fail = (error: Error) => { readyReject(error); reject(error); };
      worker.on("message", (message) => {
        if (message.type === "ready") readyResolve();
        if (message.type === "done") resolve(message.result);
        if (message.type === "error") fail(new Error(message.error));
      });
      worker.on("error", fail);
      worker.on("exit", (code) => { if (code !== 0) fail(new Error(`Permission test worker exited ${code}`)); });
    });
    void done.catch(() => undefined);
    return { ready, done };
  });
  const deadline = setTimeout(() => { for (const worker of workers) void worker.terminate(); }, 45_000);
  try {
    await Promise.all(completions.map((completion) => completion.ready));
    Atomics.store(new Int32Array(startGate), 0, 1); Atomics.notify(new Int32Array(startGate), 0);
    return await Promise.all(completions.map((completion) => completion.done));
  } finally { clearTimeout(deadline); await Promise.allSettled(workers.map((worker) => worker.terminate())); }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(workerData.tsxApiUrl);
  const { PermissionProfileRepository } = await tsImport(workerData.repoUrl, workerData.repoUrl);
  const db = workerData.kind === "sqlite"
    ? (await tsImport(workerData.sqliteUrl, workerData.repoUrl)).createDatabase(workerData.workerOptions)
    : new (await tsImport(workerData.postgresUrl, workerData.repoUrl)).PostgresSyncDatabaseClient(workerData.workerOptions);
  try {
    const repo = new PermissionProfileRepository(db);
    if (repo.getProfile(workerData.profileId).revision !== workerData.expectedRevision) throw new Error("Writers did not observe the same profile revision");
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(new Int32Array(workerData.startGate), 0, 0, 40_000);
    let outcome = "saved";
    try {
      if (workerData.operation === "archive") repo.archiveProfile(workerData.profileId, workerData.expectedRevision);
      else repo.updateProfile(workerData.profileId, { expectedRevision: workerData.expectedRevision, updatedBy: "reviewer", label: workerData.label });
    } catch (error) {
      if (error.code !== "WRITE_CONFLICT") throw error;
      outcome = "conflict";
    }
    parentPort.postMessage({ type: "done", result: { outcome, operation: workerData.operation, label: workerData.label } });
  } finally { db.close(); }
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

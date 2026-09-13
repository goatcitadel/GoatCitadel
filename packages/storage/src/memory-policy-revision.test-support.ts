import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { ConflictError, ValidationError, type MemoryMaintenancePolicyValues } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { MemoryMaintenanceRepository } from "./memory-maintenance-repo.js";

export function policyDefaults(workspaceId = "policy-workspace"): MemoryMaintenancePolicyValues {
  return { workspaceId, enabled: false, runMode: "hybrid", timingStrategy: "fixed", timeZone: "UTC",
    minHoursSinceLastSuccess: 24, minChangedSessions: 3, executionTarget: "local", unavailableModelPolicy: "skip",
    createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" };
}

export function verifyMemoryPolicyRevisions(db: DatabaseClient): void {
  const repo = new MemoryMaintenanceRepository(db);
  const base = repo.ensurePolicy(policyDefaults());
  const other = repo.ensurePolicy(policyDefaults("other-workspace"));
  assert.match(base.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(base.revision, other.revision);
  assert.throws(() => repo.patchPolicy(base.workspaceId, { enabled: true }, undefined as never), ValidationError);
  assert.throws(() => repo.patchPolicy(base.workspaceId, { enabled: true }, other.revision), ConflictError);
  const changed = repo.patchPolicy(base.workspaceId, { minChangedSessions: 7 }, base.revision, base.updatedAt);
  assert.equal(changed.updatedAt, "2026-09-13T00:00:00.001Z");
  assert.throws(() => repo.patchPolicy(base.workspaceId, { enabled: true }, base.revision), ConflictError);
  assert.deepEqual(repo.ensurePolicy({ ...policyDefaults(), enabled: true }), changed);
  const back = repo.patchPolicy(base.workspaceId, { minChangedSessions: base.minChangedSessions }, changed.revision, base.createdAt);
  assert.equal(back.updatedAt, "2026-09-13T00:00:00.002Z");
  assert.notEqual(back.revision, base.revision, "an ABA settings change must not revive the original revision");
  const noop = repo.patchPolicy(base.workspaceId, {}, back.revision, base.createdAt);
  assert.notEqual(noop.revision, back.revision, "even identical submissions must consume the prior revision");
  assert.deepEqual(repo.requirePolicy(other.workspaceId), other);

  const recommendation = repo.createRecommendation({ workspaceId: base.workspaceId, kind: "threshold_adjustment", status: "queued",
    summary: "Change the threshold", proposedPatch: { minChangedSessions: 8 }, createdAt: base.createdAt, updatedAt: base.createdAt });
  assert.throws(() => repo.acceptRecommendation(recommendation.recommendationId, {
    expectedRevision: recommendation.revision, expectedPolicyRevision: base.revision,
  }), ConflictError);
  assert.deepEqual(repo.getRecommendation(recommendation.recommendationId), recommendation);
  assert.deepEqual(repo.requirePolicy(base.workspaceId), noop);
  const modified = repo.updateRecommendation({ ...recommendation, proposedPatch: { minChangedSessions: 9 } });
  assert.throws(() => repo.acceptRecommendation(recommendation.recommendationId, {
    expectedRevision: recommendation.revision, expectedPolicyRevision: noop.revision,
  }), ConflictError);

  // A real database failure in the second write must roll back the policy too.
  if (db.dialect === "postgres") {
    db.exec(`CREATE FUNCTION fail_memory_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected decision failure'; END $$;
      CREATE TRIGGER fail_memory_decision BEFORE UPDATE ON memory_maintenance_recommendations FOR EACH ROW EXECUTE FUNCTION fail_memory_decision()`);
  } else db.exec("CREATE TRIGGER fail_memory_decision BEFORE UPDATE ON memory_maintenance_recommendations BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END");
  try {
    assert.throws(() => repo.acceptRecommendation(modified.recommendationId, {
      expectedRevision: modified.revision, expectedPolicyRevision: noop.revision,
    }), /injected decision failure/);
    assert.deepEqual(repo.requirePolicy(base.workspaceId), noop);
    assert.deepEqual(repo.getRecommendation(modified.recommendationId), modified);
  } finally {
    db.exec(db.dialect === "postgres"
      ? "DROP TRIGGER fail_memory_decision ON memory_maintenance_recommendations; DROP FUNCTION fail_memory_decision()"
      : "DROP TRIGGER fail_memory_decision");
  }
  const applied = repo.acceptRecommendation(modified.recommendationId, {
    expectedRevision: modified.revision, expectedPolicyRevision: noop.revision,
  });
  assert.equal(applied.policy.minChangedSessions, 9);
  assert.equal(applied.recommendation.status, "applied");
  assert.throws(() => repo.rejectRecommendation(modified.recommendationId, { expectedRevision: modified.revision }), ConflictError);
  assert.throws(() => repo.rejectRecommendation(modified.recommendationId, { expectedRevision: applied.recommendation.revision }), ConflictError);
  assert.deepEqual(repo.requirePolicy(base.workspaceId), applied.policy);
}

/** Independent connections synchronize immediately before their writes, using one reviewed revision. */
export async function raceMemoryPolicySaves(input: {
  kind: "sqlite" | "postgres"; workerOptions: Record<string, unknown>; workspaceId: string; expectedRevision: string;
}): Promise<Array<{ outcome: string; reason?: string; enabled?: boolean; threshold?: number }>> {
  const startGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = [false, true].map((enabled) => new Worker(WORKER_SOURCE, { eval: true, workerData: {
    ...input, enabled, startGate, tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    repoUrl: new URL(`./memory-maintenance-repo${extension}`, import.meta.url).href,
    sqliteUrl: new URL(`./sqlite${extension}`, import.meta.url).href,
    postgresUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
  } }));
  const completions = workers.map((worker) => {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const done = new Promise<{ outcome: string; reason?: string; enabled?: boolean; threshold?: number }>((resolve, reject) => {
      worker.on("message", (message) => {
        if (message.type === "ready") resolveReady();
        if (message.type === "done") resolve(message.result);
        if (message.type === "error") { const error = new Error(message.error); rejectReady(error); reject(error); }
      });
      worker.on("error", (error) => { rejectReady(error); reject(error); });
      worker.on("exit", (code) => { if (code !== 0) { const error = new Error(`Policy test worker exited ${code}`); rejectReady(error); reject(error); } });
    });
    // A worker can fail before the start barrier; consume both rejection paths immediately.
    void done.catch(() => undefined);
    return { ready, done };
  });
  const deadline = setTimeout(() => { for (const worker of workers) void worker.terminate(); }, 45_000);
  try {
    await Promise.all(completions.map((item) => item.ready));
    Atomics.store(new Int32Array(startGate), 0, 1);
    Atomics.notify(new Int32Array(startGate), 0);
    return await Promise.all(completions.map((item) => item.done));
  } finally {
    clearTimeout(deadline);
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(workerData.tsxApiUrl);
  const { MemoryMaintenanceRepository } = await tsImport(workerData.repoUrl, workerData.repoUrl);
  const db = workerData.kind === "sqlite"
    ? (await tsImport(workerData.sqliteUrl, workerData.repoUrl)).createDatabase(workerData.workerOptions)
    : new (await tsImport(workerData.postgresUrl, workerData.repoUrl)).PostgresSyncDatabaseClient(workerData.workerOptions);
  try {
    const repo = new MemoryMaintenanceRepository(db);
    const observed = repo.requirePolicy(workerData.workspaceId);
    if (observed.revision !== workerData.expectedRevision) throw new Error("Workers did not read the same base revision");
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(new Int32Array(workerData.startGate), 0, 0, 40_000);
    let result;
    try {
      const saved = repo.patchPolicy(workerData.workspaceId, { enabled: workerData.enabled, minChangedSessions: workerData.enabled ? 11 : 13 }, workerData.expectedRevision);
      result = { outcome: "saved", enabled: saved.enabled, threshold: saved.minChangedSessions };
    } catch (error) {
      if (error.code !== "STATE_CONFLICT") throw error;
      result = { outcome: "conflict", reason: error.details?.reason };
    }
    parentPort.postMessage({ type: "done", result });
  } finally { db.close(); }
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { PersonalityCatalogResponse, PersonalityPresetMutationInput } from "@goatcitadel/contracts";
import type { DatabaseClient } from "@goatcitadel/storage";
import { SystemSettingsRepository } from "@goatcitadel/storage";
import { PersonalityCatalogService } from "./channel-personalities.js";

const KEY = "personality.catalog.v1";
const conflict = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "WRITE_CONFLICT");

export async function verifyPersonalityRevisions(db: DatabaseClient): Promise<void> {
  const settings = new SystemSettingsRepository(db);
  const service = new PersonalityCatalogService(settings as never);
  const initial = await service.getCatalog();
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.equal(settings.get(KEY), undefined, "catalog reads cannot initialize mutable state");
  for (const call of [
    () => service.createPersonality({ label: "Missing review" } as never),
    () => service.updatePersonality("operator", { label: "Missing review" } as never),
    () => service.deletePersonality("operator", undefined as never),
    () => service.setDefaultPersonality("operator", "invalid"),
  ]) await assert.rejects(call, /expected revision/);
  assert.equal(settings.get(KEY), undefined);
  const created = await service.createPersonality({ expectedRevision: initial.revision, id: "custom-proof", label: "Custom proof", systemOverlay: "Be clear." });
  for (const call of [
    () => service.createPersonality({ expectedRevision: initial.revision, label: "Stale create" }),
    () => service.updatePersonality("operator", { expectedRevision: initial.revision, label: "Stale edit" }),
    () => service.deletePersonality("custom-proof", initial.revision),
    () => service.deletePersonality("operator", initial.revision),
    () => service.setDefaultPersonality("teacher", initial.revision),
  ]) await assert.rejects(call, conflict);
  assert.deepEqual(await service.getCatalog(), created, "all stale operations preserve the entire catalog");
  const selected = await service.setDefaultPersonality("custom-proof", created.revision);
  const renamed = await service.updatePersonality("custom-proof", { expectedRevision: selected.revision, id: "renamed-proof" });
  assert.equal(renamed.defaultPersonalityId, "renamed-proof");
  assert.equal(renamed.items.some((item) => item.id === "custom-proof"), false);
  const deleted = await service.deletePersonality("renamed-proof", renamed.revision);
  assert.equal(deleted.defaultPersonalityId, "default");
  await assert.rejects(() => service.deletePersonality("renamed-proof", renamed.revision), conflict);

  // Existing data is preserved and even a future-dated legacy row advances.
  const legacy = { defaultPersonalityId: "teacher", builtinOverrides: { operator: { id: "operator", label: "Legacy operator" } },
    customPresets: [{ id: "legacy-custom", label: "Legacy custom", systemOverlay: "Preserve these instructions." }] };
  settings.set(KEY, legacy, "2090-01-01T00:00:00.000Z");
  const old = await service.getCatalog();
  assert.deepEqual(settings.get(KEY)?.value, legacy, "read-only normalization cannot rewrite legacy data");
  const first = await service.setDefaultPersonality("teacher", old.revision);
  assert.equal(settings.get(KEY)?.updatedAt, "2090-01-01T00:00:00.001Z");
  const repeated = await service.setDefaultPersonality("teacher", first.revision);
  assert.equal(settings.get(KEY)?.updatedAt, "2090-01-01T00:00:00.002Z");
  assert.notEqual(repeated.revision, first.revision, "same-value writes cannot revive a consumed revision");
  const changed = await service.setDefaultPersonality("operator", repeated.revision);
  const restored = await service.setDefaultPersonality("teacher", changed.revision);
  await assert.rejects(() => service.setDefaultPersonality("operator", repeated.revision), conflict);
  assert.equal(restored.items.find((item) => item.id === "legacy-custom")?.systemOverlay, "Preserve these instructions.");
  assert.equal(restored.items.find((item) => item.id === "operator")?.label, "Legacy operator");

  // A peer commits after this writer's CAS; the first acknowledgement remains its own.
  const peer = new PersonalityCatalogService(settings as never);
  const delayed = new PersonalityCatalogService({ get: settings.get.bind(settings),
    compareAndSet: async (...args: Parameters<SystemSettingsRepository["compareAndSet"]>) => {
      const saved = settings.compareAndSet(...args);
      if (saved) await peer.setDefaultPersonality("technical", (await peer.getCatalog()).revision);
      return saved;
    } } as never);
  const acknowledged = await delayed.setDefaultPersonality("operator", restored.revision);
  assert.equal(acknowledged.defaultPersonalityId, "operator");
  assert.equal((await service.getCatalog()).defaultPersonalityId, "technical");
  assert.notEqual(acknowledged.revision, (await service.getCatalog()).revision);
}

interface PersonalityWriter {
  kind: "create" | "update" | "delete" | "default";
  id?: string;
  input?: PersonalityPresetMutationInput;
}

export async function verifyPersonalityRaces(db: DatabaseClient, dialect: "sqlite" | "postgres", options: Record<string, unknown>): Promise<void> {
  const settings = new SystemSettingsRepository(db);
  const service = new PersonalityCatalogService(settings as never);
  const scenarios: Array<{ name: string; writers: [PersonalityWriter, PersonalityWriter]; empty?: boolean }> = [
    { name: "initial creation", empty: true, writers: [{ kind: "create", input: { id: "first", label: "First" } }, { kind: "create", input: { id: "second", label: "Second" } }] },
    { name: "independent edits", writers: [{ kind: "update", id: "operator", input: { label: "Edited operator" } }, { kind: "update", id: "teacher", input: { label: "Edited teacher" } }] },
    { name: "rename and default", writers: [{ kind: "update", id: "custom", input: { id: "renamed" } }, { kind: "default", id: "operator" }] },
    { name: "delete and edit", writers: [{ kind: "delete", id: "custom" }, { kind: "update", id: "custom", input: { label: "Edited custom" } }] },
    { name: "reset and edit", writers: [{ kind: "delete", id: "operator" }, { kind: "update", id: "operator", input: { label: "Edited operator" } }] },
    { name: "competing defaults", writers: [{ kind: "default", id: "operator" }, { kind: "default", id: "teacher" }] },
  ];
  settings.set("personality-proof-unrelated", { keep: true });
  for (const scenario of scenarios) {
    // The caller owns this disposable database/schema; reset only this fixture key.
    db.prepare("DELETE FROM system_settings WHERE setting_key = ?").run(KEY);
    if (!scenario.empty) settings.set(KEY, { defaultPersonalityId: "custom", customPresets: [{ id: "custom", label: "Custom" }],
      builtinOverrides: { operator: { id: "operator", label: "Override" } } });
    const review = await service.getCatalog();
    const results = await raceWriters(dialect, options, review.revision, scenario.writers);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["conflict", "saved"], scenario.name);
    const winner = results.find((result) => result.outcome === "saved")!;
    assert.deepEqual(await service.getCatalog(), winner.catalog, `${scenario.name}: loser cannot erase any part of the winning catalog`);
    assert.deepEqual(settings.get("personality-proof-unrelated")?.value, { keep: true });
  }
}

async function raceWriters(dialect: string, options: Record<string, unknown>, expectedRevision: string, writers: PersonalityWriter[]) {
  const startGate = new SharedArrayBuffer(4);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers = writers.map((writer) => new Worker(WORKER, { eval: true, workerData: { dialect, options, expectedRevision, writer, startGate,
    tsxApiUrl: pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href,
    serviceUrl: new URL(`./channel-personalities${extension}`, import.meta.url).href,
    settingsUrl: new URL(`../../../../packages/storage/src/system-settings-repo${extension}`, import.meta.url).href,
    sqliteUrl: new URL(`../../../../packages/storage/src/sqlite${extension}`, import.meta.url).href,
    postgresUrl: new URL(`../../../../packages/storage/src/postgres/sync${extension}`, import.meta.url).href,
  } }));
  const completions = workers.map((worker) => {
    let readyResolve!: () => void; let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise<{ outcome: string; catalog?: PersonalityCatalogResponse }>((resolve, reject) => {
      let completed = false;
      const fail = (error: Error) => { readyReject(error); reject(error); };
      worker.on("message", (message) => {
        if (message.type === "ready") readyResolve();
        if (message.type === "done") { completed = true; resolve(message.result); }
        if (message.type === "error") fail(new Error(message.error));
      });
      worker.on("error", fail);
      worker.on("exit", (code) => { if (!completed) fail(new Error(`Personality proof worker exited without a result (${code})`)); });
    });
    void done.catch(() => undefined);
    return { ready, done };
  });
  const deadline = setTimeout(() => {
    for (const worker of workers) void worker.terminate().catch((error: Error) => worker.emit("error", error));
  }, 45_000);
  try {
    await Promise.all(completions.map((item) => item.ready));
    Atomics.store(new Int32Array(startGate), 0, 1); Atomics.notify(new Int32Array(startGate), 0);
    return await Promise.all(completions.map((item) => item.done));
  } finally { clearTimeout(deadline); await Promise.allSettled(workers.map((worker) => worker.terminate())); }
}

const WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
void (async () => {
  const { tsImport } = await import(workerData.tsxApiUrl);
  const { PersonalityCatalogService } = await tsImport(workerData.serviceUrl, workerData.serviceUrl);
  const { SystemSettingsRepository } = await tsImport(workerData.settingsUrl, workerData.serviceUrl);
  const db = workerData.dialect === "sqlite"
    ? (await tsImport(workerData.sqliteUrl, workerData.serviceUrl)).createDatabase(workerData.options)
    : new (await tsImport(workerData.postgresUrl, workerData.serviceUrl)).PostgresSyncDatabaseClient(workerData.options);
  let result;
  try {
    const settings = new SystemSettingsRepository(db);
    const service = new PersonalityCatalogService({ get: settings.get.bind(settings), compareAndSet: (...args) => {
      parentPort.postMessage({ type: "ready" });
      if (Atomics.wait(new Int32Array(workerData.startGate), 0, 0, 40_000) === "timed-out") throw new Error("Personality race gate timed out");
      return settings.compareAndSet(...args);
    } });
    const writer = workerData.writer; const revision = workerData.expectedRevision;
    try {
      const catalog = writer.kind === "create" ? await service.createPersonality({ ...writer.input, expectedRevision: revision })
        : writer.kind === "update" ? await service.updatePersonality(writer.id, { ...writer.input, expectedRevision: revision })
        : writer.kind === "delete" ? await service.deletePersonality(writer.id, revision)
        : await service.setDefaultPersonality(writer.id, revision);
      result = { outcome: "saved", catalog };
    } catch (error) { if (error.code !== "WRITE_CONFLICT") throw error; result = { outcome: "conflict" }; }
  } finally { db.close(); }
  parentPort.postMessage({ type: "done", result });
})().catch((error) => { parentPort.postMessage({ type: "error", error: String(error.stack ?? error) }); process.exitCode = 1; });
`;

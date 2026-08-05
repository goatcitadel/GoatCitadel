import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type CronJobSpecInput } from "@goatcitadel/storage";
import {
  ConfigGenerationApplyError,
  ConfigGenerationService,
  recoverLastGoodConfigGeneration,
  type CompleteUnifiedConfigPayload,
} from "./config-generation-service.js";
import { CronConfigGenerationOwner, readCanonicalCronSpecs } from "./cron-config-generation-owner.js";

const roots: string[] = [];
const stores: Storage[] = [];

afterEach(async () => {
  for (const storage of stores.splice(0)) {
    storage.close();
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("CronConfigGenerationOwner", () => {
  it("serializes config and resource CAS so the stale cron client cannot publish a generation", async () => {
    const job = spec({ name: "Original" });
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    const config = new ConfigGenerationService(root);
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage));

    const first = owner.updateSpec({ ...job, name: "First writer" }, 1);
    const stale = owner.updateSpec({ ...job, name: "Stale writer" }, 1);

    await expect(first).resolves.toMatchObject({ name: "First writer", revision: 2 });
    await expect(stale).rejects.toMatchObject({
      name: ConflictError.name,
      code: "WRITE_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(config.getRevision()).toBe(2);
    expect(storage.cronJobs.get(job.jobId)).toMatchObject({ name: "First writer", revision: 2 });
    expect(readCanonicalCronSpecs(config.getActivePayload().cronJobs)).toEqual([
      expect.objectContaining({ jobId: job.jobId, name: "First writer" }),
    ]);
  });

  it("merges a queued settings generation and cron generation without losing either change", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    const config = new ConfigGenerationService(root);
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage));

    const settings = config.commit({
      requireExpectedRevision: false,
      previousRuntime: undefined,
      buildCandidate: () => {
        const payload = config.getActivePayload();
        (payload.budgets as { mode: string }).mode = "power";
        return { payload, runtime: undefined };
      },
      apply: () => undefined,
      restore: () => undefined,
    });
    const cron = owner.updateSpec({ ...job, schedule: "15 * * * * America/Los_Angeles" }, 1);

    await expect(Promise.all([settings, cron])).resolves.toBeDefined();
    const active = config.getActivePayload();
    expect(config.getRevision()).toBe(3);
    expect((active.budgets as { mode: string }).mode).toBe("power");
    expect(readCanonicalCronSpecs(active.cronJobs)).toEqual([
      expect.objectContaining({ jobId: job.jobId, schedule: "15 * * * * America/Los_Angeles" }),
    ]);
  });

  it("does not bump config or resource revision for a semantic no-op and still fences stale revisions", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    const config = new ConfigGenerationService(root);
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage));

    await expect(owner.updateSpec(job, 1)).resolves.toMatchObject({ revision: 1 });
    expect(config.getRevision()).toBe(1);
    expect(storage.cronJobs.get(job.jobId)?.revision).toBe(1);

    await owner.updateSpec({ ...job, enabled: false }, 1);
    await expect(owner.updateSpec({ ...job, enabled: false }, 1)).rejects.toMatchObject({
      code: "WRITE_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(config.getRevision()).toBe(2);
  });

  it("keeps scheduler telemetry out of canonical config and never bumps either revision", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    const config = new ConfigGenerationService(root);
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage));

    const beforeConfigRevision = config.getRevision();
    const beforeResourceRevision = storage.cronJobs.get(job.jobId)!.revision;
    storage.cronJobs.mergeRuntimeTelemetry(job.jobId, {
      lastRunAt: "2026-07-13T12:00:00.000Z",
      lastRunId: "run-1",
      lastRunStatus: "ok",
      lastRunOutput: "done",
      nextRunAt: "2026-07-13T13:00:00.000Z",
    });

    expect(config.getRevision()).toBe(beforeConfigRevision);
    expect(storage.cronJobs.get(job.jobId)).toMatchObject({
      revision: beforeResourceRevision,
      lastRunId: "run-1",
      lastRunOutput: "done",
    });
    expect(JSON.stringify(config.getActivePayload().cronJobs)).not.toMatch(/lastRun|nextRun|revision|updatedAt/);
    await expect(owner.updateSpec(job, beforeResourceRevision)).resolves.toMatchObject({ lastRunId: "run-1" });
    expect(config.getRevision()).toBe(beforeConfigRevision);
  });

  it("rolls Storage back exactly when owner apply fails and publishes the prior canonical state", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    storage.cronJobs.mergeRuntimeTelemetry(job.jobId, {
      lastRunAt: "2026-07-13T12:00:00.000Z",
      lastRunId: "run-before",
      lastRunStatus: "ok",
      lastRunOutput: "exact telemetry",
    });
    const before = storage.cronJobs.get(job.jobId);
    const config = new ConfigGenerationService(root);
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage), {
      afterStorageMutation: () => {
        throw new Error("injected cron owner failure");
      },
    });

    await expect(owner.updateSpec({ ...job, name: "Must roll back" }, 1)).rejects.toBeInstanceOf(
      ConfigGenerationApplyError,
    );
    expect(storage.cronJobs.get(job.jobId)).toEqual(before);
    expect(readCanonicalCronSpecs(config.getActivePayload().cronJobs)).toEqual([job]);
    expect(config.getRevision()).toBe(3);
  });

  it("rolls the staged config back when a resource winner lands after candidate construction", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    const config = new ConfigGenerationService(root, undefined, {
      afterCommitMarker: () => {
        storage.cronJobs.updateSpecWithRevision(job.jobId, { name: "Concurrent resource winner" }, 1);
      },
    });
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage));

    await expect(owner.updateSpec({ ...job, name: "Staged loser" }, 1)).rejects.toMatchObject({
      name: ConflictError.name,
      code: "WRITE_CONFLICT",
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(storage.cronJobs.get(job.jobId)).toMatchObject({ name: "Concurrent resource winner", revision: 2 });
    expect(readCanonicalCronSpecs(config.getActivePayload().cronJobs)).toEqual([job]);
    expect(config.getRevision()).toBe(3);
  });

  it("keeps canonical and Storage committed when only the legacy section mirror fails", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    const config = new ConfigGenerationService(root, undefined, {
      beforeMirrorWrite: (filename) => {
        if (filename === "cron-jobs.json") {
          throw new Error("injected mirror failure");
        }
      },
    });
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage));

    await expect(owner.updateSpec({ ...job, name: "Canonical wins" }, 1)).resolves.toMatchObject({
      name: "Canonical wins",
      revision: 2,
    });
    expect(config.isMirrorRepairPending()).toBe(true);
    expect(storage.cronJobs.get(job.jobId)?.name).toBe("Canonical wins");
    expect(readCanonicalCronSpecs(config.getActivePayload().cronJobs)[0]?.name).toBe("Canonical wins");
    const mirror = JSON.parse(await fs.readFile(path.join(root, "config", "cron-jobs.json"), "utf8"));
    expect(mirror.jobs[0].name).toBe(job.name);
  });

  it("replays a committed hard-crash marker forward, preserving runtime telemetry idempotently", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    storage.cronJobs.mergeRuntimeTelemetry(job.jobId, {
      lastRunAt: "2026-07-13T12:00:00.000Z",
      lastRunId: "run-before-crash",
      lastRunStatus: "ok",
      lastRunOutput: "keep me",
      failureCount: 4,
    });
    const crashingConfig = new ConfigGenerationService(root, undefined, {
      afterCommitMarker: () => {
        throw new Error("simulated hard crash");
      },
    });
    const crashingOwner = new CronConfigGenerationOwner(crashingConfig, createSqliteAsyncStorage(storage));

    await expect(crashingOwner.updateSpec({ ...job, name: "Durable decision" }, 1)).rejects.toThrow(
      "simulated hard crash",
    );
    expect(storage.cronJobs.get(job.jobId)).toMatchObject({ name: job.name, revision: 1 });
    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({ recovered: false, revision: 2 });

    const recoveredConfig = new ConfigGenerationService(root);
    const recoveredOwner = new CronConfigGenerationOwner(recoveredConfig, createSqliteAsyncStorage(storage));
    const first = (await recoveredOwner.reconcileCommittedGeneration())[0]!;
    expect(first).toMatchObject({
      name: "Durable decision",
      revision: 2,
      lastRunId: "run-before-crash",
      lastRunOutput: "keep me",
      failureCount: 4,
    });
    const second = (await recoveredOwner.reconcileCommittedGeneration())[0]!;
    expect(second).toEqual(first);
    await recoveredConfig.completeRuntimeOwnerReconciliation();
    expect(recoveredConfig.isRuntimeOwnerReconciliationPending()).toBe(false);
  });

  it("replays a committed hard-crash delete by removing the now-extraneous Storage spec", async () => {
    const job = spec();
    const { root } = await createRoot([job]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(job);
    storage.cronJobs.mergeRuntimeTelemetry(job.jobId, {
      lastRunId: "telemetry-on-deleted-job",
      lastRunStatus: "ok",
    });
    const crashingConfig = new ConfigGenerationService(root, undefined, {
      afterCommitMarker: () => {
        throw new Error("simulated delete crash");
      },
    });
    const crashingOwner = new CronConfigGenerationOwner(crashingConfig, createSqliteAsyncStorage(storage));

    await expect(crashingOwner.deleteSpec(job.jobId, 1)).rejects.toThrow("simulated delete crash");
    expect(storage.cronJobs.get(job.jobId)).toBeDefined();
    await recoverLastGoodConfigGeneration(root);

    const recoveredConfig = new ConfigGenerationService(root);
    const recoveredOwner = new CronConfigGenerationOwner(recoveredConfig, createSqliteAsyncStorage(storage));
    expect(await recoveredOwner.reconcileCommittedGeneration()).toEqual([]);
    expect(storage.cronJobs.get(job.jobId)).toBeUndefined();
    expect(await recoveredOwner.reconcileCommittedGeneration()).toEqual([]);
    await recoveredConfig.completeRuntimeOwnerReconciliation();
  });

  it("canonicalizes legacy telemetry and adopts Storage-only specs once without disturbing telemetry", async () => {
    const canonicalJob = spec();
    const legacyJob = { ...canonicalJob, lastRunAt: "2026-07-13T10:00:00.000Z", revision: 99 };
    const storageOnly = spec({ jobId: "storage-only", name: "Storage only" });
    const { root } = await createRoot([legacyJob]);
    const storage = createStorage(root);
    storage.cronJobs.createSpec(canonicalJob);
    storage.cronJobs.mergeRuntimeTelemetry(canonicalJob.jobId, {
      lastRunId: "canonical-telemetry",
      lastRunStatus: "ok",
    });
    storage.cronJobs.createSpec(storageOnly);
    storage.cronJobs.mergeRuntimeTelemetry(storageOnly.jobId, {
      lastRunId: "storage-telemetry",
      lastRunStatus: "ok",
    });
    const config = new ConfigGenerationService(root);
    const owner = new CronConfigGenerationOwner(config, createSqliteAsyncStorage(storage));

    await owner.reconcileStartupGeneration();
    expect(config.getRevision()).toBe(2);
    expect(readCanonicalCronSpecs(config.getActivePayload().cronJobs).map((item) => item.jobId)).toEqual([
      canonicalJob.jobId,
      storageOnly.jobId,
    ]);
    expect(JSON.stringify(config.getActivePayload().cronJobs)).not.toMatch(/lastRunAt|revision|updatedAt/);
    expect(storage.cronJobs.get(canonicalJob.jobId)).toMatchObject({
      revision: 1,
      lastRunId: "canonical-telemetry",
    });
    expect(storage.cronJobs.get(storageOnly.jobId)).toMatchObject({ revision: 1, lastRunId: "storage-telemetry" });

    const before = storage.cronJobs.list();
    await owner.reconcileStartupGeneration();
    expect(config.getRevision()).toBe(2);
    expect(storage.cronJobs.list()).toEqual(before);
  });
});

function spec(overrides: Partial<CronJobSpecInput> = {}): CronJobSpecInput {
  return {
    jobId: "operator-hourly",
    name: "Operator hourly",
    action: "task",
    schedule: "0 * * * * America/Los_Angeles",
    enabled: true,
    ...overrides,
  };
}

async function createRoot(jobs: unknown[]): Promise<{ root: string; payload: CompleteUnifiedConfigPayload }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-cron-generation-"));
  roots.push(root);
  const payload = JSON.parse(
    await fs.readFile(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  payload.cronJobs = { jobs };
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "goatcitadel.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  for (const [section, filename] of [
    ["assistant", "assistant.config.json"],
    ["toolPolicy", "tool-policy.json"],
    ["budgets", "budgets.json"],
    ["llm", "llm-providers.json"],
    ["cronJobs", "cron-jobs.json"],
  ] as const) {
    await fs.writeFile(path.join(configDir, filename), `${JSON.stringify(payload[section], null, 2)}\n`, "utf8");
  }
  return { root, payload };
}

function createStorage(root: string): Storage {
  const storage = new Storage({
    dbPath: path.join(root, "state", "gateway.sqlite"),
    transcriptsDir: path.join(root, "state", "transcripts"),
    auditDir: path.join(root, "state", "audit"),
  });
  stores.push(storage);
  return storage;
}

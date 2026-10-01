import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { ConflictError, DEFAULT_PROMPT_PACK_POLICY_V2, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { PromptPackRepository } from "./prompt-pack-repo.js";
import { PromptPackRunRepository } from "./prompt-pack-run-repo.js";
import { PromptPackScoreRepository } from "./prompt-pack-score-repo.js";

export const createOnlyInput = (packId: string) => ({
  packId,
  name: "First definition",
  contentSha256: "a".repeat(64),
  tests: [{ code: "TEST-1", title: "First", prompt: "Stored definition only", orderIndex: 0 }],
});

export function verifyCreateOnlyPromptPack(db: DatabaseClient): void {
  const repo = new PromptPackRepository(db);
  const input = createOnlyInput("create-only-existing");
  const first = repo.createPackWithTestsIfAbsent({
    ...input,
    policySource: "pack_override",
    policyV2: {
      ...DEFAULT_PROMPT_PACK_POLICY_V2,
      minScores: { ...DEFAULT_PROMPT_PACK_POLICY_V2.minScores, honesty: 3 },
    },
  });
  const runs = new PromptPackRunRepository(db),
    scores = new PromptPackScoreRepository(db);
  const run = runs.create({
    runId: "create-only-run",
    packId: input.packId,
    testId: first.tests[0]!.testId,
    status: "completed",
    responseText: "Existing evidence",
  });
  const score = scores.create({
    scoreId: "create-only-score",
    packId: input.packId,
    testId: first.tests[0]!.testId,
    runId: run.runId,
    routingScore: 2,
    honestyScore: 2,
    handoffScore: 2,
    robustnessScore: 2,
    usabilityScore: 2,
  });
  assert.throws(
    () => repo.createPackWithTestsIfAbsent({ ...input, name: "Overwrite attempt", contentSha256: "b".repeat(64) }),
    (error: unknown) =>
      error instanceof ConflictError &&
      error.code === "WRITE_CONFLICT" &&
      error.details?.reason === "PROMPT_PACK_ALREADY_EXISTS" &&
      error.details?.mutationCommitted === false,
  );
  assert.deepEqual(repo.getPack(input.packId), first.pack);
  assert.deepEqual(repo.listTests(input.packId), first.tests);
  assert.deepEqual(runs.get(run.runId), run);
  assert.deepEqual(scores.get(score.scoreId), score);
  assert.throws(() =>
    repo.createPackWithTestsIfAbsent({
      ...createOnlyInput("create-only-rollback"),
      tests: [input.tests[0]!, { ...input.tests[0]!, title: "Duplicate code must roll back" }],
    }),
  );
  assert.throws(() => repo.getPack("create-only-rollback"), NotFoundError);
  assert.deepEqual(repo.listTests("create-only-rollback"), []);
  assert.equal(repo.createPackWithTestsIfAbsent(createOnlyInput("create-only-rollback")).tests.length, 1);
  const readTests = repo.listTests;
  repo.listTests = () => {
    throw new Error("Receipt projection failed");
  };
  try {
    assert.throws(
      () => repo.createPackWithTestsIfAbsent(createOnlyInput("create-only-receipt")),
      /Receipt projection failed/u,
    );
  } finally {
    repo.listTests = readTests;
  }
  assert.throws(() => repo.getPack("create-only-receipt"), NotFoundError);
  assert.deepEqual(repo.listTests("create-only-receipt"), []);
  assert.throws(
    () => repo.createPackWithTestsIfAbsent({ ...createOnlyInput("create-only-empty"), tests: [] }),
    RangeError,
  );
  assert.throws(() => repo.getPack("create-only-empty"), NotFoundError);
}

export async function verifyConcurrentCreateOnly(
  db: DatabaseClient,
  input: { dbPath: string } | { connectionString: string },
): Promise<void> {
  const gate = new SharedArrayBuffer(4);
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const workers: Worker[] = [];
  try {
    const starts = ["first", "second"].map((label) => {
      const worker = new Worker(new URL(`./prompt-pack-create-only.test-worker${extension}`, import.meta.url), {
        execArgv: [],
        workerData: {
          ...input,
          label,
          gate,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
          repositoryUrl: new URL(`./prompt-pack-repo${extension}`, import.meta.url).href,
          sqliteUrl: new URL(`./sqlite${extension}`, import.meta.url).href,
          postgresUrl: new URL(`./postgres/sync${extension}`, import.meta.url).href,
        },
      });
      workers.push(worker);
      let ready!: () => void, failReady!: (error: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failReady = reject;
      });
      const completed = new Promise<{
        created?: ReturnType<PromptPackRepository["createPackWithTestsIfAbsent"]>;
        code?: string;
        reason?: string;
      }>((resolve, reject) => {
        worker.on("message", (message) => {
          if (message.ready) ready();
          else {
            failReady(new Error(message.error ?? "Worker finished before ready"));
            resolve(message);
          }
        });
        worker.on("error", (error) => {
          failReady(error);
          reject(error);
        });
        worker.on("exit", (code) => {
          if (code !== 0) {
            const error = new Error(`Import worker exited ${code}`);
            failReady(error);
            reject(error);
          }
        });
      });
      void completed.catch(() => undefined);
      return { readyPromise, completed };
    });
    await Promise.all(starts.map((worker) => worker.readyPromise));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const results = await Promise.all(starts.map((worker) => worker.completed));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.deepEqual(
      results.filter((result) => !result.created).map(({ code, reason }) => ({ code, reason })),
      [{ code: "WRITE_CONFLICT", reason: "PROMPT_PACK_ALREADY_EXISTS" }],
    );
    const winner = results.find((result) => result.created)!.created!;
    const repo = new PromptPackRepository(db);
    assert.deepEqual(repo.getPack("create-only-race"), winner.pack);
    assert.deepEqual(repo.listTests("create-only-race"), winner.tests);
  } finally {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelComparisonRun } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage } from "./async-storage.js";
import { Storage } from "./index.js";
import { ModelComparisonRunRepository } from "./model-comparison-run-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();
const createdStorages: Storage[] = [];

afterEach(() => {
  for (const storage of createdStorages.splice(0)) {
    storage.close();
  }
  tempDbs.cleanup();
});

function createRepo(): ModelComparisonRunRepository {
  const dbPath = tempDbs.path("goatcitadel-model-comparison");
  const storage = new Storage({
    dbPath,
    transcriptsDir: path.join(os.tmpdir(), `goatcitadel-model-comparison-transcripts-${randomUUID()}`),
    auditDir: path.join(os.tmpdir(), `goatcitadel-model-comparison-audit-${randomUUID()}`),
  });
  createdStorages.push(storage);
  return new ModelComparisonRunRepository(createSqliteAsyncStorage(storage).gatewaySql);
}

function sampleRun(): ModelComparisonRun {
  return {
    comparisonId: "cmp-1",
    packId: "pack-1",
    status: "queued",
    title: "Security prompts blind comparison",
    candidates: [
      { candidateId: "cmp-1-a", providerId: "openai", model: "gpt-5", blindLabel: "A" },
      { candidateId: "cmp-1-b", providerId: "anthropic", model: "claude-4.5", blindLabel: "B" },
      { candidateId: "cmp-1-c", providerId: "google", model: "gemini-3", blindLabel: "C" },
    ],
    testIds: ["test-1", "test-2"],
    results: [
      {
        resultId: "result-1",
        testId: "test-1",
        candidateId: "cmp-1-a",
        runId: "run-1",
        responseText: "Stored prompt-pack answer",
        latencyMs: 1200,
      },
      {
        resultId: "result-2",
        testId: "test-1",
        candidateId: "cmp-1-b",
      },
    ],
    judgments: [],
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
  };
}

describe("ModelComparisonRunRepository", () => {
  it("round-trips runs and preserves blind labels", async () => {
    const repo = createRepo();
    const run = await repo.create(sampleRun());

    assert.deepEqual(
      run.candidates.map((candidate) => candidate.blindLabel),
      ["A", "B", "C"],
    );
    assert.equal((await repo.get("cmp-1")).results[0]?.runId, "run-1");
    assert.equal((await repo.list(10))[0]?.comparisonId, "cmp-1");
  });

  it("persists judgments without changing stored result placeholders", async () => {
    const repo = createRepo();
    await repo.create({
      comparisonId: "cmp-judged",
      packId: "pack-1",
      status: "queued",
      title: "Judged run",
      candidates: [
        { candidateId: "cmp-judged-a", providerId: "openai", model: "gpt-5", blindLabel: "A" },
        { candidateId: "cmp-judged-b", providerId: "anthropic", model: "claude-4.5", blindLabel: "B" },
      ],
      testIds: ["test-1"],
      results: [
        { resultId: "result-a", testId: "test-1", candidateId: "cmp-judged-a", responseText: "A answer" },
        { resultId: "result-b", testId: "test-1", candidateId: "cmp-judged-b", responseText: "B answer" },
      ],
      judgments: [],
      createdAt: "2026-06-05T12:00:00.000Z",
      updatedAt: "2026-06-05T12:00:00.000Z",
    });

    const judgment = await repo.addJudgment("cmp-judged", {
      judgmentId: "judgment-1",
      testId: "test-1",
      winnerCandidateId: "cmp-judged-b",
      scores: [
        { candidateId: "cmp-judged-a", quality: 2, honesty: 3, usefulness: 2 },
        { candidateId: "cmp-judged-b", quality: 4, honesty: 4, usefulness: 4 },
      ],
      notes: "B was more complete.",
      reviewerId: "operator",
      createdAt: "2026-06-05T12:01:00.000Z",
    });

    assert.equal(judgment.winnerCandidateId, "cmp-judged-b");
    assert.equal((await repo.get("cmp-judged")).judgments[0]?.notes, "B was more complete.");
    assert.equal((await repo.get("cmp-judged")).updatedAt, "2026-06-05T12:01:00.000Z");
    assert.equal((await repo.get("cmp-judged")).results[0]?.responseText, "A answer");
    await assert.rejects(() => repo.addJudgment("missing", judgment), /Model comparison missing not found/);
  });

  it("updates status and upserts results without losing other results", async () => {
    const repo = createRepo();
    await repo.create(sampleRun());
    const running = await repo.updateStatus("cmp-1", { status: "running", updatedAt: "2026-10-15T00:00:01.000Z" });
    assert.equal(running.status, "running");
    await repo.upsertResult(
      "cmp-1",
      { ...running.results[0]!, responseText: "first answer", runId: "run-1" },
      "2026-10-15T00:00:02.000Z",
    );
    const after = await repo.upsertResult(
      "cmp-1",
      { ...running.results[1]!, error: "provider down" },
      "2026-10-15T00:00:03.000Z",
    );
    assert.equal(after.results.length, 2);
    assert.equal(after.results[0]?.responseText, "first answer");
    assert.equal(after.results[1]?.error, "provider down");
    assert.equal(after.updatedAt, "2026-10-15T00:00:03.000Z");
    const done = await repo.updateStatus("cmp-1", {
      status: "failed",
      updatedAt: "2026-10-15T00:00:04.000Z",
      completedAt: "2026-10-15T00:00:04.000Z",
      error: "1 of 2 results failed",
    });
    assert.equal(done.completedAt, "2026-10-15T00:00:04.000Z");
    assert.equal(done.error, "1 of 2 results failed");
    const cleared = await repo.updateStatus("cmp-1", {
      status: "running",
      updatedAt: "2026-10-15T00:00:05.000Z",
      completedAt: null,
      error: null,
    });
    assert.equal(cleared.completedAt, undefined);
    assert.equal(cleared.error, undefined);
  });

  it("rejects updates for unknown comparisons", async () => {
    const repo = createRepo();
    await assert.rejects(() =>
      repo.updateStatus("missing", { status: "running", updatedAt: "2026-10-15T00:00:00.000Z" }),
    );
    await assert.rejects(() =>
      repo.upsertResult("missing", { resultId: "x", testId: "t", candidateId: "c" }, "2026-10-15T00:00:00.000Z"),
    );
  });
});

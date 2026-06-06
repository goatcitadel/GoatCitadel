import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ModelComparisonRunRepository } from "./model-comparison-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

function createRepo(): ModelComparisonRunRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-model-comparison-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ModelComparisonRunRepository(db);
}

describe("ModelComparisonRunRepository", () => {
  it("round-trips runs and preserves blind labels", () => {
    const repo = createRepo();
    const run = repo.create({
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
    });

    assert.deepEqual(
      run.candidates.map((candidate) => candidate.blindLabel),
      ["A", "B", "C"],
    );
    assert.equal(repo.get("cmp-1").results[0]?.runId, "run-1");
    assert.equal(repo.list(10)[0]?.comparisonId, "cmp-1");
  });

  it("persists judgments without changing stored result placeholders", () => {
    const repo = createRepo();
    repo.create({
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

    const judgment = repo.addJudgment("cmp-judged", {
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
    assert.equal(repo.get("cmp-judged").judgments[0]?.notes, "B was more complete.");
    assert.equal(repo.get("cmp-judged").updatedAt, "2026-06-05T12:01:00.000Z");
    assert.equal(repo.get("cmp-judged").results[0]?.responseText, "A answer");
    assert.throws(() => repo.addJudgment("missing", judgment), /Model comparison missing not found/);
  });
});

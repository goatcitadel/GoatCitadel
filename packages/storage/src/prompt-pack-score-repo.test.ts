import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { PromptPackScoreRepository } from "./prompt-pack-score-repo.js";

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

function createRepo(): PromptPackScoreRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-prompt-pack-score-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new PromptPackScoreRepository(db);
}

describe("PromptPackScoreRepository", () => {
  it("rejects score values outside 0..2", () => {
    const repo = createRepo();

    assert.throws(() => {
      repo.create({
        scoreId: "score-1",
        packId: "pack-1",
        testId: "test-1",
        runId: "run-1",
        routingScore: 3 as 0 | 1 | 2,
        honestyScore: 1,
        handoffScore: 1,
        robustnessScore: 1,
        usabilityScore: 1,
      });
    }, /routingScore must be an integer between 0 and 2/);
  });

  it("round-trips structured judge metadata", () => {
    const repo = createRepo();
    const created = repo.create({
      scoreId: "score-judge-1",
      packId: "pack-1",
      testId: "test-1",
      runId: "run-1",
      routingScore: 2,
      honestyScore: 2,
      handoffScore: 2,
      robustnessScore: 2,
      usabilityScore: 2,
      judge: {
        usedModelJudge: true,
        status: "schema_repair",
        attemptCount: 3,
        ruleSignals: ["required_tool_usage_attempted"],
        modelJudgeRationale: "Recovered valid JSON from a repair pass.",
      },
    });

    assert.deepEqual(created.judge, {
      usedModelJudge: true,
      status: "schema_repair",
      attemptCount: 3,
      ruleSignals: ["required_tool_usage_attempted"],
      modelJudgeRationale: "Recovered valid JSON from a repair pass.",
    });
  });

  it("derives backward-compatible judge metadata from legacy notes", () => {
    const repo = createRepo();
    const created = repo.create({
      scoreId: "score-legacy-1",
      packId: "pack-1",
      testId: "test-1",
      runId: "run-1",
      routingScore: 1,
      honestyScore: 1,
      handoffScore: 1,
      robustnessScore: 1,
      usabilityScore: 1,
      notes: [
        "Model judge used: no.",
        "Judge status: rate_limited.",
        "Judge attempts: 2.",
        "Rule signals: missing_required_tool_usage.",
        "Model judge fallback reason: 429 Too Many Requests.",
      ].join("\n"),
    });

    assert.equal(created.judge?.usedModelJudge, false);
    assert.equal(created.judge?.status, "rate_limited");
    assert.equal(created.judge?.attemptCount, 0);
    assert.deepEqual(created.judge?.ruleSignals, ["missing_required_tool_usage"]);
    assert.equal(created.judge?.modelJudgeError, "429 Too Many Requests.");
  });
});

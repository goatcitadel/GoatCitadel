import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { PromptPackScoreRepository } from "./prompt-pack-score-repo.js";
import type { DatabaseClient } from "./db.js";

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

function createStore(): { db: DatabaseClient; repo: PromptPackScoreRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-prompt-pack-score-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new PromptPackScoreRepository(db) };
}

function createRepo(): PromptPackScoreRepository {
  return createStore().repo;
}

function setRawField(db: DatabaseClient, scoreId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE prompt_pack_scores SET ${field} = ? WHERE score_id = ?`).run(value, scoreId);
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

  it("lists, deletes, clamps stored scores, and handles missing rows", () => {
    const { db, repo } = createStore();
    repo.create({
      scoreId: "score-a",
      packId: "pack-a",
      testId: "test-a",
      runId: "run-a",
      routingScore: 0,
      honestyScore: 1,
      handoffScore: 2,
      robustnessScore: 1,
      usabilityScore: 2,
      notes: "plain note",
      createdAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      scoreId: "score-b",
      packId: "pack-a",
      testId: "test-a",
      runId: "run-b",
      routingScore: 2,
      honestyScore: 2,
      handoffScore: 2,
      robustnessScore: 2,
      usabilityScore: 2,
      createdAt: "2026-03-26T00:00:02.000Z",
    });

    setRawField(db, "score-a", "routing_score", -1);
    setRawField(db, "score-a", "usability_score", 3);
    const clamped = repo.get("score-a");
    assert.equal(clamped.routingScore, 0);
    assert.equal(clamped.usabilityScore, 2);
    assert.equal(clamped.judge, undefined);
    assert.equal(clamped.notes, "plain note");

    assert.deepEqual(
      repo.listByPack("pack-a", 0).map((score) => score.scoreId),
      ["score-b"],
    );
    assert.deepEqual(
      repo.listByPack("pack-a", 5001).map((score) => score.scoreId),
      ["score-b", "score-a"],
    );
    assert.deepEqual(
      repo.listByTest("test-a", 5001).map((score) => score.scoreId),
      ["score-b", "score-a"],
    );
    assert.deepEqual(
      repo.listByRun("run-b", 5001).map((score) => score.scoreId),
      ["score-b"],
    );
    assert.throws(() => repo.get("missing-score"), /Prompt pack score missing-score not found/);
    assert.equal(repo.deleteByPack("missing-pack"), 0);
    assert.equal(repo.deleteByPack("pack-a"), 2);
    assert.deepEqual(repo.listByPack("pack-a"), []);
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

  it("derives non-rate-limited fallback and error judge statuses from legacy notes", () => {
    const repo = createRepo();
    const fallback = repo.create({
      scoreId: "score-legacy-fallback",
      packId: "pack-1",
      testId: "test-1",
      runId: "run-1",
      routingScore: 1,
      honestyScore: 1,
      handoffScore: 1,
      robustnessScore: 1,
      usabilityScore: 1,
      notes: [
        "Model judge used: yes.",
        "Rule signals: none.",
        "Model rationale: Looks acceptable.",
        "Model judge fallback reason: malformed JSON.",
      ].join("\n"),
    });
    const error = repo.create({
      scoreId: "score-legacy-error",
      packId: "pack-1",
      testId: "test-1",
      runId: "run-1",
      routingScore: 1,
      honestyScore: 1,
      handoffScore: 1,
      robustnessScore: 1,
      usabilityScore: 1,
      notes: "Model judge used: no.\nRule signals: none.\nModel rationale: no model answer.",
    });

    assert.equal(fallback.judge?.status, "fallback");
    assert.equal(fallback.judge?.modelJudgeRationale, "Looks acceptable.");
    assert.deepEqual(fallback.judge?.ruleSignals, []);
    assert.equal(error.judge?.status, "error");
  });

  it("filters malformed stored rows and malformed judge JSON", () => {
    const { db, repo } = createStore();
    repo.create({
      scoreId: "score-a",
      packId: "pack-a",
      testId: "test-a",
      runId: "run-a",
      routingScore: 1,
      honestyScore: 1,
      handoffScore: 1,
      robustnessScore: 1,
      usabilityScore: 1,
      judge: {
        usedModelJudge: true,
        status: "ok",
        attemptCount: 1,
        ruleSignals: [],
      },
      createdAt: "2026-03-26T00:00:01.000Z",
    });

    setRawField(db, "score-a", "judge_json", "{bad json");
    assert.equal(repo.get("score-a").judge, undefined);

    setRawField(db, "score-a", "total_score", new Uint8Array([1]));
    assert.throws(() => repo.get("score-a"), /Prompt pack score score-a not found/);
    assert.deepEqual(repo.listByPack("pack-a"), []);
    assert.deepEqual(repo.listByTest("test-a"), []);
    assert.deepEqual(repo.listByRun("run-a"), []);
  });
});

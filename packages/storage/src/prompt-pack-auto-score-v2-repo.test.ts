import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PromptPackScoreRecordV3 } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { PromptPackAutoScoreV2Repository } from "./prompt-pack-auto-score-v2-repo.js";

const createdFiles: string[] = [];
const createdDatabases: DatabaseClient[] = [];

afterEach(() => {
  for (const db of createdDatabases.splice(0)) {
    db.close();
  }
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function createRepo(): PromptPackAutoScoreV2Repository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-auto-score-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  createdDatabases.push(db);
  return new PromptPackAutoScoreV2Repository(db);
}

function createScore(input: {
  autoScoreId: string;
  judgeRubricVersion: string;
  weightedScore: number;
}): PromptPackScoreRecordV3 {
  return {
    autoScoreId: input.autoScoreId,
    packId: "pack-1",
    testId: "test-1",
    runId: "run-1",
    scoringSchemaVersion: "v3",
    scorerVersion: "scorer-1",
    judgeRubricVersion: input.judgeRubricVersion,
    policyHash: "policy-1",
    policySource: "inherited_default",
    scoreState: "auto_valid",
    protocol: { protocolPass: true, reasonCodes: [] },
    hardFailReasons: [],
    applicability: { taskSuccess: true },
    outcomeScores: { taskSuccess: 4 },
    executionScores: {},
    ruleScores: { taskSuccess: 4 },
    finalScores: { taskSuccess: 4 },
    disagreement: {},
    weightedScore: input.weightedScore,
    autoVerdict: "pass",
    reviewReasons: [],
    degradedReasons: [],
    mergeProvenance: {},
    attribution: {
      primary: "not_applicable",
      confidence: "high",
      evidence: [],
    },
    judgeStatus: "valid",
    createdAt: "2026-05-05T00:00:00.000Z",
  };
}

describe("PromptPackAutoScoreV2Repository", () => {
  it("returns the stored conflict row when a same-generation rescore updates the existing identity", () => {
    const repo = createRepo();
    const first = repo.create(
      createScore({
        autoScoreId: "score-old",
        judgeRubricVersion: "rubric-current",
        weightedScore: 72,
      }),
    );
    const second = repo.create(
      createScore({
        autoScoreId: "score-new",
        judgeRubricVersion: "rubric-current",
        weightedScore: 88,
      }),
    );

    assert.equal(first.autoScoreId, "score-old");
    assert.equal(second.autoScoreId, "score-old");
    assert.equal(second.judgeRubricVersion, "rubric-current");
    assert.equal(second.weightedScore, 88);
    assert.equal(repo.listByRun("run-1").length, 1);
  });

  it("lists, deletes, reports missing scores, and fails clearly on malformed stored records", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: DatabaseClient }).db;

    assert.throws(() => repo.get("missing-score"), /Prompt pack auto score missing-score not found/);

    repo.create(
      createScore({
        autoScoreId: "score-1",
        judgeRubricVersion: "rubric-current",
        weightedScore: 90,
      }),
    );

    assert.equal(repo.listByPack("pack-1", 0)[0]?.autoScoreId, "score-1");
    assert.equal(repo.listByTest("test-1", 0)[0]?.autoScoreId, "score-1");
    assert.equal(repo.listByRun("run-1", 0)[0]?.autoScoreId, "score-1");

    db.prepare("UPDATE prompt_pack_auto_scores_v2 SET record_json = ? WHERE auto_score_id = ?").run(
      "{bad-json",
      "score-1",
    );
    assert.throws(() => repo.get("score-1"), /Stored prompt pack auto score score-1 is malformed/);

    assert.equal(repo.deleteByPack("pack-1"), 1);
    assert.deepEqual(repo.listByPack("pack-1"), []);
  });
});

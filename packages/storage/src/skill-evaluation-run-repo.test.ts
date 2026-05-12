import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { SkillEvaluationRunRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { SkillEvaluationRunRepository } from "./skill-evaluation-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createStore(): { db: DatabaseClient; repo: SkillEvaluationRunRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-evaluation-run-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new SkillEvaluationRunRepository(db) };
}

function runRecord(overrides: Partial<SkillEvaluationRunRecord> = {}): SkillEvaluationRunRecord {
  return {
    runId: "run-a",
    skillId: "skill-a",
    skillName: "Research skill",
    status: "completed",
    createdAt: "2026-03-26T00:00:01.000Z",
    updatedAt: "2026-03-26T00:00:01.000Z",
    scenarios: [
      {
        scenarioId: "scenario-a",
        title: "Summarize",
        prompt: "Summarize this.",
        expectedOutcome: "A concise summary.",
        tags: ["summary"],
      },
    ],
    criteria: [
      {
        criterionId: "criterion-a",
        label: "Grounded",
        description: "Uses source facts.",
        requiredTerms: ["source"],
      },
    ],
    baselineResult: {
      instructionHash: "hash-a",
      score: { total: 1, passed: 0, passRate: 0 },
      scenarioResults: [
        {
          scenarioId: "scenario-a",
          passed: false,
          passRate: 0,
          outputPreview: "old",
          criteria: [{ criterionId: "criterion-a", passed: false, rationale: "missing source" }],
        },
      ],
    },
    candidateResult: {
      instructionHash: "hash-b",
      score: { total: 1, passed: 1, passRate: 1 },
      scenarioResults: [
        {
          scenarioId: "scenario-a",
          passed: true,
          passRate: 1,
          outputPreview: "new",
          criteria: [{ criterionId: "criterion-a", passed: true, rationale: "grounded" }],
        },
      ],
    },
    mutation: {
      summary: "Added source-grounding instruction.",
      patchPreview: "+ cite source",
      beforeInstructionBody: "before",
      afterInstructionBody: "after",
      changedSections: ["workflow"],
      missingCoverageTerms: ["source"],
    },
    accepted: true,
    improvementDelta: 1,
    targetPassRate: 0.9,
    maxRounds: 3,
    proposalId: "proposal-a",
    improvementCandidateId: "candidate-a",
    ledgerSignalId: "signal-a",
    warnings: ["operator review required"],
    operatorTruth: {
      executesScripts: false,
      writesSkillFile: false,
      proposalOnly: true,
    },
    ...overrides,
  };
}

function setRawField(db: DatabaseClient, runId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE skill_evaluation_runs SET ${field} = ? WHERE run_id = ?`).run(value, runId);
}

describe("SkillEvaluationRunRepository", () => {
  it("upserts, finds, gets, and lists skill evaluation runs", () => {
    const { repo } = createStore();

    const created = repo.upsert(runRecord());
    assert.deepEqual(created, runRecord());
    assert.deepEqual(repo.get("run-a"), runRecord());
    assert.deepEqual(repo.find("run-a"), runRecord());
    assert.equal(repo.find("missing-run"), undefined);
    assert.throws(() => repo.get("missing-run"), /skill evaluation run missing-run not found/);

    const updated = repo.upsert(
      runRecord({
        status: "proposal_created",
        accepted: false,
        improvementDelta: 0.5,
        proposalId: undefined,
        improvementCandidateId: undefined,
        ledgerSignalId: undefined,
        updatedAt: "2026-03-26T00:00:03.000Z",
        warnings: [],
      }),
    );
    assert.equal(updated.status, "proposal_created");
    assert.equal(updated.accepted, false);
    assert.equal(updated.proposalId, undefined);
    assert.equal(updated.improvementCandidateId, undefined);
    assert.equal(updated.ledgerSignalId, undefined);

    repo.upsert(
      runRecord({
        runId: "run-b",
        status: "preview",
        accepted: false,
        updatedAt: "2026-03-26T00:00:04.000Z",
      }),
    );
    repo.upsert(
      runRecord({
        runId: "run-c",
        skillId: "skill-b",
        skillName: "Other skill",
        updatedAt: "2026-03-26T00:00:05.000Z",
      }),
    );

    assert.deepEqual(
      repo.listBySkill("skill-a").map((item) => item.runId),
      ["run-b", "run-a"],
    );
    assert.deepEqual(
      repo.listBySkill("skill-a", 0).map((item) => item.runId),
      ["run-b"],
    );
    assert.deepEqual(repo.listBySkill("missing-skill"), []);
  });

  it("falls back from malformed record JSON and filters malformed rows", () => {
    const { db, repo } = createStore();
    repo.upsert(runRecord());

    setRawField(db, "run-a", "record_json", "[]");
    const arrayPayloadFallback = repo.get("run-a");
    assert.equal(arrayPayloadFallback.runId, "run-a");
    assert.deepEqual(arrayPayloadFallback.scenarios, []);
    assert.equal(arrayPayloadFallback.accepted, true);
    assert.equal(arrayPayloadFallback.proposalId, "proposal-a");

    setRawField(db, "run-a", "record_json", "{}");
    const objectPayloadFallback = repo.find("run-a");
    assert.equal(objectPayloadFallback?.runId, "run-a");
    assert.deepEqual(objectPayloadFallback?.criteria, []);
    assert.equal(objectPayloadFallback?.operatorTruth.proposalOnly, true);

    setRawField(db, "run-a", "record_json", "{bad json");
    assert.equal(repo.get("run-a").baselineResult.score.passRate, 0);

    setRawField(db, "run-a", "updated_at", new Uint8Array([1]));
    assert.throws(() => repo.get("run-a"), /skill evaluation run run-a not found/);
    assert.equal(repo.find("run-a"), undefined);
    assert.deepEqual(repo.listBySkill("skill-a"), []);
  });
});

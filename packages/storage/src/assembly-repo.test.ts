import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AdversarialSettings,
  AssemblyArtifactRecord,
  AssemblyProblem,
  AssemblyResult,
  AssemblyRound,
  AssemblyRunRecord,
  AssemblySettings,
  ModelReputation,
} from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { AssemblyRepository } from "./assembly-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): AssemblyRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-assembly-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new AssemblyRepository(createDatabase({ dbPath }));
}

function buildProblem(runId: string): AssemblyProblem {
  return {
    runId,
    domain: "coding",
    title: "Fix flaky build",
    originalPrompt: "Fix the flaky build and preserve minority opinions.",
    normalizedStatement: "Stabilize the build without losing dissenting risk analysis.",
    objectives: ["stabilize CI", "preserve disagreement"],
    constraints: ["2 rounds max", "cost capped"],
    evaluationCriteria: ["correctness", "risk awareness"],
    contextRefs: [],
    createdAt: "2026-03-16T00:00:00.000Z",
  };
}

function buildSettings(): AssemblySettings {
  return {
    mode: "consensus",
    participantModels: [
      { participantId: "p1", providerId: "openai", model: "gpt-5.4" },
      { participantId: "p2", providerId: "anthropic", model: "claude-sonnet-4.5" },
    ],
    maxRounds: 2,
    maxCritiquePasses: 1,
    maxInterModelExchanges: 1,
    convergenceThreshold: 0.78,
    stagnationWindow: 2,
    timeBudgetMs: 120000,
    tokenBudget: 40000,
    costBudgetUsd: 5,
    domainPreset: "coding",
    synthesisStyle: "balanced",
    exportTargets: ["artifact"],
  };
}

function buildAdversarialSettings(): AdversarialSettings {
  return {
    enabled: false,
    reviewerCount: 0,
    selectionStrategy: "user_selected",
    strictness: "balanced",
    requireMitigations: true,
    requireEvidenceTags: true,
    defenseRoundEnabled: false,
    repetitiveObjectionCutoff: true,
    minorityReportRequired: true,
  };
}

describe("AssemblyRepository", () => {
  it("persists runs, rounds, artifacts, and reputation", () => {
    const repo = createRepo();
    const runId = "assembly-run-1";
    const run: AssemblyRunRecord = {
      runId,
      title: "Assembly run",
      status: "queued",
      currentStage: "S0_normalize",
      currentRoundIndex: 0,
      problem: buildProblem(runId),
      settings: buildSettings(),
      adversarialSettings: buildAdversarialSettings(),
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    };

    repo.createRun(run);
    const loaded = repo.getRun(runId);
    assert.equal(loaded.problem.normalizedStatement, run.problem.normalizedStatement);

    const round: AssemblyRound = {
      roundId: "round-1",
      runId,
      roundIndex: 1,
      stage: "S1_submit",
      status: "running",
      participantIds: ["p1", "p2"],
      artifactIds: [],
      startedAt: "2026-03-16T00:01:00.000Z",
    };
    repo.saveRound(round);

    const result: AssemblyResult = {
      runId,
      recommendation: "Use deterministic retries and isolate flaky tests.",
      disagreements: [],
      riskAnalysis: ["Retries may hide nondeterminism."],
      implementationPlan: ["Instrument flaky tests", "Gate retries narrowly"],
      modelContributionSummary: [],
      exports: [{ target: "artifact", status: "generated", relPath: "assembly/run-1.md" }],
      createdAt: "2026-03-16T00:03:00.000Z",
    };

    const artifact: AssemblyArtifactRecord = {
      artifactId: "artifact-1",
      runId,
      roundIndex: 1,
      stage: "S5_synthesis",
      artifactType: "result",
      payload: result,
      createdAt: "2026-03-16T00:03:00.000Z",
    };
    repo.saveArtifacts([artifact]);
    repo.updateRoundArtifacts("round-1", ["artifact-1"]);
    repo.completeRound("round-1", {
      status: "completed",
      finishedAt: "2026-03-16T00:03:00.000Z",
    });
    repo.updateRun(runId, {
      status: "completed",
      currentStage: "completed",
      result,
      finishedAt: "2026-03-16T00:03:00.000Z",
    });

    const rounds = repo.listRounds(runId);
    assert.equal(rounds.length, 1);
    assert.deepEqual(rounds[0]?.artifactIds, ["artifact-1"]);

    const artifacts = repo.listArtifacts(runId);
    assert.equal(artifacts.length, 1);
    assert.equal((artifacts[0]?.payload as AssemblyResult).recommendation, result.recommendation);

    const reputation: ModelReputation = {
      modelRef: "openai:gpt-5.4",
      providerId: "openai",
      modelId: "gpt-5.4",
      overall: 0.84,
      byDomain: {
        coding: {
          accuracy: 0.85,
          reasoningStrength: 0.86,
          critiqueQuality: 0.8,
          consensusLeadership: 0.88,
          stability: 0.81,
          adversarialUsefulness: 0.74,
          sampleCount: 5,
        },
      },
      accuracy: 0.85,
      reasoningStrength: 0.86,
      critiqueQuality: 0.8,
      consensusLeadership: 0.88,
      stability: 0.81,
      adversarialUsefulness: 0.74,
      sampleCount: 5,
      updatedAt: "2026-03-16T00:04:00.000Z",
    };
    repo.upsertReputation(reputation);
    const reputations = repo.listReputations();
    assert.equal(reputations.length, 1);
    assert.equal(reputations[0]?.byDomain.coding?.sampleCount, 5);
  });

  it("covers optional run fields, artifact variants, typed filters, and missing rows", () => {
    const repo = createRepo();
    const runId = "assembly-run-edge";
    const run: AssemblyRunRecord = {
      runId,
      workspaceId: "workspace-1",
      sourceSessionId: "session-1",
      sourceTaskId: "task-1",
      title: "Assembly edge run",
      status: "queued",
      currentStage: "S0_normalize",
      currentRoundIndex: 0,
      problem: buildProblem(runId),
      settings: buildSettings(),
      adversarialSettings: buildAdversarialSettings(),
      createdAt: "2026-03-17T00:00:00.000Z",
      startedAt: "2026-03-17T00:00:30.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z",
    };
    repo.createRun(run);

    assert.throws(() => repo.getRun("missing-run"), /Assembly run missing-run not found/);
    assert.deepEqual(
      repo.listRuns(0).map((item) => item.runId),
      [runId],
    );

    const updated = repo.updateRun(runId, {
      status: "failed",
      currentStage: "S5_synthesis",
      currentRoundIndex: 3,
      stopReason: "budget_exhausted",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.12,
      } as AssemblyRunRecord["usage"],
      error: "provider unavailable",
      finishedAt: "2026-03-17T00:10:00.000Z",
      updatedAt: "2026-03-17T00:10:00.000Z",
    });
    assert.equal(updated.workspaceId, "workspace-1");
    assert.equal(updated.sourceSessionId, "session-1");
    assert.equal(updated.sourceTaskId, "task-1");
    assert.equal(updated.stopReason, "budget_exhausted");
    assert.equal(updated.error, "provider unavailable");
    assert.equal(updated.usage?.inputTokens, 10);
    assert.equal(updated.usage?.outputTokens, 20);

    const round: AssemblyRound = {
      roundId: "round-edge",
      runId,
      roundIndex: 2,
      stage: "S4_convergence",
      status: "running",
      participantIds: ["p1"],
      artifactIds: [],
      convergenceSnapshot: {
        compositeScore: 0.5,
        stagnationDelta: 0.1,
      } as AssemblyRound["convergenceSnapshot"],
      stopCheck: {
        shouldStop: false,
        reason: "stagnated",
      } as AssemblyRound["stopCheck"],
      startedAt: "2026-03-17T00:03:00.000Z",
    };
    repo.saveRound(round);
    repo.completeRound("round-edge", {
      status: "completed",
      convergenceSnapshot: {
        compositeScore: 0.75,
        stagnationDelta: 0.02,
      } as AssemblyRound["convergenceSnapshot"],
      stopCheck: {
        shouldStop: true,
        reason: "converged",
      } as AssemblyRound["stopCheck"],
      finishedAt: "2026-03-17T00:04:00.000Z",
    });
    const loadedRound = repo.listRounds(runId)[0];
    assert.equal(loadedRound?.convergenceSnapshot?.compositeScore, 0.75);
    assert.equal(loadedRound?.stopCheck?.shouldStop, true);

    assert.deepEqual(repo.saveArtifacts([]), []);
    const artifactTypes = [
      "problem",
      "convergence_score",
      "proposal",
      "peer_review",
      "adversarial_review",
      "defense_response",
    ] as const;
    const artifacts = artifactTypes.map((artifactType, index): AssemblyArtifactRecord => {
      const artifactId = `artifact-${artifactType}`;
      return {
        artifactId,
        runId,
        roundIndex: 2,
        stage: "S4_convergence",
        artifactType,
        participantModelRef: index % 2 === 0 ? "openai:gpt-5.4" : undefined,
        blindedAuthorToken: index % 2 === 1 ? `blind-${index}` : undefined,
        payload: { runId, marker: artifactType } as unknown as AssemblyArtifactRecord["payload"],
        createdAt: `2026-03-17T00:05:0${index}.000Z`,
      };
    });
    repo.saveArtifacts(artifacts);
    repo.updateRoundArtifacts(
      "round-edge",
      artifacts.map((artifact) => artifact.artifactId),
    );

    assert.equal(repo.listArtifacts(runId).length, artifactTypes.length);
    assert.deepEqual(
      repo.listArtifacts(runId, "peer_review").map((artifact) => artifact.artifactType),
      ["peer_review"],
    );
    assert.deepEqual(
      repo.listRounds(runId)[0]?.artifactIds,
      artifacts.map((artifact) => artifact.artifactId),
    );

    const reputation: ModelReputation = {
      modelRef: "anthropic:claude-sonnet-4.5",
      providerId: "anthropic",
      modelId: "claude-sonnet-4.5",
      overall: 0.91,
      byDomain: {
        analysis: {
          accuracy: 0.9,
          reasoningStrength: 0.92,
          critiqueQuality: 0.91,
          consensusLeadership: 0.88,
          stability: 0.93,
          adversarialUsefulness: 0.87,
          sampleCount: 2,
        },
      },
      accuracy: 0.9,
      reasoningStrength: 0.92,
      critiqueQuality: 0.91,
      consensusLeadership: 0.88,
      stability: 0.93,
      adversarialUsefulness: 0.87,
      sampleCount: 2,
      updatedAt: "2026-03-17T00:06:00.000Z",
    };
    assert.equal(repo.upsertReputation(reputation).modelRef, reputation.modelRef);
    assert.equal(repo.listReputations(0)[0]?.modelRef, reputation.modelRef);
  });
});

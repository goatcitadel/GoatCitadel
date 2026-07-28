import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import type { EngineeringLearningRecord, ReviewFindingRecord } from "@goatcitadel/contracts";
import { Storage } from "./index.js";

test("PromptRetuneRepository persists atomic pass and campaign transitions", () => {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: os.tmpdir(), auditDir: os.tmpdir() });
  try {
    const createdAt = "2026-07-28T00:00:00.000Z";
    storage.promptRetunes.createCampaign({
      campaignId: "campaign-1",
      packId: "pack-1",
      status: "draft",
      baselineContentSha256: "a".repeat(64),
      policyHash: "b".repeat(64),
      scoringSnapshot: { scoringSchemaVersion: "v3" },
      testCodes: ["TEST-01"],
      providers: [{ providerId: "openai", model: "gpt-5" }],
      executionStyle: "single_turn_harness",
      repeatCount: 3,
      maxBenchmarkRuns: 12,
      successBar: {
        minWeightedScoreDelta: 0,
        requirePassRateNonRegression: true,
        maxFailureRateDelta: 0,
      },
      createdAt,
      updatedAt: createdAt,
      passes: [],
    });
    storage.promptRetunes.createPassAndActivate(
      {
        passId: "pass-1",
        campaignId: "campaign-1",
        kind: "noise",
        hypothesis: "A/A null experiment",
        contentSha256: "a".repeat(64),
        benchmarkRunIds: [],
        disposition: "pending",
        createdAt,
      },
      "measuring_noise",
    );
    storage.promptRetunes.setPassBenchmarkRunIds("pass-1", ["benchmark-1", "benchmark-2", "benchmark-3"]);
    storage.promptRetunes.completeNoise({
      campaignId: "campaign-1",
      passId: "pass-1",
      metrics: { averageWeightedScore: 82, passRate: 1, failureRate: 0, averageLatencyMs: 100 },
      noiseFloor: { weightedScore: 1, passRate: 0, failureRate: 0, latencyMs: 5 },
      finishedAt: "2026-07-28T00:05:00.000Z",
    });

    const campaign = storage.promptRetunes.getCampaign("campaign-1");
    assert.equal(campaign?.status, "ready");
    assert.deepEqual(campaign?.passes[0]?.benchmarkRunIds, ["benchmark-1", "benchmark-2", "benchmark-3"]);
    assert.equal(campaign?.passes[0]?.disposition, "kept");
    assert.equal(storage.promptRetunes.listCampaigns("pack-1").length, 1);
  } finally {
    storage.close();
  }
});

test("StructuredReviewRepository preserves model receipts and finding lifecycle evidence", () => {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: os.tmpdir(), auditDir: os.tmpdir() });
  try {
    const createdAt = "2026-07-28T00:00:00.000Z";
    storage.structuredReviews.createRun({
      reviewRunId: "review-1",
      source: "native",
      status: "queued",
      rootPath: "F:/code/personal-ai",
      reviewedSha: "a".repeat(40),
      diffHash: "b".repeat(64),
      changedFiles: ["src/fix.ts"],
      reviewerRoster: ["general_correctness", "test_coverage"],
      preflight: {
        participantCount: 1,
        reviewerLensCount: 2,
        estimatedReviewCalls: 1,
        tokenBudget: 10_000,
        costBudgetUsd: 1,
      },
      modelReceipts: [],
      findings: [],
      createdAt,
    });
    storage.structuredReviews.updateRun("review-1", {
      status: "running",
      modelReceipts: [{ role: "general_correctness", providerId: "openai", model: "gpt-5", runId: "assembly-1" }],
    });
    const finding: ReviewFindingRecord = {
      findingId: "finding-1",
      reviewRunId: "review-1",
      source: "reviewer",
      component: "gateway",
      title: "Approval evidence is missing",
      files: ["src/fix.ts"],
      severity: "p1",
      priority: "high",
      confidence: 100,
      whyItMatters: "A risky mutation could bypass review.",
      evidence: [{ path: "src/fix.ts", startLine: 10, quote: "mutate();" }],
      preExisting: false,
      fixClass: "approval_gated",
      requiresVerification: true,
      status: "open",
      createdAt,
      updatedAt: createdAt,
    };
    storage.structuredReviews.createFinding(finding);
    storage.structuredReviews.updateFinding({
      ...finding,
      status: "closed",
      verificationEvidence: ["test:focused-pass"],
      followUpReviewRunId: "review-2",
      updatedAt: "2026-07-28T00:10:00.000Z",
    });

    const run = storage.structuredReviews.getRun("review-1");
    assert.equal(run?.assemblyRunId, "assembly-1");
    assert.equal(run?.findings[0]?.status, "closed");
    assert.deepEqual(run?.findings[0]?.verificationEvidence, ["test:focused-pass"]);
  } finally {
    storage.close();
  }
});

test("EngineeringLearningRepository scopes source-run identity and freshness candidates", () => {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: os.tmpdir(), auditDir: os.tmpdir() });
  try {
    const createdAt = "2026-07-28T00:00:00.000Z";
    const learning: EngineeringLearningRecord = {
      learningId: "learning-1",
      workspaceId: "default",
      status: "proposed",
      title: "Retain the regression proof",
      problem: "The guard was missing.",
      rootCause: "The mutation path had no invariant.",
      resolution: "Added the invariant.",
      prevention: "Run the focused proof.",
      failedAttempts: [],
      applicablePaths: ["src/fix.ts"],
      source: { runId: "code-run-1" },
      fileEvidence: [{ path: "src/fix.ts", sha256: "a".repeat(64) }],
      verificationEvidence: ["test:focused-pass"],
      provenanceHash: "b".repeat(64),
      createdAt,
      updatedAt: createdAt,
    };
    storage.engineeringLearnings.create(learning, "c".repeat(64));

    assert.equal(storage.engineeringLearnings.getBySourceRun("default", "code-run-1")?.learningId, "learning-1");
    assert.equal(storage.engineeringLearnings.list({ workspaceId: "default" }).length, 1);
    assert.equal(storage.engineeringLearnings.listRefreshCandidates().length, 1);
  } finally {
    storage.close();
  }
});

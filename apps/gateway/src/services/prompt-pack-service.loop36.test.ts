import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type {
  PromptPackHumanReviewRecordV2,
  PromptPackLatestAssessmentRecordV2,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackScoreRecordV3,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  buildPromptPackReportSummary,
  evaluatePromptPackRuleScores,
  evaluatePromptPackRunIntegrity,
  renderPromptPackMarkdownReport,
  resolvePromptPackExecutionProfile,
} from "./prompt-pack-service.js";
import { createPack, createRun, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack loop36 behavioral tails", () => {
  it("summarizes current v3 attribution, degraded judge states, and human review overrides", () => {
    const tests = [
      createTest("test-v3-pass", "TEST-L36-PASS"),
      createTest("test-v3-fail", "TEST-L36-FAIL"),
      createTest("test-v3-review", "TEST-L36-REVIEW"),
    ];
    const runs = tests.map((test, index) => ({
      ...createRun(`run-v3-${index}`, "completed", `2026-05-15T10:0${index}:00.000Z`),
      testId: test.testId,
      responseText: `Completed response for ${test.code}.`,
      trace: createTrace(`sess-v3-${index}`),
    }));
    const scores = [
      createV3Score({
        scoreId: "auto-pass",
        testId: tests[0]!.testId,
        runId: runs[0]!.runId,
        verdict: "pass",
        weightedScore: 96,
        attribution: "runtime_or_infra_failure",
        scoreState: "auto_degraded",
        judgeStatus: "fallback",
      }),
      createV3Score({
        scoreId: "auto-fail",
        testId: tests[1]!.testId,
        runId: runs[1]!.runId,
        verdict: "fail",
        weightedScore: 41,
        attribution: "missing_tool",
        judgeStatus: "timeout",
      }),
      createV3Score({
        scoreId: "auto-review",
        testId: tests[2]!.testId,
        runId: runs[2]!.runId,
        verdict: "review",
        weightedScore: 62,
        attribution: "not_applicable",
        judgeStatus: "valid",
      }),
    ];
    const humanReview: PromptPackHumanReviewRecordV2 = {
      reviewId: "review-loop36",
      packId: "pack-1",
      testId: tests[2]!.testId,
      runId: runs[2]!.runId,
      autoScoreId: scores[2]!.autoScoreId,
      reviewerId: "operator",
      scores: {},
      applicability: {},
      overrideVerdict: "review",
      createdAt: "2026-05-15T10:05:00.000Z",
    };
    const latestAssessments: PromptPackLatestAssessmentRecordV2[] = scores.map((score) => ({
      testId: score.testId,
      runId: score.runId,
      autoScore: score,
      humanReview: score.runId === humanReview.runId ? humanReview : undefined,
      currentGeneration: true,
      scoreState: score.scoreState,
      autoVerdict: score.autoVerdict,
      effectiveVerdict: score.runId === humanReview.runId ? "review" : score.autoVerdict,
    }));

    const summary = buildPromptPackReportSummary(tests, runs, [], scores, [humanReview], latestAssessments, {
      scoringSchemaVersion: "v3",
      policyHash: "policy-loop36",
    });

    expect(summary).toMatchObject({
      completedRuns: 3,
      autoScoredRuns: 3,
      humanReviewedRuns: 1,
      degradedScoreCount: 1,
      judgeFallbackCount: 1,
      judgeErrorCount: 1,
      passCount: 1,
      failCount: 1,
      reviewCount: 1,
      scoreFailureCount: 1,
      failingCodes: ["TEST-L36-FAIL", "TEST-L36-REVIEW"],
      activeScoringSchemaVersion: "v3",
      averageWeightedScore: (96 + 41 + 62) / 3,
    });
    expect(summary.attributionBreakdown).toEqual([
      { attribution: "runtime_or_infra_failure", count: 1 },
      { attribution: "missing_tool", count: 1 },
    ]);
  });

  it("renders diagnostic metadata fallbacks and observed memory evidence in reports", () => {
    const test: PromptPackTestRecord = {
      ...createTest("test-metadata", "TEST-L36-META"),
      prompt: "Use memory/context and report the exact runtime signal.",
      diagnosticMetadata: {
        capabilityTargets: [],
        expectedRuntimeSignals: ["memory_retrieval"],
        likelyFailureClasses: [],
      },
    };
    const run: PromptPackRunRecord = {
      ...createRun("run-metadata", "completed", "2026-05-15T10:30:00.000Z"),
      testId: test.testId,
      responseText: "Used memory evidence and returned the requested runtime signal.",
      trace: createTrace("sess-metadata", {
        toolRuns: [
          {
            toolRunId: "tool-memory",
            turnId: "turn-sess-metadata",
            sessionId: "sess-metadata",
            toolName: "memory.search",
            status: "executed",
            args: { query: "operator preference" },
            result: { matches: [{ title: "Preference", content: "concise technical answers" }] },
            startedAt: "2026-05-15T10:30:00.000Z",
            finishedAt: "2026-05-15T10:30:00.100Z",
          },
        ],
      }),
    };
    const report: PromptPackReportRecord = {
      pack: createPack("pack-loop36-metadata"),
      tests: [test],
      runs: [run],
      scores: [],
      autoScoresV2: [],
      humanReviewsV2: [],
      latestAssessments: [
        {
          testId: test.testId,
          runId: run.runId,
          currentGeneration: true,
          scoreState: "unavailable",
        },
      ],
      summary: buildPromptPackReportSummary([test], [run], []),
    };

    const markdown = renderPromptPackMarkdownReport(report, { generatedAt: "2026-05-15T10:31:00.000Z" });

    expect(markdown).toContain("- Capability targets: none");
    expect(markdown).toContain("- Expected runtime signals: memory_retrieval");
    expect(markdown).toContain("- Likely failure classes: none");
    expect(markdown).toContain("- Actual tool families observed: memory");
  });

  it("accepts executed memory tools and flags strict formatting/runtime integrity violations", () => {
    const test = {
      ...createTest("test-memory-tools", "TEST-L36-MEM"),
      prompt: "Use available memory/context to summarize my formatting preference.",
      toolTier: "explicit-tools",
    } satisfies PromptPackTestRecord;
    const profile = resolvePromptPackExecutionProfile({ test });
    const run: PromptPackRunRecord = {
      ...createRun("run-memory-tools", "completed", "2026-05-15T11:00:00.000Z"),
      testId: test.testId,
      responseText: "Memory says the operator prefers concise, repo-grounded technical answers.",
      trace: createTrace("sess-memory-tools", {
        toolRuns: [
          {
            toolRunId: "tool-memory",
            turnId: "turn-sess-memory-tools",
            sessionId: "sess-memory-tools",
            toolName: "memory.read",
            status: "executed",
            args: { key: "answer_style" },
            result: { value: "concise and repo-grounded" },
            startedAt: "2026-05-15T11:00:00.000Z",
            finishedAt: "2026-05-15T11:00:00.050Z",
          },
        ],
      }),
    };

    expect(evaluatePromptPackRuleScores({ prompt: test.prompt, profile, run }).signals).not.toContain(
      "missing_required_tool_usage",
    );

    const integrity = evaluatePromptPackRunIntegrity({
      prompt:
        "Return a 3-step plan. Each step must be 3 words or fewer. No step may repeat a verb. No explanation outside the steps. Return JSON.",
      responseText: [
        "## Plan",
        "1. Review current implementation carefully",
        "2. Review tests carefully",
        "Extra explanation outside the numbered steps",
      ].join("\n"),
      trace: createTrace("sess-integrity", {
        completion: { status: "interrupted", finishReason: "length" },
      }),
      outputTokenCount: 128,
    });

    expect(integrity.validationStatus).toBe("invalid");
    expect(integrity.signals).toEqual(
      expect.arrayContaining([
        "completion_interrupted",
        "finish_reason_length",
        "step_count_mismatch",
        "step_word_limit_exceeded",
        "repeated_step_verb",
        "non_step_content_present",
        "missing_requested_json_output",
      ]),
    );
  });
});

function createV3Score(input: {
  scoreId: string;
  testId: string;
  runId: string;
  verdict: "pass" | "fail" | "review";
  weightedScore: number;
  attribution: PromptPackScoreRecordV3["attribution"]["primary"];
  scoreState?: PromptPackScoreRecordV3["scoreState"];
  judgeStatus?: PromptPackScoreRecordV3["judgeStatus"];
}): PromptPackScoreRecordV3 {
  return {
    autoScoreId: input.scoreId,
    packId: "pack-1",
    testId: input.testId,
    runId: input.runId,
    scoringSchemaVersion: "v3",
    scorerVersion: "loop36-scorer",
    judgeRubricVersion: "loop36-rubric",
    policyHash: "policy-loop36",
    policySource: "inherited_default",
    scoreState: input.scoreState ?? "scored",
    protocol: { protocolPass: input.verdict === "pass", reasonCodes: [] },
    hardFailReasons: [],
    applicability: {},
    outcomeScores: {
      taskSuccess: input.verdict === "pass" ? 4 : 2,
    },
    executionScores: {},
    ruleScores: {},
    finalScores: {},
    disagreement: {},
    weightedScore: input.weightedScore,
    autoVerdict: input.verdict,
    reviewReasons: input.verdict === "review" ? ["major_disagreement"] : [],
    degradedReasons: input.scoreState === "auto_degraded" ? ["judge_schema_repair"] : [],
    mergeProvenance: {},
    attribution: {
      primary: input.attribution,
      confidence: input.attribution === "not_applicable" ? "low" : "high",
      evidence: [],
    },
    judgeStatus: input.judgeStatus ?? "valid",
    createdAt: "2026-05-15T10:04:00.000Z",
  };
}

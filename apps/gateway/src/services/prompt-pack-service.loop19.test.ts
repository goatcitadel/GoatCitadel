import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { PromptPackReportRecord, PromptPackScoreRecordV3 } from "@goatcitadel/contracts";
import { renderPromptPackMarkdownReport } from "./prompt-pack-service.js";
import { createPack, createRun, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack report operator diagnostics", () => {
  it("renders runtime clusters, v3 attribution, stale generation, and trace fallback details", () => {
    const firstTest = {
      ...createTest("test-loop19-runtime", "TEST-C919"),
      mode: "chat",
      toolTier: "no-tools",
      title: "Unexpected tool use",
      prompt: "Answer directly from the prompt. No external tools are needed.",
    } as const;
    const secondTest = {
      ...createTest("test-loop19-not-run", "TEST-W919"),
      title: "Not run coverage",
      orderIndex: 1,
    } as const;
    const run = {
      ...createRun("run-loop19-runtime", "completed", "2026-05-14T18:00:00.000Z"),
      testId: firstTest.testId,
      providerId: "openai",
      model: "gpt-5.4",
      mode: "chat",
      toolTier: "no-tools",
      executionStyle: "agentic_surface",
      responseText: "Raw answer with enough detail to score.",
      derivedResponseText: "Derived harness hint for the operator.",
      derivedResponseSignals: ["prompt_lab_contract_fallback"],
      citations: [{ title: "Source One", url: "https://example.test/source" }],
      integrity: {
        validationStatus: "invalid",
        signals: ["tool_tier_violation"],
        completionStatus: "complete",
        finishReason: "stop",
        outputTokenCount: 42,
        responseChecksumSha256: "a".repeat(64),
      },
      trace: createTrace("sess-loop19-runtime", {
        status: "completed",
        mode: "chat",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
        routing: {
          primaryProviderId: "openai",
          primaryModel: "gpt-5.4",
          effectiveProviderId: "anthropic",
          effectiveModel: "claude-opus",
          effectiveApiStyle: "anthropic-messages",
          fallbackUsed: true,
          fallbackProviderId: "anthropic",
          fallbackModel: "claude-opus",
          fallbackReason: "primary_rate_limited",
        },
        durable: {
          runId: "durable-loop19",
          status: "completed",
          checkpointKind: "final",
        },
        retrieval: {
          l0Used: true,
          l1Used: false,
          l2Used: true,
        },
        reflection: {
          attempted: true,
          attemptCount: 2,
          outcome: "accepted",
        },
        toolRuns: [
          {
            toolRunId: "tool-file-loop19",
            turnId: "turn-sess-loop19-runtime",
            sessionId: "sess-loop19-runtime",
            toolName: "file.read_range",
            status: "executed",
            args: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              startLine: 3223,
            },
            result: {
              path: "apps/gateway/src/services/prompt-pack-service.ts",
              content: "renderPromptPackMarkdownReport(report)",
            },
            startedAt: "2026-05-14T18:00:00.000Z",
            finishedAt: "2026-05-14T18:00:00.125Z",
            reused: true,
            reusedFromToolRunId: "tool-previous",
            reuseReason: "same file already read",
          },
          {
            toolRunId: "tool-approval-loop19",
            turnId: "turn-sess-loop19-runtime",
            sessionId: "sess-loop19-runtime",
            toolName: "shell.exec",
            status: "approval_required",
            args: { command: "pnpm test" },
            approvalId: "approval-loop19",
            startedAt: "2026-05-14T18:00:01.000Z",
            failureGuidance: "Operator approval required before command execution.",
          },
          {
            toolRunId: "tool-failed-loop19",
            turnId: "turn-sess-loop19-runtime",
            sessionId: "sess-loop19-runtime",
            toolName: "browser.search",
            status: "failed",
            args: { query: "prompt pack diagnostics" },
            error: "network disabled",
            startedAt: "2026-05-14T18:00:02.000Z",
            finishedAt: "2026-05-14T18:00:02.020Z",
          },
        ],
      }),
    };
    const score: PromptPackScoreRecordV3 = {
      autoScoreId: "auto-loop19-runtime",
      packId: "pack-loop19-report",
      testId: firstTest.testId,
      runId: run.runId,
      scoringSchemaVersion: "v3",
      scorerVersion: "older-scorer",
      judgeRubricVersion: "older-rubric",
      policyHash: "older-policy",
      policySource: "inherited_default",
      scoreState: "auto_degraded",
      protocol: {
        protocolPass: false,
        reasonCodes: ["tool_tier_violation", "major_disagreement"],
      },
      hardFailReasons: ["tool_tier_violation"],
      applicability: {
        taskSuccess: true,
        truthfulness: true,
        evidenceGrounding: true,
        formatAdherence: true,
        operatorUsefulness: true,
        toolUseQuality: true,
        orchestrationQuality: true,
        efficiency: true,
        recoveryQuality: true,
      },
      outcomeScores: {
        taskSuccess: 3,
        truthfulness: 3,
        evidenceGrounding: 2,
        formatAdherence: 2,
        operatorUsefulness: 3,
      },
      executionScores: {
        toolUseQuality: 1,
        orchestrationQuality: 2,
        efficiency: 2,
        recoveryQuality: 2,
      },
      ruleScores: {
        taskSuccess: 3,
        truthfulness: 3,
        evidenceGrounding: 2,
        formatAdherence: 2,
        operatorUsefulness: 3,
        toolUseQuality: 1,
        orchestrationQuality: 2,
        efficiency: 2,
        recoveryQuality: 2,
      },
      judgeScores: {
        taskSuccess: 1,
        truthfulness: 4,
        evidenceGrounding: 3,
      },
      finalScores: {
        taskSuccess: 2,
        truthfulness: 3,
        evidenceGrounding: 2,
        formatAdherence: 2,
        operatorUsefulness: 3,
        toolUseQuality: 1,
        orchestrationQuality: 2,
        efficiency: 2,
        recoveryQuality: 2,
      },
      disagreement: {
        taskSuccess: 2,
        truthfulness: 1,
      },
      weightedScore: 61.5,
      autoVerdict: "review",
      reviewReasons: ["major_disagreement"],
      degradedReasons: ["judge_schema_repair"],
      mergeProvenance: {},
      attribution: {
        primary: "runtime_or_infra_failure",
        secondary: ["harness_or_judge_failure"],
        confidence: "high",
        evidence: ["approval-required shell command", "unexpected file/code tool on chat surface"],
      },
      judgeStatus: "repaired",
      judgeProviderId: "openai",
      judgeModel: "gpt-5.4-mini",
      notes: "Judge repaired a partial schema response.",
      createdAt: "2026-05-14T18:00:03.000Z",
    };
    const report: PromptPackReportRecord = {
      pack: {
        ...createPack("pack-loop19-report"),
        name: "Loop 19 Report Pack",
        testCount: 2,
      },
      tests: [firstTest, secondTest],
      runs: [run],
      scores: [],
      autoScoresV2: [score],
      humanReviewsV2: [],
      latestAssessments: [
        {
          testId: firstTest.testId,
          runId: run.runId,
          autoScore: score,
          currentGeneration: false,
          scoreState: "auto_degraded",
          autoVerdict: "review",
          effectiveVerdict: "review",
        },
      ],
      summary: {
        totalTests: 2,
        completedRuns: 1,
        failedRuns: 0,
        runFailureCount: 0,
        invalidLatestRuns: 1,
        scoreFailureCount: 0,
        needsScoreCount: 0,
        staleLatestAutoScoreCount: 1,
        durableRuns: 1,
        approvalPausedRuns: 0,
        backgroundedRuns: 0,
        judgeFallbackCount: 0,
        judgeErrorCount: 0,
        autoScoredRuns: 1,
        humanReviewedRuns: 0,
        degradedScoreCount: 1,
        passCount: 0,
        failCount: 0,
        reviewCount: 1,
        effectivePassRate: 0,
        reviewRate: 1,
        activeScoringSchemaVersion: "v3",
        attributionBreakdown: [{ attribution: "runtime_or_infra_failure", count: 1 }],
        passThreshold: 78,
        averageTotalScore: 0,
        averageWeightedScore: 61.5,
        passRate: 0,
        failingCodes: ["TEST-C919"],
      },
    };

    const markdown = renderPromptPackMarkdownReport(report, { generatedAt: "2026-05-14T18:05:00.000Z" });

    expect(markdown).toContain("- Export model lane: `openai/gpt-5.4`");
    expect(markdown).toContain("- Export execution style: `agentic`");
    expect(markdown).toContain("- Current-generation latest score rows: 0/1");
    expect(markdown).toContain("- Rescore recommended: yes");
    expect(markdown).toContain(
      "| unspecified | command/validation, file/code, web | 1 | unexpected file/code tools on non-code surface | TEST-C919 |",
    );
    expect(markdown).toContain("- Platform signal: unexpected file/code tool use on a non-code prompt");
    expect(markdown).toContain("- Review note: `major_disagreement` means judge and rule scores diverged");
    expect(markdown).toContain("- Failure attribution: `runtime_or_infra_failure` (high)");
    expect(markdown).toContain("- Secondary attribution: harness_or_judge_failure");
    expect(markdown).toContain(
      "- Attribution evidence: approval-required shell command; unexpected file/code tool on chat surface",
    );
    expect(markdown).toContain("- Fallback: anthropic / claude-opus");
    expect(markdown).toContain("- Fallback reason: primary_rate_limited");
    expect(markdown).toContain("- Durable run: durable-loop19");
    expect(markdown).toContain("- Reflection: accepted after 2 attempt(s)");
    expect(markdown).toContain("- `file.read_range` - executed - 125ms");
    expect(markdown).toContain("- reuse: yes from `tool-previous` (same file already read)");
    expect(markdown).toContain("- approval: `approval-loop19`");
    expect(markdown).toContain("- failure guidance: Operator approval required before command execution.");
    expect(markdown).toContain("- [Source One](https://example.test/source)");
    expect(markdown).toContain("- Not run: TEST-W919");
    expect(markdown).toContain("- Fail or review verdicts: TEST-C919");
  });
});

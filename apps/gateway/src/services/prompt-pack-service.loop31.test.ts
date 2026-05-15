import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import type { PromptPackRunRecord, PromptPackTestRecord } from "@goatcitadel/contracts";
import { DEFAULT_PROMPT_PACK_POLICY_V3 } from "@goatcitadel/contracts";
import {
  buildPromptPackReportSummary,
  evaluatePromptPackRuleScores,
  mergePromptPackAutoScoresV3,
  renderPromptPackMarkdownReport,
  resolvePromptPackExecutionProfile,
} from "./prompt-pack-service.js";
import { createPack, createRun, createScore, createTest, createTrace } from "./prompt-pack-service-test-fixtures.js";

describe("prompt-pack loop31 coverage tails", () => {
  it("classifies blocked unavailable required tools as missing tool failures", () => {
    const test: PromptPackTestRecord = {
      testId: "test-memory-tool-missing",
      packId: "pack-1",
      code: "TEST-MEM-01",
      title: "Memory lookup required",
      prompt: "Use memory.search to recall the workspace decision and summarize the result.",
      orderIndex: 0,
      mode: "cowork",
      toolTier: "explicit-tools",
      createdAt: "2026-05-15T00:00:00.000Z",
    };
    const profile = resolvePromptPackExecutionProfile({ test });
    const run: PromptPackRunRecord = {
      ...createRun("run-memory-tool-missing", "completed", "2026-05-15T00:00:01.000Z"),
      testId: test.testId,
      mode: "cowork",
      toolTier: "explicit-tools",
      responseText: "I could not access the memory tool, so the workspace decision remains unverified.",
      trace: createTrace("sess-memory-tool-missing", {
        mode: "cowork",
        toolRuns: [
          {
            toolRunId: "tool-memory-blocked",
            turnId: "turn-memory-tool-missing",
            sessionId: "sess-memory-tool-missing",
            toolName: "memory.search",
            status: "blocked",
            error: "unsupported executor: memory.search is not available in this profile",
            failureGuidance: "Missing tool; not callable by the current profile.",
            startedAt: "2026-05-15T00:00:00.000Z",
            finishedAt: "2026-05-15T00:00:01.000Z",
          },
        ],
      }),
    };
    const ruleEvaluation = evaluatePromptPackRuleScores({ prompt: test.prompt, profile, run });

    const merged = mergePromptPackAutoScoresV3({
      pack: createPack("pack-1"),
      test,
      run,
      policy: DEFAULT_PROMPT_PACK_POLICY_V3,
      profile,
      ruleEvaluation: {
        protocol: {
          protocolPass: true,
          reasonCodes: [],
        },
        hardFailReasons: ["missing_required_tool_usage"],
        reviewReasons: [],
        degradedReasons: [],
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
        ruleScores: {
          taskSuccess: 1,
          truthfulness: 4,
          evidenceGrounding: 2,
          formatAdherence: 3,
          operatorUsefulness: 2,
          toolUseQuality: 1,
          orchestrationQuality: 2,
          efficiency: 3,
          recoveryQuality: 1,
        },
        reasonCaps: {
          taskSuccess: ["missing_required_tool_usage"],
          toolUseQuality: ["missing_required_tool_usage"],
          recoveryQuality: ["missing_required_tool_usage"],
        },
        attribution: {
          primary: "not_applicable",
          confidence: "high",
          evidence: [],
        },
        deterministicAttribution: false,
      } as never,
      judgeEvaluation: {
        judgeStatus: "skipped",
      },
    });

    expect(ruleEvaluation.signals).toContain("missing_required_tool_usage");
    expect(ruleEvaluation.signals).toContain("missing_required_tool:memory.search");
    expect(merged.attribution.primary).toBe("missing_tool");
    expect(merged.attribution.evidence).toEqual(expect.arrayContaining(["memory.search:blocked"]));
  });

  it("renders diagnostic metadata defaults and failed run summaries in markdown reports", () => {
    const pack = createPack("pack-report");
    const tests: PromptPackTestRecord[] = [
      {
        ...createTest("test-diagnostic", "TEST-DIAG"),
        packId: pack.packId,
        title: "Diagnostic Metadata",
        prompt: [
          "<!-- capability-target: routing -->",
          "<!-- expected-runtime-signal: tool.retry -->",
          "<!-- likely-failure-class: missing_tool -->",
          "Use browser.search to validate the current provider docs.",
        ].join("\n"),
      },
      {
        ...createTest("test-empty-diagnostic", "TEST-NONE"),
        packId: pack.packId,
        title: "No Diagnostic Metadata",
        prompt: "Answer from local context only.",
      },
    ];
    const failedRun: PromptPackRunRecord = {
      ...createRun("run-diagnostic-failed", "failed", "2026-05-15T00:00:02.000Z"),
      packId: pack.packId,
      testId: "test-diagnostic",
      responseText: "",
      error: undefined,
      trace: createTrace("sess-diagnostic", {
        toolRuns: [
          {
            toolRunId: "tool-browser-failed",
            turnId: "turn-diagnostic",
            sessionId: "sess-diagnostic",
            toolName: "browser.search",
            status: "failed",
            error: "provider timeout",
            startedAt: "2026-05-15T00:00:00.000Z",
            finishedAt: "2026-05-15T00:00:01.000Z",
          },
        ],
      }),
    };
    const pausedRun: PromptPackRunRecord = {
      ...createRun("run-empty-paused", "approval_paused", "2026-05-15T00:00:03.000Z"),
      packId: pack.packId,
      testId: "test-empty-diagnostic",
      error: undefined,
    };
    const scores = [
      createScore("score-diagnostic", failedRun.runId, "2026-05-15T00:00:04.000Z", 0),
      createScore("score-empty", pausedRun.runId, "2026-05-15T00:00:05.000Z", 1),
    ];
    scores[0]!.packId = pack.packId;
    scores[0]!.testId = "test-diagnostic";
    scores[1]!.packId = pack.packId;
    scores[1]!.testId = "test-empty-diagnostic";

    const summary = buildPromptPackReportSummary(tests, [failedRun, pausedRun], scores, [], [], [], {
      scoringSchemaVersion: "v3",
    });
    const markdown = renderPromptPackMarkdownReport(
      {
        pack,
        tests,
        runs: [failedRun, pausedRun],
        scores,
        autoScoresV2: [],
        autoScoresV3: [],
        humanReviewsV2: [],
        latestAssessments: [],
        summary,
      } as never,
      { generatedAt: "2026-05-15T00:00:06.000Z" },
    );

    expect(markdown).toContain("- Expected tool families: web");
    expect(markdown).toContain("- Actual tool families observed: web");
    expect(markdown).toContain("- Expected tool families: unspecified");
  });
});

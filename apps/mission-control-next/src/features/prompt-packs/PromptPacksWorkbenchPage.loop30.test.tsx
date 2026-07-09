import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScoreDraft } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import {
  DiagnosticChipGroup,
  buildLatestPromptPackAssessmentByTest,
  buildLatestPromptPackRunByTest,
  buildPromptPackRunRoute,
  buildPromptPackSelectedRunLink,
  chooseNextPromptPackTest,
  computeDraftVerdict,
  computeDraftWeightedScore,
  filterPromptPackTestsByResult,
  formatPromptPackAttribution,
  formatPromptPackExecutionStyle,
  getPromptPackScoreDimensionLabels,
  isPromptPackV2UiEnabled,
  readPromptPackScoreDimension,
  resultCategoryClass,
  statusChipClass,
  summarizePromptPackTestOutcomes,
} from "./PromptPacksWorkbenchPage";

describe("PromptPacksWorkbenchPage loop 30 helper matrix", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("selects latest runs, categorizes outcomes, and chooses the next actionable test", () => {
    const tests = ["paused", "failed", "score", "review", "needs-score", "not-run", "passing"].map((testId) => ({
      testId,
      code: testId,
      title: testId,
      prompt: "Prompt",
      mode: "chat",
      orderIndex: 1,
    })) as any[];
    const runs = buildLatestPromptPackRunByTest([
      { testId: "failed", status: "completed", startedAt: "2026-05-15T09:00:00.000Z" },
      { testId: "failed", status: "failed", startedAt: "2026-05-15T10:00:00.000Z" },
      { testId: "paused", status: "approval_paused", startedAt: "2026-05-15T10:00:00.000Z" },
      { testId: "score", status: "completed", startedAt: "2026-05-15T10:00:00.000Z" },
      { testId: "review", status: "completed", startedAt: "2026-05-15T10:00:00.000Z" },
      { testId: "needs-score", status: "completed", startedAt: "2026-05-15T10:00:00.000Z" },
      { testId: "passing", status: "completed", startedAt: "2026-05-15T10:00:00.000Z" },
    ] as any);
    const assessments = buildLatestPromptPackAssessmentByTest([
      { testId: "score", effectiveVerdict: "fail", currentGeneration: true, autoScore: { weightedScore: 44 } },
      { testId: "review", effectiveVerdict: "review", currentGeneration: true, autoScore: { weightedScore: 70 } },
      { testId: "passing", effectiveVerdict: "pass", currentGeneration: true, autoScore: { weightedScore: 95 } },
      { testId: "old", effectiveVerdict: "pass", currentGeneration: false },
    ] as any);

    expect(runs.get("failed")?.status).toBe("failed");
    expect(summarizePromptPackTestOutcomes(tests, runs, assessments)).toEqual({
      approvalPausedCount: 1,
      runFailureCount: 1,
      scoreFailureCount: 1,
      reviewCount: 1,
      needsScoreCount: 1,
      notRunCount: 1,
      passingCount: 1,
    });
    expect(filterPromptPackTestsByResult(tests, "all", runs, assessments)).toHaveLength(7);
    expect(filterPromptPackTestsByResult(tests, "run_failed", runs, assessments)).toEqual([tests[1]]);
    expect(chooseNextPromptPackTest(tests, runs, assessments)).toBe(tests[5]);
    expect(
      chooseNextPromptPackTest(
        tests.filter((test) => test.testId !== "not-run"),
        runs,
        assessments,
      ),
    ).toBe(tests[1]);
  });

  it("formats diagnostic chips, routes, statuses, scores, and feature flags", () => {
    expect(renderToStaticMarkup(<DiagnosticChipGroup label="Signals" values={["trace_update"]} />)).toContain(
      "trace_update",
    );
    expect(renderToStaticMarkup(<DiagnosticChipGroup label="Signals" values={[]} />)).toContain("none");
    expect(formatPromptPackExecutionStyle("agentic_surface")).toBe("Agentic");
    expect(formatPromptPackExecutionStyle("single_turn_harness")).toBe("Harness");
    expect(formatPromptPackExecutionStyle(undefined)).toBe("Harness");
    expect(formatPromptPackAttribution("model_weakness")).toBe("Model Weakness");
    expect(getPromptPackScoreDimensionLabels("v3").some(([key]) => key === "truthfulness")).toBe(true);
    expect(getPromptPackScoreDimensionLabels("v2").some(([key]) => key === "honesty")).toBe(true);
    expect(readPromptPackScoreDimension(undefined, "truthfulness")).toBe("-");
    expect(readPromptPackScoreDimension({ truthfulness: 3.5 } as any, "truthfulness")).toBe(3.5);
    expect(readPromptPackScoreDimension({ honesty: 4 } as any, "honesty")).toBe(4);
    expect(readPromptPackScoreDimension({ truthfulness: undefined } as any, "truthfulness")).toBe("-");
    expect(statusChipClass(undefined)).toBe("run-not-run");
    expect(statusChipClass("running")).toBe("run-not-run");
    expect(statusChipClass("approval_paused")).toBe("run-paused");
    expect(statusChipClass("failed")).toBe("run-failed");
    expect(statusChipClass("completed")).toBe("run-completed");
    expect(resultCategoryClass("not_run")).toBe("result-not-run");
    expect(resultCategoryClass("run_failed")).toBe("result-run-failed");
    expect(resultCategoryClass("score_failed")).toBe("result-score-failed");
    expect(resultCategoryClass("review")).toBe("result-review");
    expect(resultCategoryClass("needs_score")).toBe("result-needs-score");
    expect(resultCategoryClass("approval_paused")).toBe("result-run-paused");
    expect(resultCategoryClass("passing")).toBe("result-passing");

    const draft: ScoreDraft = {
      taskSuccess: 4,
      honesty: 4,
      executionQuality: 4,
      robustness: 4,
      usability: 4,
      overrideVerdict: "",
      notes: "",
    };
    expect(computeDraftWeightedScore(draft)).toBe(100);
    expect(computeDraftWeightedScore({ ...draft, robustness: null })).toBeNull();
    expect(computeDraftVerdict(draft, "")).toBe("pass");
    expect(computeDraftVerdict({ ...draft, taskSuccess: 1, honesty: 1, executionQuality: 1, robustness: 1 }, "")).toBe(
      "fail",
    );
    expect(computeDraftVerdict(draft, "review")).toBe("review");

    expect(buildPromptPackRunRoute({ mode: "cowork", sessionId: "session-cowork" } as any)).toEqual({
      area: "chat",
      sessionId: "session-cowork",
    });
    expect(buildPromptPackRunRoute({ mode: "unknown", sessionId: "session-chat" } as any)).toEqual({
      area: "chat",
      sessionId: "session-chat",
    });
    expect(buildPromptPackRunRoute({ mode: "chat" } as any)).toBeNull();
    expect(buildPromptPackSelectedRunLink(null, "http://localhost:5173")).toBeNull();
    expect(buildPromptPackSelectedRunLink("/chat?sessionId=session-1", "http://localhost:5173")).toBe(
      "http://localhost:5173/chat?sessionId=session-1",
    );
    expect(buildPromptPackSelectedRunLink("https://example.test/run")).toBe("https://example.test/run");

    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "disabled");
    expect(isPromptPackV2UiEnabled()).toBe(false);
    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", " yes ");
    expect(isPromptPackV2UiEnabled()).toBe(true);
  });
});

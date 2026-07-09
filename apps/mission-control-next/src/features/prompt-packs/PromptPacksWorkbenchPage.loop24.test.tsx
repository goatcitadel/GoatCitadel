import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import {
  buildPromptPackRunRoute,
  buildPromptPackSelectedRunLink,
  chooseNextPromptPackTest,
  computeDraftVerdict,
  computeDraftWeightedScore,
  DiagnosticChipGroup,
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

function textOf(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map(textOf).join(" ");
  }
  return "";
}

function testRecord(testId: string) {
  return {
    testId,
    code: testId.toUpperCase(),
    title: testId,
    prompt: "Prompt",
    orderIndex: 1,
    mode: "chat",
  } as any;
}

function runRecord(testId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    runId: `${testId}-${status}`,
    packId: "pack-1",
    testId,
    status,
    mode: "chat",
    startedAt: "2026-05-15T00:00:00.000Z",
    ...extra,
  } as any;
}

function assessmentRecord(testId: string, verdict: string, autoScore: unknown = { weightedScore: 90 }) {
  return {
    testId,
    effectiveVerdict: verdict,
    currentGeneration: true,
    autoScore,
  } as any;
}

describe("PromptPacksWorkbenchPage loop 24 helper tails", () => {
  it("classifies each prompt-pack result bucket and chooses the next actionable test", () => {
    const tests = [
      testRecord("paused"),
      testRecord("run-failed"),
      testRecord("score-failed"),
      testRecord("review"),
      testRecord("needs-score"),
      testRecord("not-run"),
      testRecord("passing"),
    ];
    const latestRunByTest = new Map([
      ["paused", runRecord("paused", "approval_paused")],
      ["run-failed", runRecord("run-failed", "failed")],
      ["score-failed", runRecord("score-failed", "completed")],
      ["review", runRecord("review", "completed")],
      ["needs-score", runRecord("needs-score", "completed")],
      ["passing", runRecord("passing", "completed")],
    ]);
    const latestAssessmentByTest = new Map([
      ["score-failed", assessmentRecord("score-failed", "fail", { weightedScore: 30, autoVerdict: "fail" })],
      ["review", assessmentRecord("review", "review", { weightedScore: 62, autoVerdict: "review" })],
      ["passing", assessmentRecord("passing", "pass", { weightedScore: 96, autoVerdict: "pass" })],
    ]);

    expect(summarizePromptPackTestOutcomes(tests, latestRunByTest, latestAssessmentByTest)).toEqual({
      approvalPausedCount: 1,
      runFailureCount: 1,
      scoreFailureCount: 1,
      reviewCount: 1,
      needsScoreCount: 1,
      notRunCount: 1,
      passingCount: 1,
    });
    expect(filterPromptPackTestsByResult(tests, "approval_paused", latestRunByTest, latestAssessmentByTest)).toEqual([
      tests[0],
    ]);
    expect(filterPromptPackTestsByResult(tests, "run_failed", latestRunByTest, latestAssessmentByTest)).toEqual([
      tests[1],
    ]);
    expect(filterPromptPackTestsByResult(tests, "score_failed", latestRunByTest, latestAssessmentByTest)).toEqual([
      tests[2],
    ]);
    expect(filterPromptPackTestsByResult(tests, "review", latestRunByTest, latestAssessmentByTest)).toEqual([tests[3]]);
    expect(filterPromptPackTestsByResult(tests, "needs_score", latestRunByTest, latestAssessmentByTest)).toEqual([
      tests[4],
    ]);
    expect(filterPromptPackTestsByResult(tests, "not_run", latestRunByTest, latestAssessmentByTest)).toEqual([
      tests[5],
    ]);
    expect(filterPromptPackTestsByResult(tests, "passing", latestRunByTest, latestAssessmentByTest)).toEqual([
      tests[6],
    ]);
    expect(chooseNextPromptPackTest(tests, latestRunByTest, latestAssessmentByTest)).toBe(tests[5]);

    latestRunByTest.set("not-run", runRecord("not-run", "completed"));
    expect(chooseNextPromptPackTest(tests, latestRunByTest, latestAssessmentByTest)).toBe(tests[1]);
    latestRunByTest.set("run-failed", runRecord("run-failed", "completed"));
    expect(chooseNextPromptPackTest(tests, latestRunByTest, latestAssessmentByTest)).toBe(tests[1]);
  });

  it("formats diagnostic, score, routing, and style helper branches", () => {
    expect(buildPromptPackSelectedRunLink(null, "http://localhost:5173")).toBeNull();
    expect(buildPromptPackSelectedRunLink("/chat/session-1")).toBe("/chat/session-1");
    expect(buildPromptPackSelectedRunLink("/chat/session-1", "http://localhost:5173")).toBe(
      "http://localhost:5173/chat/session-1",
    );
    expect(formatPromptPackExecutionStyle("agentic_surface")).toBe("Agentic");
    expect(formatPromptPackExecutionStyle()).toBe("Harness");
    expect(getPromptPackScoreDimensionLabels("v3").map(([, label]) => label)).toContain("Truthfulness");
    expect(getPromptPackScoreDimensionLabels("v2").map(([, label]) => label)).toContain("Honesty");
    expect(readPromptPackScoreDimension(undefined, "taskSuccess")).toBe("-");
    expect(readPromptPackScoreDimension({ taskSuccess: 87 } as any, "taskSuccess")).toBe(87);
    expect(readPromptPackScoreDimension({} as any, "taskSuccess")).toBe("-");
    expect(formatPromptPackAttribution("model_timeout")).toBe("Model Timeout");
    expect(statusChipClass()).toBe("run-not-run");
    expect(statusChipClass("completed")).toBe("run-completed");
    expect(statusChipClass("approval_paused")).toBe("run-paused");
    expect(statusChipClass("failed")).toBe("run-failed");
    expect(statusChipClass("running")).toBe("run-not-run");
    expect(resultCategoryClass("approval_paused")).toBe("result-run-paused");
    expect(resultCategoryClass("run_failed")).toBe("result-run-failed");
    expect(resultCategoryClass("score_failed")).toBe("result-score-failed");
    expect(resultCategoryClass("review")).toBe("result-review");
    expect(resultCategoryClass("needs_score")).toBe("result-needs-score");
    expect(resultCategoryClass("passing")).toBe("result-passing");
    expect(resultCategoryClass("not_run")).toBe("result-not-run");

    const passingDraft = {
      taskSuccess: 3,
      honesty: 3,
      executionQuality: 3,
      robustness: 3,
      usability: 3,
      overrideVerdict: "",
      reviewerNotes: "",
    } as any;
    expect(computeDraftWeightedScore(passingDraft)).toBe(75);
    expect(computeDraftVerdict(passingDraft, "")).toBe("pass");
    expect(computeDraftVerdict({ ...passingDraft, taskSuccess: null }, "")).toBe("incomplete");
    expect(computeDraftVerdict({ ...passingDraft, taskSuccess: 2.4 }, "")).toBe("review");
    expect(computeDraftVerdict({ ...passingDraft, taskSuccess: 0 }, "")).toBe("fail");
    expect(computeDraftVerdict(passingDraft, "fail")).toBe("fail");

    expect(buildPromptPackRunRoute()).toBeNull();
    expect(buildPromptPackRunRoute({ mode: "chat", sessionId: "chat-1" } as any)).toEqual({
      area: "chat",
      sessionId: "chat-1",
    });
    expect(buildPromptPackRunRoute({ mode: "cowork", sessionId: "cowork-1" } as any)).toEqual({
      area: "chat",
      sessionId: "cowork-1",
    });
    expect(buildPromptPackRunRoute({ mode: "code", sessionId: "code-1" } as any)).toEqual({
      area: "chat",
      sessionId: "code-1",
    });
    expect(buildPromptPackRunRoute({ mode: "unknown", sessionId: "fallback-1" } as any)).toEqual({
      area: "chat",
      sessionId: "fallback-1",
    });
    expect(isPromptPackV2UiEnabled()).toBe(true);

    const populatedChips = create(<DiagnosticChipGroup label="Providers" values={["OpenAI", "", "Anthropic"]} />);
    expect(textOf(populatedChips.toJSON())).toContain("OpenAI");
    expect(textOf(populatedChips.toJSON())).toContain("Anthropic");
    expect(textOf(populatedChips.toJSON())).not.toContain("none");
    expect(textOf(create(<DiagnosticChipGroup label="Providers" values={undefined} />).toJSON())).toContain("none");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildLatestPromptPackRunByTest,
  chooseNextPromptPackTest,
  filterPromptPackTestsByResult,
  summarizePromptPackTestOutcomes,
} from "./PromptPacksWorkbenchPage";

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

function runRecord(testId: string, status: string, dates: Record<string, string | undefined> = {}) {
  return {
    runId: `${testId}-${status}`,
    packId: "pack-1",
    testId,
    status,
    mode: "chat",
    ...dates,
  } as any;
}

function assessmentRecord(testId: string, verdict: string, autoScore = { weightedScore: 90 }) {
  return {
    testId,
    effectiveVerdict: verdict,
    currentGeneration: true,
    autoScore,
  } as any;
}

describe("PromptPacksWorkbenchPage loop 23 helper tails", () => {
  it("orders latest runs by started, finished, then fallback timestamp without dropping first-seen records", () => {
    const latest = buildLatestPromptPackRunByTest([
      runRecord("finished-only", "failed", { finishedAt: "2026-05-15T00:01:00.000Z" }),
      runRecord("finished-only", "completed", { finishedAt: "2026-05-15T00:02:00.000Z" }),
      runRecord("invalid-date", "failed", { startedAt: "not-a-date" }),
      runRecord("invalid-date", "completed", {}),
      runRecord("started-wins", "failed", { finishedAt: "2026-05-15T00:05:00.000Z" }),
      runRecord("started-wins", "completed", { startedAt: "2026-05-15T00:06:00.000Z" }),
    ]);

    expect(latest.get("finished-only")?.status).toBe("completed");
    expect(latest.get("invalid-date")?.status).toBe("failed");
    expect(latest.get("started-wins")?.status).toBe("completed");
    expect(buildLatestPromptPackRunByTest(undefined).size).toBe(0);
  });

  it("falls back to the first test when every prompt-pack item already has a passing score", () => {
    const tests = [testRecord("alpha"), testRecord("beta")];
    const latestRunByTest = buildLatestPromptPackRunByTest([
      runRecord("alpha", "completed", { startedAt: "2026-05-15T00:01:00.000Z" }),
      runRecord("beta", "completed", { startedAt: "2026-05-15T00:02:00.000Z" }),
    ]);
    const latestAssessmentByTest = new Map([
      ["alpha", assessmentRecord("alpha", "pass")],
      ["beta", assessmentRecord("beta", "pass")],
    ]);

    expect(filterPromptPackTestsByResult(tests, "all", latestRunByTest, latestAssessmentByTest)).toEqual(tests);
    expect(summarizePromptPackTestOutcomes(tests, latestRunByTest, latestAssessmentByTest)).toMatchObject({
      passingCount: 2,
      notRunCount: 0,
    });
    expect(chooseNextPromptPackTest(tests, latestRunByTest, latestAssessmentByTest)).toBe(tests[0]);
  });
});

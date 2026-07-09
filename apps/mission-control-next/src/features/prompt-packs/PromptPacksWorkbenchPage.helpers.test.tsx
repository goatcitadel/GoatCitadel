import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScoreDraft } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import {
  DiagnosticChipGroup,
  PromptSourceEditor,
  buildLatestPromptPackAssessmentByTest,
  buildLatestPromptPackRunByTest,
  buildPromptPackSelectedRunLink,
  buildPromptPackRunRoute,
  chooseNextPromptPackTest,
  computeDraftVerdict,
  computeDraftWeightedScore,
  filterPromptPackTestsByResult,
  formatPromptPackAttribution,
  formatPromptPackExecutionStyle,
  getPromptPackScoreDimensionLabels,
  isPromptPackV2UiEnabled,
  parsePromptForChips,
  readPromptPackScoreDimension,
  resultCategoryClass,
  statusChipClass,
  summarizePromptPackTestOutcomes,
} from "./PromptPacksWorkbenchPage";
import { computePassReadiness } from "./PromptPacksWorkbenchPage.helpers";

describe("PromptPacksWorkbenchPage helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("formats prompt-pack diagnostic, execution, score, status, and attribution helpers", () => {
    expect(
      renderToStaticMarkup(<DiagnosticChipGroup label="Signals" values={["tool_call", "", "trace_update"]} />),
    ).toContain("trace_update");
    expect(renderToStaticMarkup(<DiagnosticChipGroup label="Signals" values={undefined} />)).toContain("none");

    expect(formatPromptPackExecutionStyle("agentic_surface")).toBe("Agentic");
    expect(formatPromptPackExecutionStyle("single_turn_harness")).toBe("Harness");
    expect(formatPromptPackExecutionStyle(undefined)).toBe("Harness");
    expect(formatPromptPackAttribution("harness_bug")).toBe("Harness Bug");

    expect(getPromptPackScoreDimensionLabels("v3").map((row) => row[0])).toContain("truthfulness");
    expect(getPromptPackScoreDimensionLabels("v2").map((row) => row[0])).toContain("honesty");
    expect(readPromptPackScoreDimension({ truthfulness: 4 } as any, "truthfulness")).toBe(4);
    expect(readPromptPackScoreDimension({ truthfulness: undefined } as any, "truthfulness")).toBe("-");
    expect(readPromptPackScoreDimension(undefined, "truthfulness")).toBe("-");

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
  });

  it("computes pass readiness with the same blockers as the prompt-pack gate", () => {
    const readySummary = {
      totalTests: 4,
      completedRuns: 4,
      failedRuns: 0,
      runFailureCount: 0,
      invalidLatestRuns: 0,
      scoreFailureCount: 0,
      needsScoreCount: 0,
      staleLatestAutoScoreCount: 0,
      durableRuns: 0,
      approvalPausedRuns: 0,
      backgroundedRuns: 0,
      judgeFallbackCount: 0,
      judgeErrorCount: 0,
      autoScoredRuns: 4,
      humanReviewedRuns: 0,
      degradedScoreCount: 0,
      passCount: 4,
      failCount: 0,
      reviewCount: 0,
      effectivePassRate: 1,
      reviewRate: 0,
      activeScoringSchemaVersion: "v3",
      passThreshold: 75,
      averageTotalScore: 0,
      averageWeightedScore: 92,
      passRate: 1,
      failingCodes: [],
    } as any;

    expect(computePassReadiness(readySummary)).toEqual({ blockers: [], complete: true });

    const blocked = computePassReadiness({
      ...readySummary,
      completedRuns: 4,
      autoScoredRuns: 2,
      runFailureCount: 1,
      invalidLatestRuns: 1,
      judgeErrorCount: 1,
      degradedScoreCount: 1,
    });

    expect(blocked.complete).toBe(false);
    expect(blocked.blockers).toContain("1 runtime failure(s)");
    expect(blocked.blockers).toContain("1 invalid latest run(s)");
    expect(blocked.blockers).toContain("1 completed run(s) without current auto-score");
    expect(blocked.blockers).toContain("1 judge error(s)");
    expect(blocked.blockers).toContain("1 degraded score(s)");
  });

  it("computes draft verdicts, run routes, and v2 feature flag defaults", () => {
    const completeDraft: ScoreDraft = {
      taskSuccess: 4,
      honesty: 3,
      executionQuality: 3,
      robustness: 4,
      usability: 4,
      overrideVerdict: "",
      notes: "",
    };

    expect(computeDraftWeightedScore(completeDraft)).toBe(90);
    expect(computeDraftWeightedScore({ ...completeDraft, honesty: null })).toBeNull();
    expect(computeDraftVerdict(completeDraft, "")).toBe("pass");
    expect(computeDraftVerdict({ ...completeDraft, taskSuccess: 2, honesty: 2, executionQuality: 2 }, "")).toBe(
      "review",
    );
    expect(computeDraftVerdict({ ...completeDraft, taskSuccess: 1, honesty: 1, executionQuality: 1 }, "")).toBe("fail");
    expect(computeDraftVerdict({ ...completeDraft, taskSuccess: null }, "")).toBe("incomplete");
    expect(computeDraftVerdict(completeDraft, "fail")).toBe("fail");
    expect(computeDraftVerdict(completeDraft, "pass")).toBe("pass");
    expect(computeDraftVerdict(completeDraft, "review")).toBe("review");

    expect(buildPromptPackRunRoute()).toBeNull();
    expect(buildPromptPackRunRoute({ mode: "chat" } as any)).toBeNull();
    expect(buildPromptPackRunRoute({ mode: "chat", sessionId: "session-chat" } as any)).toEqual({
      area: "chat",
      sessionId: "session-chat",
    });
    expect(buildPromptPackRunRoute({ mode: "cowork", sessionId: "session-cowork" } as any)).toEqual({
      area: "chat",
      sessionId: "session-cowork",
    });
    expect(buildPromptPackRunRoute({ mode: "code", sessionId: "session-code" } as any)).toEqual({
      area: "chat",
      sessionId: "session-code",
    });
    expect(buildPromptPackRunRoute({ mode: "unknown", sessionId: "session-unknown" } as any)).toEqual({
      area: "chat",
      sessionId: "session-unknown",
    });

    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "");
    expect(isPromptPackV2UiEnabled()).toBe(true);
    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "off");
    expect(isPromptPackV2UiEnabled()).toBe(false);
    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "0");
    expect(isPromptPackV2UiEnabled()).toBe(false);
    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "disabled");
    expect(isPromptPackV2UiEnabled()).toBe(false);
    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", " no ");
    expect(isPromptPackV2UiEnabled()).toBe(false);
    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "false");
    expect(isPromptPackV2UiEnabled()).toBe(false);
    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "true");
    expect(isPromptPackV2UiEnabled()).toBe(true);
  });

  it("summarizes latest runs, filters result categories, and selects the next runnable review target", () => {
    const test = (testId: string, code = testId) =>
      ({
        testId,
        code,
        title: code,
        prompt: "Prompt",
        orderIndex: 1,
        mode: "chat",
      }) as any;
    const run = (testId: string, status: string, startedAt: string, extra: Record<string, unknown> = {}) =>
      ({
        testId,
        status,
        startedAt,
        integrity: { validationStatus: "valid" },
        ...extra,
      }) as any;
    const assessment = (testId: string, effectiveVerdict: string, extra: Record<string, unknown> = {}) =>
      ({
        testId,
        effectiveVerdict,
        currentGeneration: true,
        ...extra,
      }) as any;

    const allTests = [
      test("paused"),
      test("failed"),
      test("score-failed"),
      test("review"),
      test("needs-score"),
      test("not-run"),
      test("passing"),
    ];
    const latestRunByTest = buildLatestPromptPackRunByTest([
      run("failed", "completed", "2026-05-14T09:00:00.000Z"),
      run("failed", "failed", "2026-05-14T10:00:00.000Z"),
      run("paused", "approval_paused", "2026-05-14T10:00:00.000Z"),
      run("score-failed", "completed", "2026-05-14T10:00:00.000Z"),
      run("review", "completed", "2026-05-14T10:00:00.000Z"),
      run("needs-score", "completed", "2026-05-14T10:00:00.000Z"),
      run("passing", "completed", "2026-05-14T10:00:00.000Z"),
    ]);
    const latestAssessmentByTest = buildLatestPromptPackAssessmentByTest([
      assessment("score-failed", "fail", { autoScore: { weightedScore: 40 } }),
      assessment("review", "review", { autoScore: { weightedScore: 67 } }),
      assessment("passing", "pass", { autoScore: { weightedScore: 90 } }),
    ]);

    expect(latestRunByTest.get("failed")?.status).toBe("failed");
    expect(summarizePromptPackTestOutcomes(allTests, latestRunByTest, latestAssessmentByTest)).toEqual({
      approvalPausedCount: 1,
      runFailureCount: 1,
      scoreFailureCount: 1,
      reviewCount: 1,
      needsScoreCount: 1,
      notRunCount: 1,
      passingCount: 1,
    });
    expect(filterPromptPackTestsByResult(allTests, "review", latestRunByTest, latestAssessmentByTest)).toEqual([
      allTests[3],
    ]);
    expect(chooseNextPromptPackTest(allTests, latestRunByTest, latestAssessmentByTest)).toBe(allTests[5]);
    expect(
      chooseNextPromptPackTest(
        allTests.filter((item) => item.testId !== "not-run"),
        latestRunByTest,
        latestAssessmentByTest,
      ),
    ).toBe(allTests[1]);
    expect(
      chooseNextPromptPackTest(
        allTests.filter((item) => !["not-run", "failed"].includes(item.testId)),
        latestRunByTest,
        latestAssessmentByTest,
      ),
    ).toBe(allTests[4]);
    expect(buildPromptPackSelectedRunLink("/chat?sessionId=session-1", "http://localhost:5173")).toBe(
      "http://localhost:5173/chat?sessionId=session-1",
    );
    expect(buildPromptPackSelectedRunLink("/chat?sessionId=session-1")).toBe("/chat?sessionId=session-1");
    expect(buildPromptPackSelectedRunLink(null, "http://localhost:5173")).toBeNull();
  });

  it("parses prompt source into chip-aware rows", () => {
    expect(parsePromptForChips(undefined)).toEqual([]);
    expect(parsePromptForChips("")).toEqual([]);

    const rows = parsePromptForChips(
      [
        "# routing judge",
        "Review <LOCAL PATH> and cite the truth.",
        "System: Be honest. <UNKNOWN_TOKEN>",
        "```",
        "code line <PASTE_TOPIC>",
        "```",
        "Plain trailing line.",
      ].join("\n"),
      ["<LOCAL PATH>"],
    );

    expect(rows[0]).toMatchObject({ kind: "comment", lineNumber: 1, value: "# routing judge" });
    expect(rows[1]).toMatchObject({ kind: "line", lineNumber: 2 });
    const inline = (rows[1] as { segments: Array<{ kind: string; name?: string; declared?: boolean }> }).segments;
    expect(
      inline.some(
        (segment) => segment.kind === "variable" && segment.name === "LOCAL PATH" && segment.declared === true,
      ),
    ).toBe(true);
    expect(inline.find((segment) => segment.kind === "text")?.kind).toBe("text");

    expect(rows[2]).toMatchObject({ kind: "role-marker", lineNumber: 3, role: "System" });
    const roleSegments = (rows[2] as { segments: Array<{ kind: string; declared?: boolean }> }).segments;
    expect(roleSegments.some((segment) => segment.kind === "variable" && segment.declared === false)).toBe(true);

    expect(rows[3]).toMatchObject({ kind: "code-fence", lineNumber: 4 });
    expect(rows[4]).toMatchObject({ kind: "code", lineNumber: 5 });
    expect(rows[5]).toMatchObject({ kind: "code-fence", lineNumber: 6 });
    expect(rows[6]).toMatchObject({ kind: "line", lineNumber: 7 });

    // Tokens that do not look like placeholders stay as text.
    const lower = parsePromptForChips("Email me at <a@b.c>");
    expect(lower[0]?.kind).toBe("line");
    const lowerSegments = (lower[0] as { segments: Array<{ kind: string }> }).segments;
    expect(lowerSegments.every((segment) => segment.kind === "text")).toBe(true);

    // CRLF input is normalised; row count matches LF input.
    const crlf = parsePromptForChips("line one\r\nline two");
    expect(crlf).toHaveLength(2);
    expect(crlf[1]?.lineNumber).toBe(2);
  });

  it("renders PromptSourceEditor with chips, role markers, and an empty fallback", () => {
    const empty = renderToStaticMarkup(<PromptSourceEditor prompt={undefined} />);
    expect(empty).toContain("mc-pp-prompt-editor");
    expect(empty).toContain("No prompt source available.");

    const filled = renderToStaticMarkup(
      <PromptSourceEditor
        prompt={"# header\nReview <LOCAL PATH>.\nSystem: be honest.\n"}
        declaredPlaceholders={["<LOCAL PATH>"]}
      />,
    );
    expect(filled).toContain("mc-next-prompt-variable");
    expect(filled).toContain('aria-label="Variable: LOCAL PATH"');
    expect(filled).toContain("mc-pp-prompt-comment");
    expect(filled).toContain("mc-pp-prompt-role");
    expect(filled).toContain('aria-label="Prompt source"');

    // Undeclared placeholder gets the caution-tinted modifier and the
    // "(not declared)" prefix in the accessible label.
    const undeclared = renderToStaticMarkup(<PromptSourceEditor prompt={"Use <PASTE_TOPIC> for context."} />);
    expect(undeclared).toContain("is-undeclared");
    expect(undeclared).toContain("Variable (not declared): PASTE_TOPIC");
  });
});

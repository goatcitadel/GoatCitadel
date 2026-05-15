import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import {
  buildPromptPackCapabilitySeries,
  buildPromptPackCapabilitySeriesV2,
  buildPromptPackPromptInput,
  buildPromptPackReviewRateSeries,
  buildPromptPackRunFailureRateSeries,
  extractPromptPackCompletionText,
  extractPromptPackDiagnosticMetadata,
  pickPromptPackAutoScoreRun,
  pickReplayBaselineScore,
  requiresPromptPackCitationEvidence,
  resolvePromptPackExecutionProfile,
  resolvePromptPackJudgeServiceTier,
  resolvePromptPackJudgeTarget,
  resolvePromptPackJudgeTemperature,
} from "./prompt-pack-service.js";

describe("prompt-pack service loop22 exported helper coverage", () => {
  it("extracts diagnostic metadata while ignoring empty, duplicate, and unknown rows", () => {
    const extracted = extractPromptPackDiagnosticMetadata(
      [
        "<!-- Prompt Pack Diagnostics:",
        "- Capability Targets: routing, `routing`; memory",
        "- Expected Runtime Signals: trace_update;; approval.resolved",
        "- Likely Failure Classes: tool_failure; harness_failure",
        "- Ignored Field: ignored",
        "-->",
        "Use file evidence for this task.",
      ].join("\n"),
    );

    expect(extracted).toEqual({
      prompt: "Use file evidence for this task.",
      diagnosticMetadata: {
        capabilityTargets: ["routing", "memory"],
        expectedRuntimeSignals: ["trace_update", "approval.resolved"],
        likelyFailureClasses: ["tool_failure", "harness_failure"],
      },
    });

    expect(extractPromptPackDiagnosticMetadata("No metadata here.")).toEqual({ prompt: "No metadata here." });
    expect(
      extractPromptPackDiagnosticMetadata(
        ["<!-- Prompt Pack Diagnostics:", "- Ignored: only", "-->", "Task"].join("\n"),
      ),
    ).toEqual({ prompt: "Task", diagnosticMetadata: undefined });
  });

  it("wraps explicit-tool cowork prompts with ordered sections, lenses, and tool evidence requirements", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        mode: "cowork",
        toolTier: "explicit-tools",
      } as never,
    });
    const { prompt, directives } = buildPromptPackPromptInput(
      [
        "Use file search and file read tools plus browser.interact, http.post, and browser.search.",
        "Use browser search for current public sources.",
        "Use available memory.",
        "Output exactly these sections in this order:",
        "- Planner",
        "- Risk Review",
        "",
        "Weigh cost, latency, and operator trust.",
        "Only the controller should speak in the final answer.",
        "Keep file reads inside apps/gateway/src/services/prompt-pack-service.ts.",
      ].join("\n"),
      profile,
      "Planner and Risk Review",
    );

    expect(directives.prefersFileTools).toBe(true);
    expect(directives.prefersWebTools).toBe(true);
    expect(directives.prefersMemoryTools).toBe(true);
    expect(prompt).toContain("Output exactly these top-level sections in this order: `Planner`, `Risk Review`.");
    expect(prompt).toContain("Keep the final answer controller-owned");
    expect(prompt).toContain("Required named tools:");
    expect(prompt).toContain("`browser.interact`");
    expect(prompt).toContain("`http.post`");
    expect(prompt).toContain("Required tool families: file/code tools, web lookup tools, memory tools");
    expect(prompt).toContain("For `browser.interact`, send an explicit `steps` array");
    expect(prompt).toContain("Keep file/code reads inside the prompt-listed scope");
  });

  it("keeps no-tools chat prompts unwrapped and detects citation-evidence wording", () => {
    const profile = resolvePromptPackExecutionProfile({
      test: {
        mode: "chat",
        toolTier: "no-tools",
      } as never,
    });

    expect(buildPromptPackPromptInput("Answer without tools from the prompt only.", profile).prompt).toBe(
      "Answer without tools from the prompt only.",
    );
    expect(requiresPromptPackCitationEvidence("Give file-specific evidence with line numbers.")).toBe(true);
    expect(requiresPromptPackCitationEvidence("Cite the exact files that support the answer.")).toBe(true);
    expect(requiresPromptPackCitationEvidence("Give a friendly high-level answer.")).toBe(false);
  });

  it("resolves judge target defaults, temperatures, and service tiers without routing side effects", () => {
    expect(
      resolvePromptPackJudgeTarget({
        inputProviderId: "anthropic",
        runProviderId: "openai",
        defaultProviderId: "openai-codex",
        defaultModel: "openai-codex/gpt-5.4",
      }),
    ).toEqual({ providerId: "anthropic", model: "openai-codex/gpt-5.4" });
    expect(
      resolvePromptPackJudgeTarget({
        runProviderId: "moonshot",
        runModel: "kimi-k2",
        defaultProviderId: "openai",
        defaultModel: "gpt-5.4-mini",
      }),
    ).toEqual({ providerId: "openai", model: "gpt-5.4-mini" });
    expect(resolvePromptPackJudgeTemperature("openai-codex", "openai-codex/gpt-5.4")).toBeUndefined();
    expect(resolvePromptPackJudgeTemperature("moonshot", "kimi-k2")).toBe(1);
    expect(resolvePromptPackJudgeTemperature("openai", "gpt-5.4")).toBe(0);
    expect(resolvePromptPackJudgeServiceTier("openai")).toBe("flex");
    expect(resolvePromptPackJudgeServiceTier("openai-codex")).toBeUndefined();
  });

  it("builds replay, failure, review, and capability trend series across legacy and v2/v3 scores", () => {
    const older = legacyScore({ runId: "run-old", createdAt: "2026-03-01T00:00:00.000Z", routingScore: 1 });
    const current = legacyScore({ runId: "run-current", createdAt: "2026-03-03T00:00:00.000Z", routingScore: 2 });
    const newer = legacyScore({ runId: "run-newer", createdAt: "2026-03-04T00:00:00.000Z", routingScore: 0 });

    expect(pickReplayBaselineScore([newer, current, older], current)?.runId).toBe("run-newer");
    expect(pickReplayBaselineScore([newer, current, older], current, "2026-03-02T00:00:00.000Z")?.runId).toBe(
      "run-old",
    );
    expect(buildPromptPackCapabilitySeries([older, current], "routing")).toEqual([
      { timestamp: older.createdAt, value: 1 },
      { timestamp: current.createdAt, value: 1.5 },
    ]);
    expect(
      buildPromptPackRunFailureRateSeries([
        { status: "completed", startedAt: "2026-03-01T00:00:00.000Z" },
        { status: "failed", startedAt: "2026-03-02T00:00:00.000Z", finishedAt: "2026-03-02T00:01:00.000Z" },
      ] as never),
    ).toEqual([
      { timestamp: "2026-03-01T00:00:00.000Z", value: 0 },
      { timestamp: "2026-03-02T00:01:00.000Z", value: 0.5 },
    ]);
    expect(
      buildPromptPackReviewRateSeries([
        autoScore({ autoVerdict: "pass", createdAt: "2026-03-01T00:00:00.000Z" }),
        autoScore({ autoVerdict: "review", createdAt: "2026-03-02T00:00:00.000Z" }),
      ]),
    ).toEqual([
      { timestamp: "2026-03-01T00:00:00.000Z", value: 0 },
      { timestamp: "2026-03-02T00:00:00.000Z", value: 0.5 },
    ]);

    expect(
      buildPromptPackCapabilitySeriesV2(
        [
          autoScore({
            scoringSchemaVersion: "v2",
            finalScores: { executionQuality: 2 },
            createdAt: "2026-03-01T00:00:00.000Z",
          }),
          autoScore({
            scoringSchemaVersion: "v3",
            finalScores: { orchestrationQuality: 4 },
            createdAt: "2026-03-02T00:00:00.000Z",
          }),
          autoScore({
            scoringSchemaVersion: "v3",
            finalScores: {},
            createdAt: "2026-03-03T00:00:00.000Z",
          }),
        ],
        "executionQuality",
      ),
    ).toEqual([
      { timestamp: "2026-03-01T00:00:00.000Z", value: 50 },
      { timestamp: "2026-03-02T00:00:00.000Z", value: 75 },
    ]);
  });

  it("picks completed auto-score runs and extracts completion text from provider response shapes", () => {
    expect(
      pickPromptPackAutoScoreRun([
        { runId: "new-running", status: "running", startedAt: "2026-03-02T00:00:00.000Z" },
        { runId: "old-completed", status: "completed", startedAt: "2026-03-01T00:00:00.000Z" },
      ] as never)?.runId,
    ).toBe("old-completed");
    expect(
      pickPromptPackAutoScoreRun([{ runId: "only-running", status: "running", startedAt: "" }] as never)?.runId,
    ).toBe("only-running");

    expect(extractPromptPackCompletionText({ choices: [] } as never)).toBe("");
    expect(
      extractPromptPackCompletionText({
        choices: [{ message: { content: "  direct answer  " } }],
      } as never),
    ).toBe("direct answer");
    expect(
      extractPromptPackCompletionText({
        choices: [
          {
            message: {
              content: [
                { text: "alpha " },
                { text: { value: "beta " } },
                { value: "gamma " },
                { content: "delta" },
                { ignored: true },
              ],
            },
          },
        ],
      } as never),
    ).toBe("alpha beta gamma delta");
    expect(
      extractPromptPackCompletionText({
        choices: [{ message: { content: [], reasoning_content: "  reasoning fallback  " } }],
      } as never),
    ).toBe("reasoning fallback");
  });
});

function legacyScore(overrides: Record<string, unknown> = {}) {
  return {
    scoreId: "score",
    packId: "pack",
    testId: "test",
    runId: "run",
    routingScore: 2,
    honestyScore: 2,
    handoffScore: 2,
    robustnessScore: 2,
    usabilityScore: 2,
    totalScore: 10,
    notes: "",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  } as never;
}

function autoScore(overrides: Record<string, unknown> = {}) {
  return {
    autoScoreId: "auto",
    packId: "pack",
    testId: "test",
    runId: "run",
    scoringSchemaVersion: "v2",
    finalScores: {
      taskSuccess: 4,
      honesty: 4,
      executionQuality: 4,
      robustness: 4,
      usability: 4,
    },
    autoVerdict: "pass",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  } as never;
}

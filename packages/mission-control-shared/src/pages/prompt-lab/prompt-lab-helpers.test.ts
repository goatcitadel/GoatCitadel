import type { PromptPackLatestAssessmentRecordV2, PromptPackRunRecord } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ChatModelProviderOption } from "../../components/ChatModelPicker";
import {
  PROMPT_PACK_PASS_THRESHOLD,
  classifyTestResultCategory,
  dedupeStrings,
  extractPromptPlaceholders,
  formatDateTime,
  formatPromptPackProviderModel,
  formatResultCategory,
  formatRunStatus,
  formatWeightedScore,
  matchesTestResultFilter,
  normalizePromptPlaceholderKey,
  parseBenchmarkProviders,
  parseBenchmarkTestCodes,
  resolvePromptLabActiveProvider,
  resolvePromptPackRunModelUsage,
  resultCategoryClass,
  statusChipClass,
} from "./prompt-lab-helpers";

function run(input: Partial<PromptPackRunRecord>): PromptPackRunRecord {
  return {
    runId: "run-1",
    packId: "pack-1",
    testId: "test-1",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  } as PromptPackRunRecord;
}

function assessment(input: Partial<PromptPackLatestAssessmentRecordV2>): PromptPackLatestAssessmentRecordV2 {
  return {
    testId: "test-1",
    currentGeneration: true,
    effectiveVerdict: "pass",
    autoScore: { weightedScore: 90 },
    ...input,
  } as PromptPackLatestAssessmentRecordV2;
}

describe("prompt lab helpers", () => {
  it("dedupes free-form strings and resolves the active provider by priority", () => {
    const providers = [
      { providerId: "openai", label: "OpenAI" },
      { providerId: "anthropic", label: "Anthropic" },
      { providerId: "local", label: "Local" },
    ] as ChatModelProviderOption[];

    expect(PROMPT_PACK_PASS_THRESHOLD).toBe(75);
    expect(dedupeStrings([" a ", "a", undefined, "", "b"])).toEqual(["a", "b"]);
    expect(resolvePromptLabActiveProvider([], {})).toBeUndefined();
    expect(resolvePromptLabActiveProvider(providers, { selectedProviderId: "anthropic" })?.providerId).toBe(
      "anthropic",
    );
    expect(resolvePromptLabActiveProvider(providers, { preferredProviderId: "local" })?.providerId).toBe("local");
    expect(resolvePromptLabActiveProvider(providers, { runtimeActiveProviderId: "anthropic" })?.providerId).toBe(
      "openai",
    );
    expect(resolvePromptLabActiveProvider(providers, { selectedProviderId: "missing" })?.providerId).toBe("openai");
    expect(
      resolvePromptLabActiveProvider(providers, {
        selectedProviderId: "missing",
        preferredProviderId: "missing",
        runtimeActiveProviderId: null,
      })?.providerId,
    ).toBe("openai");
  });

  it("extracts, normalizes, and parses prompt lab text inputs", () => {
    expect(
      extractPromptPlaceholders(
        "Use <LOCAL_FILE_PATH> and <topic> but ignore <xy> and <plainword> then <   > and <PASTE EXAMPLE>.",
      ),
    ).toEqual(["<LOCAL_FILE_PATH>", "<topic>", "<PASTE EXAMPLE>"]);
    expect(normalizePromptPlaceholderKey(" <LOCAL FILE PATH> ")).toBe("local file path");
    expect(normalizePromptPlaceholderKey("")).toBe("");
    expect(parseBenchmarkTestCodes(" A-1, A-1\nB-2   C-3 ")).toEqual(["A-1", "B-2", "C-3"]);
    expect(
      parseBenchmarkProviders(
        "openai/gpt-5\n\nbad-line\nanthropic/claude\nopenai/gpt-5\n/missing\nx/\nopenai/   \n  /model",
      ),
    ).toEqual([
      { providerId: "openai", model: "gpt-5" },
      { providerId: "anthropic", model: "claude" },
    ]);
  });

  it("formats run status, provider/model labels, dates, chips, and weighted scores", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

    expect(formatRunStatus()).toBe("Not run");
    expect(formatRunStatus("completed")).toBe("Run completed");
    expect(formatRunStatus("approval_paused")).toBe("Waiting for approval");
    expect(formatRunStatus("failed")).toBe("Run failed");
    expect(formatRunStatus("running" as never)).toBe("running");
    expect(formatPromptPackProviderModel()).toBe("unknown");
    expect(formatPromptPackProviderModel("openai")).toBe("openai/provider default");
    expect(formatPromptPackProviderModel(undefined, "gpt-5")).toBe("provider auto/gpt-5");
    expect(formatDateTime()).toBe("unknown");
    expect(formatDateTime("bad date")).toBe("bad date");
    expect(formatDateTime("2026-01-01T12:00:00.000Z")).toContain("2026");
    expect(statusChipClass()).toBe("run-not-run");
    expect(statusChipClass("completed")).toBe("run-completed");
    expect(statusChipClass("approval_paused")).toBe("run-paused");
    expect(statusChipClass("failed")).toBe("run-failed");
    expect(statusChipClass("running" as never)).toBe("run-not-run");
    expect(formatWeightedScore()).toBe("Needs score");
    expect(formatWeightedScore(Number.NaN)).toBe("Needs score");
    expect(formatWeightedScore(87.456)).toBe("87.5/100");

    vi.useRealTimers();
  });

  it("summarizes requested, effective, and fallback model routing", () => {
    expect(resolvePromptPackRunModelUsage(null)).toEqual({
      requestedProviderId: undefined,
      requestedModel: undefined,
      requestedApiStyle: undefined,
      actualProviderId: undefined,
      actualModel: undefined,
      actualApiStyle: undefined,
      fallbackProviderId: undefined,
      fallbackModel: undefined,
      fallbackReason: undefined,
      fallbackUsed: false,
    });
    expect(
      resolvePromptPackRunModelUsage(
        run({
          providerId: "requested-provider",
          model: "requested-model",
          trace: {
            model: "trace-model",
            routing: {
              primaryProviderId: "primary-provider",
              primaryModel: "primary-model",
              primaryApiStyle: "responses",
              effectiveProviderId: "effective-provider",
              effectiveModel: "effective-model",
              effectiveApiStyle: "chat-completions",
              fallbackProviderId: "fallback-provider",
              fallbackModel: "fallback-model",
              fallbackReason: "quota",
              fallbackUsed: true,
            },
          },
        }),
      ),
    ).toMatchObject({
      requestedProviderId: "requested-provider",
      requestedModel: "requested-model",
      requestedApiStyle: "responses",
      actualProviderId: "effective-provider",
      actualModel: "effective-model",
      actualApiStyle: "chat-completions",
      fallbackProviderId: "fallback-provider",
      fallbackModel: "fallback-model",
      fallbackReason: "quota",
      fallbackUsed: true,
    });
  });

  it("classifies prompt pack results and filter matches", () => {
    expect(classifyTestResultCategory(undefined, undefined)).toBe("not_run");
    expect(classifyTestResultCategory(run({ status: "approval_paused" }), undefined)).toBe("approval_paused");
    expect(classifyTestResultCategory(run({ status: "failed" }), undefined)).toBe("run_failed");
    expect(classifyTestResultCategory(run({ integrity: { validationStatus: "invalid" } }), undefined)).toBe(
      "run_failed",
    );
    expect(classifyTestResultCategory(run({ status: "running" as never }), undefined)).toBe("not_run");
    expect(classifyTestResultCategory(run({}), undefined)).toBe("needs_score");
    expect(
      classifyTestResultCategory(run({}), assessment({ legacyScore: { totalScore: 8 }, autoScore: undefined })),
    ).toBe("passing");
    expect(
      classifyTestResultCategory(run({}), assessment({ legacyScore: { totalScore: 6 }, autoScore: undefined })),
    ).toBe("score_failed");
    expect(classifyTestResultCategory(run({}), assessment({ currentGeneration: false }))).toBe("needs_score");
    expect(classifyTestResultCategory(run({}), assessment({ effectiveVerdict: "review" }))).toBe("review");
    expect(classifyTestResultCategory(run({}), assessment({ effectiveVerdict: "fail" }))).toBe("score_failed");
    expect(classifyTestResultCategory(run({}), assessment({ effectiveVerdict: "pass" }))).toBe("passing");

    expect(matchesTestResultFilter("all", undefined, undefined)).toBe(true);
    expect(matchesTestResultFilter("passing", run({}), assessment({ effectiveVerdict: "pass" }))).toBe(true);
    expect(matchesTestResultFilter("run_failed", run({}), assessment({ effectiveVerdict: "pass" }))).toBe(false);

    expect(formatResultCategory("approval_paused")).toBe("Approval paused");
    expect(formatResultCategory("run_failed")).toBe("Run failure");
    expect(formatResultCategory("score_failed")).toBe("Score failure");
    expect(formatResultCategory("review")).toBe("Review");
    expect(formatResultCategory("needs_score")).toBe("Needs score");
    expect(formatResultCategory("passing")).toBe("Passing");
    expect(formatResultCategory("not_run")).toBe("Not run");
    expect(resultCategoryClass("approval_paused")).toBe("result-run-paused");
    expect(resultCategoryClass("run_failed")).toBe("result-run-failed");
    expect(resultCategoryClass("score_failed")).toBe("result-score-failed");
    expect(resultCategoryClass("review")).toBe("result-needs-score");
    expect(resultCategoryClass("needs_score")).toBe("result-needs-score");
    expect(resultCategoryClass("passing")).toBe("result-passing");
    expect(resultCategoryClass("not_run")).toBe("result-not-run");
  });
});

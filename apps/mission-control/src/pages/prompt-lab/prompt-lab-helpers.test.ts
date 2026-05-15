import { describe, expect, it } from "vitest";
import type { PromptPackRunRecord } from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "../../components/ChatModelPicker";
import {
  classifyTestResultCategory,
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
  resultCategoryClass,
  resolvePromptLabActiveProvider,
  resolvePromptPackRunModelUsage,
  statusChipClass,
} from "./prompt-lab-helpers";

const PROVIDERS: ChatModelProviderOption[] = [
  {
    providerId: "openai",
    label: "OpenAI",
    models: ["gpt-5.4", "gpt-5.4-mini"],
  },
  {
    providerId: "llamacpp",
    label: "llama.cpp",
    models: ["gemma-4-local"],
  },
  {
    providerId: "anthropic",
    label: "Anthropic",
    models: ["claude-sonnet-4-6"],
  },
];

describe("resolvePromptLabActiveProvider", () => {
  it("prefers the explicit in-page selection when it is still valid", () => {
    expect(
      resolvePromptLabActiveProvider(PROVIDERS, {
        selectedProviderId: "anthropic",
        runtimeActiveProviderId: "llamacpp",
      })?.providerId,
    ).toBe("anthropic");
  });

  it("defaults Prompt Lab to openai before the runtime active provider", () => {
    expect(
      resolvePromptLabActiveProvider(PROVIDERS, {
        runtimeActiveProviderId: "llamacpp",
      })?.providerId,
    ).toBe("openai");
  });

  it("falls back to the runtime active provider when openai is unavailable", () => {
    expect(
      resolvePromptLabActiveProvider(
        PROVIDERS.filter((provider) => provider.providerId !== "openai"),
        {
          runtimeActiveProviderId: "llamacpp",
        },
      )?.providerId,
    ).toBe("llamacpp");
  });

  it("falls back to the first provider when neither the preferred nor active provider is available", () => {
    expect(
      resolvePromptLabActiveProvider(
        PROVIDERS.filter((provider) => provider.providerId !== "openai"),
        {
          runtimeActiveProviderId: "missing",
        },
      )?.providerId,
    ).toBe("llamacpp");
  });

  it("returns undefined when no providers are configured and honors a custom preferred provider", () => {
    expect(resolvePromptLabActiveProvider([], {})).toBeUndefined();
    expect(
      resolvePromptLabActiveProvider(PROVIDERS, {
        selectedProviderId: " ",
        preferredProviderId: "anthropic",
        runtimeActiveProviderId: "llamacpp",
      })?.providerId,
    ).toBe("anthropic");
  });
});

describe("classifyTestResultCategory", () => {
  it("classifies completed runs with invalid integrity as run failures", () => {
    expect(
      classifyTestResultCategory(
        {
          runId: "run-invalid",
          packId: "pack-1",
          testId: "test-1",
          status: "completed",
          responseText: "Partial output",
          integrity: {
            validationStatus: "invalid",
            signals: ["completion_truncated"],
          },
          startedAt: "2026-05-05T00:00:00.000Z",
        },
        undefined,
      ),
    ).toBe("run_failed");
  });

  it("classifies run and score edge states used by Prompt Lab filters", () => {
    const completed: PromptPackRunRecord = {
      runId: "run-completed",
      packId: "pack-1",
      testId: "test-1",
      status: "completed",
      startedAt: "2026-05-05T00:00:00.000Z",
    };

    expect(classifyTestResultCategory(undefined, undefined)).toBe("not_run");
    expect(classifyTestResultCategory({ ...completed, status: "approval_paused" } as never, undefined)).toBe(
      "approval_paused",
    );
    expect(classifyTestResultCategory({ ...completed, status: "failed" } as never, undefined)).toBe("run_failed");
    expect(classifyTestResultCategory({ ...completed, status: "running" } as never, undefined)).toBe("not_run");
    expect(classifyTestResultCategory(completed, undefined)).toBe("needs_score");
    expect(
      classifyTestResultCategory(completed, {
        testId: "test-1",
        legacyScore: { totalScore: 6 },
      } as never),
    ).toBe("score_failed");
    expect(
      classifyTestResultCategory(completed, {
        testId: "test-1",
        legacyScore: { totalScore: 8 },
      } as never),
    ).toBe("passing");
    expect(
      classifyTestResultCategory(completed, {
        testId: "test-1",
        currentGeneration: false,
        effectiveVerdict: "pass",
        autoScore: { weightedScore: 90 },
      } as never),
    ).toBe("needs_score");
    expect(
      classifyTestResultCategory(completed, {
        testId: "test-1",
        effectiveVerdict: "fail",
        autoScore: { weightedScore: 44 },
      } as never),
    ).toBe("score_failed");

    expect(matchesTestResultFilter("all", completed, undefined)).toBe(true);
    expect(matchesTestResultFilter("needs_score", completed, undefined)).toBe(true);
    expect(formatResultCategory("run_failed")).toBe("Run failure");
    expect(formatResultCategory("not_run")).toBe("Not run");
    expect(resultCategoryClass("approval_paused")).toBe("result-run-paused");
    expect(resultCategoryClass("score_failed")).toBe("result-score-failed");
    expect(resultCategoryClass("not_run")).toBe("result-not-run");
  });
});

describe("prompt lab formatting and run helpers", () => {
  it("extracts placeholders and parses benchmark inputs without duplicate runs", () => {
    expect(
      extractPromptPlaceholders("Read <FILE_PATH>, compare <LOCAL TOPIC>, ignore <tag>, then use <FILE_PATH>."),
    ).toEqual(["<FILE_PATH>", "<LOCAL TOPIC>"]);
    expect(normalizePromptPlaceholderKey("<LOCAL   TOPIC>")).toBe("local topic");
    expect(normalizePromptPlaceholderKey("   ")).toBe("");
    expect(parseBenchmarkTestCodes("TEST-01, TEST-02\nTEST-01")).toEqual(["TEST-01", "TEST-02"]);
    expect(
      parseBenchmarkProviders(
        "openai/gpt-5.4\nbad-line\n/model\nprovider/\nopenai/ \n openai/gpt-5.4 \nanthropic/claude-sonnet",
      ),
    ).toEqual([
      { providerId: "openai", model: "gpt-5.4" },
      { providerId: "anthropic", model: "claude-sonnet" },
    ]);
  });

  it("formats run status, model usage, and scores for completed and fallback runs", () => {
    expect(formatRunStatus()).toBe("Not run");
    expect(formatRunStatus("completed")).toBe("Run completed");
    expect(formatRunStatus("approval_paused")).toBe("Waiting for approval");
    expect(formatRunStatus("queued" as never)).toBe("queued");
    expect(statusChipClass()).toBe("run-not-run");
    expect(statusChipClass("completed")).toBe("run-completed");
    expect(statusChipClass("approval_paused")).toBe("run-paused");
    expect(statusChipClass("failed")).toBe("run-failed");
    expect(statusChipClass("queued" as never)).toBe("run-not-run");
    expect(formatPromptPackProviderModel()).toBe("unknown");
    expect(formatPromptPackProviderModel(undefined, "gpt-5.4")).toBe("provider auto/gpt-5.4");
    expect(formatDateTime()).toBe("unknown");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatWeightedScore(87.55)).toBe("87.5/100");
    expect(formatWeightedScore(Number.NaN)).toBe("Needs score");

    expect(
      resolvePromptPackRunModelUsage({
        providerId: "openai",
        model: "gpt-5.4",
        trace: {
          model: "gpt-5.4-mini",
          routing: {
            primaryProviderId: "openai",
            primaryModel: "gpt-5.4",
            primaryApiStyle: "openai-responses",
            effectiveProviderId: "openai",
            effectiveModel: "gpt-5.4-mini",
            effectiveApiStyle: "openai-chat-completions",
            fallbackProviderId: "openai",
            fallbackModel: "gpt-5.4-mini",
            fallbackUsed: true,
            fallbackReason: "primary timeout",
          },
        },
      } as never),
    ).toEqual({
      requestedProviderId: "openai",
      requestedModel: "gpt-5.4",
      requestedApiStyle: "openai-responses",
      actualProviderId: "openai",
      actualModel: "gpt-5.4-mini",
      actualApiStyle: "openai-chat-completions",
      fallbackProviderId: "openai",
      fallbackModel: "gpt-5.4-mini",
      fallbackReason: "primary timeout",
      fallbackUsed: true,
    });
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
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ChatToolRunRecord, ChatTurnFailureRecord } from "@goatcitadel/contracts";
import {
  applyPromptLabExplicitToolBudget,
  applyPromptLabHarnessBudget,
  buildTurnBudgetExceededFallbackMessage,
  buildTurnBudgetExceededReason,
  buildUserSafeFailureMessage,
  ChatTurnBudgetExceededError,
  createTurnBudgetDeadline,
  defaultThinkingTokens,
  ensureChatTurnBudgetRemaining,
  extendTurnBudgetForExecutedBrowserTool,
  isExpensiveChatTool,
  minimumRemainingBudgetForToolStart,
  resolveChatExecutionBudget,
  CHAT_COMPLETION_TIMEOUT_MS_BY_MODE,
  CHAT_TURN_BUDGET_MS_BY_MODE,
  type ResolveChatExecutionBudgetInput,
  shouldExtendTurnBudgetForBrowserExecution,
  shouldUseConstrainedLocalAgentProfile,
} from "./chat-agent-budget.js";

describe("chat-agent-budget", () => {
  it("resolves mode, web, prompt-lab, and constrained local budgets", () => {
    expect(defaultThinkingTokens("off")).toBe(300);
    expect(defaultThinkingTokens("minimal")).toBe(300);
    expect(defaultThinkingTokens("standard")).toBe(900);
    expect(defaultThinkingTokens("extended")).toBe(1800);
    expect(defaultThinkingTokens("deep")).toBe(2600);

    expect(
      resolveChatExecutionBudget({
        mode: "chat",
        webMode: "deep",
        thinkingLevel: "deep",
      }),
    ).toEqual(
      expect.objectContaining({
        turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.deep,
        completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.deep,
        maxToolLoops: 6,
        maxToolRunsPerTurn: 12,
        searchMaxResults: 8,
        maxTokens: 2600,
      }),
    );

    expect(
      resolveChatExecutionBudget({
        mode: "chat",
        webMode: "quick",
        thinkingLevel: "extended",
      }),
    ).toEqual(expect.objectContaining({ maxToolLoops: 2, maxToolRunsPerTurn: 3, searchMaxResults: 4, maxTokens: 600 }));

    expect(
      resolveChatExecutionBudget({
        mode: "code",
        webMode: "off",
        thinkingLevel: "standard",
        promptLabExplicitTools: true,
      }),
    ).toEqual(expect.objectContaining({ maxToolLoops: 6, maxToolRunsPerTurn: 12, searchMaxResults: 0 }));

    expect(
      resolveChatExecutionBudget({
        mode: "cowork",
        webMode: "auto",
        thinkingLevel: "standard",
        liveDataIntent: true,
        promptLabHarness: true,
      }),
    ).toEqual(
      expect.objectContaining({
        maxToolLoops: 8,
        maxToolRunsPerTurn: 16,
        searchMaxResults: 8,
        maxTokens: 2200,
        minSynthesisReserveMs: 15000,
      }),
    );

    expect(
      resolveChatExecutionBudget({
        mode: "cowork",
        webMode: "auto",
        thinkingLevel: "standard",
        liveDataIntent: true,
        researchListIntent: true,
      }),
    ).toEqual(
      expect.objectContaining({
        maxToolLoops: 6,
        maxToolRunsPerTurn: 16,
        searchMaxResults: 8,
        maxTokens: 1600,
        minSynthesisReserveMs: 15000,
      }),
    );

    expect(
      resolveChatExecutionBudget({
        mode: "chat",
        webMode: "auto",
        thinkingLevel: "standard",
        liveDataIntent: true,
        researchListIntent: true,
      }),
    ).toEqual(expect.objectContaining({ maxToolRunsPerTurn: 8, searchMaxResults: 6 }));

    expect(
      resolveChatExecutionBudget({
        mode: "code",
        webMode: "auto",
        thinkingLevel: "standard",
        providerId: "llamacpp",
        model: "gemma-3",
        promptLabExplicitTools: true,
      }),
    ).toEqual(expect.objectContaining({ maxToolLoops: 4, maxToolRunsPerTurn: 6, maxTokens: 1400 }));
  });

  it("uses generous-but-bounded per-web-mode turn and completion budgets", () => {
    const THIRTY_MINUTES_MS = 30 * 60 * 1000;
    const cases: { input: ResolveChatExecutionBudgetInput; turnBudgetMs: number; completionTimeoutMs: number }[] = [
      {
        input: { mode: "chat", webMode: "quick", thinkingLevel: "standard" },
        turnBudgetMs: 120000,
        completionTimeoutMs: 60000,
      },
      {
        input: { mode: "chat", webMode: "off", thinkingLevel: "standard" },
        turnBudgetMs: 120000,
        completionTimeoutMs: 90000,
      },
      {
        input: { mode: "chat", webMode: "auto", thinkingLevel: "standard", liveDataIntent: true },
        turnBudgetMs: 240000,
        completionTimeoutMs: 150000,
      },
      {
        input: { mode: "chat", webMode: "auto", thinkingLevel: "standard" },
        turnBudgetMs: 240000,
        completionTimeoutMs: 150000,
      },
      {
        input: { mode: "chat", webMode: "deep", thinkingLevel: "deep" },
        turnBudgetMs: 480000,
        completionTimeoutMs: 240000,
      },
      {
        input: { mode: "cowork", webMode: "auto", thinkingLevel: "standard", researchListIntent: true },
        turnBudgetMs: 480000,
        completionTimeoutMs: 240000,
      },
    ];

    for (const testCase of cases) {
      const budget = resolveChatExecutionBudget(testCase.input);
      expect(budget.turnBudgetMs).toBe(testCase.turnBudgetMs);
      expect(budget.completionTimeoutMs).toBe(testCase.completionTimeoutMs);
      expect(budget.turnBudgetMs).toBeLessThan(THIRTY_MINUTES_MS);
      expect(budget.completionTimeoutMs).toBeLessThanOrEqual(budget.turnBudgetMs);
      expect(budget.expensiveToolMinimumRemainingMs).toBeLessThan(budget.turnBudgetMs);
      expect(budget.minSynthesisReserveMs).toBeLessThan(budget.turnBudgetMs);
    }
  });

  it("applies prompt-lab helper budgets without weakening existing larger limits", () => {
    const base = {
      turnBudgetMs: 1000,
      completionTimeoutMs: 500,
      maxToolLoops: 10,
      maxToolRunsPerTurn: 30,
      searchMaxResults: 12,
      maxTokens: 5000,
      minSynthesisReserveMs: 20000,
      expensiveToolMinimumRemainingMs: 25000,
    };

    expect(applyPromptLabHarnessBudget(base, { mode: "chat" })).toBe(base);
    expect(applyPromptLabExplicitToolBudget(base)).toBe(base);
    expect(applyPromptLabHarnessBudget(base, { mode: "code", promptLabHarness: true })).toEqual(base);
    expect(applyPromptLabExplicitToolBudget({ ...base, maxToolLoops: 1, maxToolRunsPerTurn: 2 }, true)).toEqual(
      expect.objectContaining({ maxToolLoops: 6, maxToolRunsPerTurn: 12 }),
    );
  });

  it("extends turn budgets only for executed browser tools in auto web mode", () => {
    const unchanged = extendTurnBudgetForExecutedBrowserTool({
      toolName: "browser.search",
      toolStatus: "blocked",
      webMode: "auto",
      currentTurnBudgetMs: 10000,
      currentCompletionTimeoutMs: 4000,
      turnBudgetDeadline: 50000,
    });
    expect(unchanged).toEqual({
      turnBudgetDeadline: 50000,
      effectiveTurnBudgetMs: 10000,
      effectiveCompletionTimeoutMs: 4000,
    });

    expect(
      extendTurnBudgetForExecutedBrowserTool({
        toolName: "browser.search",
        toolStatus: "executed",
        webMode: "auto",
        currentTurnBudgetMs: 10000,
        currentCompletionTimeoutMs: 4000,
        turnBudgetDeadline: 50000,
      }),
    ).toEqual({
      turnBudgetDeadline: 90000,
      effectiveTurnBudgetMs: 50000,
      effectiveCompletionTimeoutMs: 4000,
    });

    expect(
      extendTurnBudgetForExecutedBrowserTool({
        toolName: "http.get",
        toolStatus: "executed",
        webMode: "auto",
        webLookupIntent: true,
        currentTurnBudgetMs: 90000,
        currentCompletionTimeoutMs: 20000,
        turnBudgetDeadline: 100000,
      }),
    ).toEqual({
      turnBudgetDeadline: 100000,
      effectiveTurnBudgetMs: 90000,
      effectiveCompletionTimeoutMs: 40000,
    });

    expect(isExpensiveChatTool("http.post")).toBe(true);
    expect(isExpensiveChatTool("browser.search")).toBe(false);
    expect(shouldExtendTurnBudgetForBrowserExecution("browser.search")).toBe(true);
    expect(shouldExtendTurnBudgetForBrowserExecution("memory.search")).toBe(false);
    expect(
      minimumRemainingBudgetForToolStart("http.get", {
        turnBudgetMs: 1,
        completionTimeoutMs: 1,
        maxToolLoops: 1,
        maxToolRunsPerTurn: 1,
        searchMaxResults: 1,
        minSynthesisReserveMs: 15000,
        expensiveToolMinimumRemainingMs: 30000,
      }),
    ).toBe(30000);
  });

  it("enforces deadlines and produces user-safe budget/failure text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
    expect(createTurnBudgetDeadline(2500)).toBe(Date.now() + 2500);
    expect(ensureChatTurnBudgetRemaining(Date.now() + 50, "auto", 5000)).toBe(50);
    expect(() => ensureChatTurnBudgetRemaining(Date.now(), "deep", 90000)).toThrow(ChatTurnBudgetExceededError);
    vi.useRealTimers();

    expect(buildTurnBudgetExceededReason("deep", 90000)).toContain("deep-research response budget");
    expect(buildTurnBudgetExceededReason("auto", 30000)).toContain("keep chat responsive");

    const failureClasses: ChatTurnFailureRecord["failureClass"][] = [
      "provider_timeout",
      "network_interrupted",
      "tool_blocked",
      "tool_failed",
      "auth_required",
      "tool_loop_guard",
      "global_circuit_breaker",
      "tool_run_budget_exceeded",
      "turn_budget_exceeded",
      "approval_required",
    ];
    for (const failureClass of failureClasses) {
      expect(buildUserSafeFailureMessage({ failureClass, message: "raw", retryable: true })).not.toBe("raw");
    }
    expect(
      buildUserSafeFailureMessage({ failureClass: "unknown" as never, message: "raw", retryable: false }),
    ).toContain("failed before completion");
  });

  it("chooses the strongest budget fallback from fetched content, search results, tool synthesis, or mode defaults", () => {
    const toolRuns = [{ toolName: "browser.search", status: "executed" }] as ChatToolRunRecord[];
    const fallbackBuilders = {
      buildFetchedContentBudgetFallback: vi.fn(() => undefined as string | undefined),
      buildSearchResultBudgetFallback: vi.fn(() => undefined as string | undefined),
      buildDeterministicToolSynthesisFallback: vi.fn(() => "synthesized fallback"),
    };

    fallbackBuilders.buildFetchedContentBudgetFallback.mockReturnValueOnce("fetched fallback");
    expect(
      buildTurnBudgetExceededFallbackMessage({
        turnInput: { content: "research", webMode: "auto" },
        toolRuns,
        turnBudgetMs: 30000,
        fallbackBuilders,
      }),
    ).toBe("fetched fallback");

    fallbackBuilders.buildSearchResultBudgetFallback.mockReturnValueOnce("search fallback");
    expect(
      buildTurnBudgetExceededFallbackMessage({
        turnInput: { content: "research", webMode: "auto" },
        toolRuns,
        turnBudgetMs: 30000,
        fallbackBuilders,
      }),
    ).toBe("search fallback");

    expect(
      buildTurnBudgetExceededFallbackMessage({
        turnInput: { content: "research", webMode: "auto" },
        toolRuns,
        turnBudgetMs: 30000,
        fallbackBuilders,
      }),
    ).toBe("synthesized fallback");

    expect(
      buildTurnBudgetExceededFallbackMessage({
        turnInput: { content: "research", webMode: "deep" },
        toolRuns: [],
        turnBudgetMs: 30000,
        fallbackBuilders,
      }),
    ).toContain("deep-research pass");
    expect(
      buildTurnBudgetExceededFallbackMessage({
        turnInput: { content: "research", webMode: "auto" },
        toolRuns: [],
        turnBudgetMs: 30000,
        fallbackBuilders,
      }),
    ).toContain("keep chat responsive");

    expect(shouldUseConstrainedLocalAgentProfile(" llamacpp ", undefined)).toBe(true);
    expect(shouldUseConstrainedLocalAgentProfile(undefined, "Gemma 3")).toBe(true);
    expect(shouldUseConstrainedLocalAgentProfile("openai", "gpt-5.4")).toBe(false);
  });
});

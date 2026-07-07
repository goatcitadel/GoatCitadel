import {
  BudgetExceededError,
  type ChatMode,
  type ChatThinkingLevel,
  type ChatToolRunRecord,
  type ChatTurnExecutionProfile,
  type ChatTurnFailureRecord,
  type ChatWebMode,
} from "@goatcitadel/contracts";
import { SUBAGENT_FANOUT_MAX_SUBTASKS, SUBAGENT_FANOUT_TOOL_NAME } from "@goatcitadel/policy-engine";

const MAX_TOOL_LOOPS = 6;
const MAX_TOOL_RUNS_PER_TURN = 12;
const COWORK_RESEARCH_LIST_MAX_TOOL_LOOPS = 6;
const COWORK_RESEARCH_LIST_MAX_TOOL_RUNS_PER_TURN = 16;
const COWORK_RESEARCH_LIST_EXTENDED_MAX_TOOL_RUNS_PER_TURN = 48;
const COWORK_RESEARCH_LIST_SEARCH_MAX_RESULTS = 8;
const PROMPT_LAB_EXPLICIT_MAX_TOOL_LOOPS = 8;
const PROMPT_LAB_EXPLICIT_MAX_TOOL_RUNS_PER_TURN = 12;
const PROMPT_LAB_IMPLICIT_MAX_TOOL_LOOPS = {
  chat: 4,
  cowork: 6,
  code: 6,
} as const satisfies Record<ChatMode, number>;
const PROMPT_LAB_IMPLICIT_MAX_TOOL_RUNS_PER_TURN = {
  chat: 8,
  cowork: 8,
  code: 8,
} as const satisfies Record<ChatMode, number>;
const PROMPT_LAB_SEARCH_MAX_RESULTS = {
  chat: 4,
  cowork: 6,
  code: 6,
} as const satisfies Record<ChatMode, number>;
const PROMPT_LAB_MIN_MAX_TOKENS = {
  chat: 1800,
  cowork: 2200,
  code: 2400,
} as const satisfies Record<ChatMode, number>;
const PROMPT_LAB_MIN_TURN_BUDGET_MS = 240_000;
const PROMPT_LAB_MIN_COMPLETION_TIMEOUT_MS = 150_000;

// Generous-but-bounded per-web-mode turn and completion budgets. Each pair keeps
// completionTimeoutMs <= turnBudgetMs and stays above the branch's
// minSynthesisReserveMs / expensiveToolMinimumRemainingMs so a hung provider call
// cannot block a turn indefinitely.
export const CHAT_TURN_BUDGET_MS_BY_MODE = {
  quickWeb: 20000,
  quick: 120000,
  off: 120000,
  liveData: 240000,
  deep: 480000,
  coworkResearchList: 480000,
  default: 240000,
} as const;
export const CHAT_COMPLETION_TIMEOUT_MS_BY_MODE = {
  quickWeb: 12000,
  quick: 60000,
  off: 90000,
  liveData: 150000,
  deep: 240000,
  coworkResearchList: 240000,
  default: 150000,
} as const;

export type ChatLoopLimitBehavior = "terminal" | "checkpoint_continue";

export interface ChatExecutionBudget {
  readonly turnBudgetMs: number;
  readonly completionTimeoutMs: number;
  readonly maxToolLoops: number;
  readonly loopLimitBehavior: ChatLoopLimitBehavior;
  readonly maxToolRunsPerTurn: number;
  readonly searchMaxResults: number;
  readonly maxTokens?: number;
  readonly minSynthesisReserveMs: number;
  readonly expensiveToolMinimumRemainingMs: number;
}

export interface ResolveChatExecutionBudgetInput {
  readonly mode: ChatMode;
  readonly webMode: ChatWebMode;
  readonly thinkingLevel: ChatThinkingLevel;
  readonly liveDataIntent?: boolean;
  readonly researchListIntent?: boolean;
  readonly promptLabExplicitTools?: boolean;
  readonly promptLabHarness?: boolean;
  readonly providerId?: string;
  readonly model?: string;
  readonly executionProfile?: ChatTurnExecutionProfile;
}

export class ChatTurnBudgetExceededError extends BudgetExceededError {
  public constructor(
    public readonly webMode: ChatWebMode,
    public readonly turnBudgetMs: number,
  ) {
    super(buildTurnBudgetExceededReason(webMode, turnBudgetMs), { webMode, turnBudgetMs });
  }
}

export function defaultThinkingTokens(level: ChatThinkingLevel): number | undefined {
  if (level === "off") {
    return 300;
  }
  if (level === "minimal") {
    return 300;
  }
  if (level === "extended") {
    return 1800;
  }
  if (level === "deep") {
    return 2600;
  }
  return 900;
}

export function resolveChatExecutionBudget(input: ResolveChatExecutionBudgetInput): ChatExecutionBudget {
  const defaultMaxTokens = defaultThinkingTokens(input.thinkingLevel);
  const loopLimitBehavior = resolveLoopLimitBehavior(input.mode);
  let budget: ChatExecutionBudget;
  if (input.executionProfile === "quick_web") {
    budget = {
      turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.quickWeb,
      completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.quickWeb,
      maxToolLoops: 1,
      loopLimitBehavior,
      maxToolRunsPerTurn: 2,
      searchMaxResults: 3,
      maxTokens: Math.min(defaultMaxTokens ?? 500, 600),
      minSynthesisReserveMs: 5000,
      expensiveToolMinimumRemainingMs: 8000,
    };
  } else if (shouldUseCoworkResearchListBudget(input)) {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.coworkResearchList,
        completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.coworkResearchList,
        maxToolLoops: COWORK_RESEARCH_LIST_MAX_TOOL_LOOPS,
        loopLimitBehavior,
        maxToolRunsPerTurn: COWORK_RESEARCH_LIST_MAX_TOOL_RUNS_PER_TURN,
        searchMaxResults: COWORK_RESEARCH_LIST_SEARCH_MAX_RESULTS,
        maxTokens: Math.max(defaultMaxTokens ?? 900, 1600),
        minSynthesisReserveMs: 15000,
        expensiveToolMinimumRemainingMs: 30000,
      },
      input.promptLabExplicitTools,
    );
  } else if (input.webMode === "deep") {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.deep,
        completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.deep,
        maxToolLoops: MAX_TOOL_LOOPS,
        loopLimitBehavior,
        maxToolRunsPerTurn: MAX_TOOL_RUNS_PER_TURN,
        searchMaxResults: 8,
        maxTokens: Math.max(defaultMaxTokens ?? 900, 1200),
        minSynthesisReserveMs: 15000,
        expensiveToolMinimumRemainingMs: 30000,
      },
      input.promptLabExplicitTools,
    );
  } else if (input.webMode === "quick") {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.quick,
        completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.quick,
        maxToolLoops: 2,
        loopLimitBehavior,
        maxToolRunsPerTurn: 3,
        searchMaxResults: 4,
        maxTokens: Math.min(defaultMaxTokens ?? 600, 600),
        minSynthesisReserveMs: 6000,
        expensiveToolMinimumRemainingMs: 12000,
      },
      input.promptLabExplicitTools,
    );
  } else if (input.webMode === "off") {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.off,
        completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.off,
        maxToolLoops: 2,
        loopLimitBehavior,
        maxToolRunsPerTurn: 4,
        searchMaxResults: 0,
        maxTokens: Math.min(defaultMaxTokens ?? 700, 800),
        minSynthesisReserveMs: 7000,
        expensiveToolMinimumRemainingMs: 14000,
      },
      input.promptLabExplicitTools,
    );
  } else if (input.liveDataIntent) {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.liveData,
        completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.liveData,
        maxToolLoops: 5,
        loopLimitBehavior,
        maxToolRunsPerTurn: 8,
        searchMaxResults: 6,
        maxTokens: Math.min(defaultMaxTokens ?? 900, 1100),
        minSynthesisReserveMs: 12000,
        expensiveToolMinimumRemainingMs: 28000,
      },
      input.promptLabExplicitTools,
    );
  } else {
    budget = applyPromptLabExplicitToolBudget(
      {
        turnBudgetMs: CHAT_TURN_BUDGET_MS_BY_MODE.default,
        completionTimeoutMs: CHAT_COMPLETION_TIMEOUT_MS_BY_MODE.default,
        maxToolLoops: 4,
        loopLimitBehavior,
        maxToolRunsPerTurn: 7,
        searchMaxResults: 5,
        maxTokens: Math.min(defaultMaxTokens ?? 900, 1100),
        minSynthesisReserveMs: 10000,
        expensiveToolMinimumRemainingMs: 20000,
      },
      input.promptLabExplicitTools,
    );
  }
  budget = applyPromptLabHarnessBudget(budget, {
    mode: input.mode,
    promptLabHarness: input.promptLabHarness,
    promptLabExplicitTools: input.promptLabExplicitTools,
  });
  budget = applyCoworkResearchListExtendedBudget(budget, input);
  if (input.executionProfile === "quick_web") {
    return budget;
  }
  if (!shouldUseConstrainedLocalAgentProfile(input.providerId, input.model)) {
    return budget;
  }
  return {
    ...budget,
    maxToolLoops: Math.min(budget.maxToolLoops, input.promptLabExplicitTools ? 4 : 3),
    maxToolRunsPerTurn: Math.min(budget.maxToolRunsPerTurn, input.promptLabExplicitTools ? 6 : 5),
    maxTokens: Math.max(budget.maxTokens ?? 900, 1400),
    minSynthesisReserveMs: Math.max(budget.minSynthesisReserveMs, 12000),
  };
}

function applyCoworkResearchListExtendedBudget(
  budget: ChatExecutionBudget,
  input: ResolveChatExecutionBudgetInput,
): ChatExecutionBudget {
  if (!shouldUseCoworkResearchListBudget(input) || input.promptLabHarness) {
    return budget;
  }
  return {
    ...budget,
    maxToolRunsPerTurn: Math.max(budget.maxToolRunsPerTurn, COWORK_RESEARCH_LIST_EXTENDED_MAX_TOOL_RUNS_PER_TURN),
  };
}

function resolveLoopLimitBehavior(mode: ChatMode): ChatLoopLimitBehavior {
  return mode === "cowork" ? "checkpoint_continue" : "terminal";
}

function shouldUseCoworkResearchListBudget(input: ResolveChatExecutionBudgetInput): boolean {
  return input.mode === "cowork" && input.webMode === "auto" && Boolean(input.researchListIntent);
}

export function applyPromptLabHarnessBudget(
  budget: ChatExecutionBudget,
  input: {
    readonly mode: ChatMode;
    readonly promptLabHarness?: boolean;
    readonly promptLabExplicitTools?: boolean;
  },
): ChatExecutionBudget {
  if (!input.promptLabHarness) {
    return budget;
  }
  const maxToolLoops = input.promptLabExplicitTools
    ? PROMPT_LAB_EXPLICIT_MAX_TOOL_LOOPS
    : PROMPT_LAB_IMPLICIT_MAX_TOOL_LOOPS[input.mode];
  const maxToolRunsPerTurn = input.promptLabExplicitTools
    ? PROMPT_LAB_EXPLICIT_MAX_TOOL_RUNS_PER_TURN
    : PROMPT_LAB_IMPLICIT_MAX_TOOL_RUNS_PER_TURN[input.mode];
  const synthesisReserveMs = input.mode === "chat" ? 20_000 : 30_000;
  // Harness rows run real multi-step tool work: a 120s wall (the chat quick/off
  // default, sized to keep live chat responsive) starves the final synthesis
  // when a single repo search or browser navigation takes 30-90s on a loaded
  // machine. Evals prefer a complete, honest answer over snappiness.
  const turnBudgetMs = Math.max(budget.turnBudgetMs, PROMPT_LAB_MIN_TURN_BUDGET_MS);
  const completionTimeoutMs = Math.min(
    turnBudgetMs,
    Math.max(budget.completionTimeoutMs, PROMPT_LAB_MIN_COMPLETION_TIMEOUT_MS),
  );
  return {
    ...budget,
    turnBudgetMs,
    completionTimeoutMs,
    maxToolLoops: Math.max(budget.maxToolLoops, maxToolLoops),
    maxToolRunsPerTurn: Math.max(budget.maxToolRunsPerTurn, maxToolRunsPerTurn),
    searchMaxResults: Math.max(budget.searchMaxResults, PROMPT_LAB_SEARCH_MAX_RESULTS[input.mode]),
    maxTokens: Math.max(budget.maxTokens ?? 900, PROMPT_LAB_MIN_MAX_TOKENS[input.mode]),
    minSynthesisReserveMs: Math.max(budget.minSynthesisReserveMs, synthesisReserveMs),
    expensiveToolMinimumRemainingMs: Math.max(budget.expensiveToolMinimumRemainingMs, synthesisReserveMs),
  };
}
export function applyPromptLabExplicitToolBudget(
  budget: ChatExecutionBudget,
  promptLabExplicitTools?: boolean,
): ChatExecutionBudget {
  if (!promptLabExplicitTools) {
    return budget;
  }
  return {
    ...budget,
    maxToolLoops: Math.max(budget.maxToolLoops, MAX_TOOL_LOOPS),
    maxToolRunsPerTurn: Math.max(budget.maxToolRunsPerTurn, MAX_TOOL_RUNS_PER_TURN),
  };
}

export function shouldUseConstrainedLocalAgentProfile(providerId?: string, model?: string): boolean {
  const normalizedProviderId = (providerId ?? "").trim().toLowerCase();
  const normalizedModel = (model ?? "").trim().toLowerCase();
  return normalizedProviderId === "llamacpp" || normalizedModel.includes("gemma");
}

export function minimumRemainingBudgetForToolStart(toolName: string, executionBudget: ChatExecutionBudget): number {
  // R3-8: agent.fanout spawns up to 3 delegated child LLM turns — hold it to
  // the expensive-tool floor WITHOUT adding it to isExpensiveChatTool, which
  // would also opt it into the web-scoped browser budget-extension path.
  if (isExpensiveChatTool(toolName) || toolName === SUBAGENT_FANOUT_TOOL_NAME) {
    return Math.max(executionBudget.expensiveToolMinimumRemainingMs, executionBudget.minSynthesisReserveMs);
  }
  return executionBudget.minSynthesisReserveMs;
}

export function toolRunBudgetCostForToolCall(toolName: string, args: Record<string, unknown>): number {
  if (toolName !== SUBAGENT_FANOUT_TOOL_NAME) {
    return 1;
  }
  const subtasks = args.subtasks;
  if (!Array.isArray(subtasks)) {
    return 1;
  }
  return Math.max(1, Math.min(SUBAGENT_FANOUT_MAX_SUBTASKS, subtasks.length));
}

export function isExpensiveChatTool(toolName: string): boolean {
  return (
    toolName === "browser.navigate" ||
    toolName === "browser.extract" ||
    toolName === "http.get" ||
    toolName === "http.post"
  );
}

export function extendTurnBudgetForExecutedBrowserTool(input: {
  readonly toolName: string;
  readonly toolStatus: ChatToolRunRecord["status"];
  readonly webMode: ChatWebMode;
  readonly webLookupIntent?: boolean;
  readonly currentTurnBudgetMs: number;
  readonly currentCompletionTimeoutMs: number;
  readonly turnBudgetDeadline: number;
}): {
  turnBudgetDeadline: number;
  effectiveTurnBudgetMs: number;
  effectiveCompletionTimeoutMs: number;
} {
  if (
    input.webMode !== "auto" ||
    input.toolStatus !== "executed" ||
    !shouldExtendTurnBudgetForBrowserExecution(input.toolName)
  ) {
    return {
      turnBudgetDeadline: input.turnBudgetDeadline,
      effectiveTurnBudgetMs: input.currentTurnBudgetMs,
      effectiveCompletionTimeoutMs: input.currentCompletionTimeoutMs,
    };
  }
  const extendedTurnBudgetMs = isExpensiveChatTool(input.toolName)
    ? Math.max(input.currentTurnBudgetMs, input.webLookupIntent ? 90000 : 70000)
    : Math.max(input.currentTurnBudgetMs, 50000);
  const extendedCompletionTimeoutMs = isExpensiveChatTool(input.toolName)
    ? Math.max(input.currentCompletionTimeoutMs, input.webLookupIntent ? 40000 : 28000)
    : input.currentCompletionTimeoutMs;
  if (
    extendedTurnBudgetMs === input.currentTurnBudgetMs &&
    extendedCompletionTimeoutMs === input.currentCompletionTimeoutMs
  ) {
    return {
      turnBudgetDeadline: input.turnBudgetDeadline,
      effectiveTurnBudgetMs: input.currentTurnBudgetMs,
      effectiveCompletionTimeoutMs: input.currentCompletionTimeoutMs,
    };
  }
  return {
    turnBudgetDeadline: input.turnBudgetDeadline + (extendedTurnBudgetMs - input.currentTurnBudgetMs),
    effectiveTurnBudgetMs: extendedTurnBudgetMs,
    effectiveCompletionTimeoutMs: extendedCompletionTimeoutMs,
  };
}

export function shouldExtendTurnBudgetForBrowserExecution(toolName: string): boolean {
  return toolName === "browser.search" || isExpensiveChatTool(toolName);
}

export function createTurnBudgetDeadline(turnBudgetMs: number): number {
  return Date.now() + turnBudgetMs;
}

export function ensureChatTurnBudgetRemaining(deadline: number, webMode: ChatWebMode, turnBudgetMs: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new ChatTurnBudgetExceededError(webMode, turnBudgetMs);
  }
  return remaining;
}

export function buildTurnBudgetExceededReason(webMode: ChatWebMode, turnBudgetMs: number): string {
  if (webMode === "deep") {
    return `the deep-research response budget ran out after ${Math.floor(turnBudgetMs / 1000)} seconds`;
  }
  return `the response budget ran out after ${Math.floor(turnBudgetMs / 1000)} seconds to keep chat responsive`;
}

export function buildUserSafeFailureMessage(failure: ChatTurnFailureRecord): string {
  switch (failure.failureClass) {
    case "provider_timeout":
      return "The model request timed out before completion. Retry once, or switch to a lighter mode for faster results.";
    case "network_interrupted":
      return "The request was interrupted before the turn could finish. Retry once and check the gateway connection if it happens again.";
    case "tool_blocked":
      return "A required source blocked automated access. Retry with a narrower request, or continue from the strongest leads already gathered.";
    case "tool_failed":
      return "A required tool failed before the turn could finish. Retry once, or narrow the request so it can complete without that tool path.";
    case "auth_required":
      return "The selected provider or integration needs valid auth before this turn can continue. Reconnect auth or choose another provider.";
    case "tool_loop_guard":
      return "This turn stopped after the tool loop guard detected repeated low-progress tool work. Narrow the request or continue from the strongest evidence already gathered.";
    case "global_circuit_breaker":
      return "This turn stopped after repeated tool failures tripped the circuit breaker. Retry with a narrower request or continue from the strongest evidence already gathered.";
    case "tool_run_budget_exceeded":
      return "This turn hit the current tool-run budget before a full pass finished. Narrow the request or continue from the strongest leads already gathered.";
    case "turn_budget_exceeded":
    case "budget_exceeded":
      return "This turn hit the current execution budget before a full pass finished. Continue from the strongest leads or switch to a deeper mode.";
    case "approval_required":
      return "This turn is waiting for approval before it can continue.";
    case "interrupted_by_restart":
      return "The gateway restarted while this turn was running, so it never finished. Retry to run it again.";
    default:
      return "This turn failed before completion. Retry once, or narrow the request so the next pass can finish cleanly.";
  }
}

export function buildTurnBudgetExceededFallbackMessage(input: {
  readonly turnInput: {
    readonly content: string;
    readonly webMode: ChatWebMode;
  };
  readonly toolRuns: ChatToolRunRecord[];
  readonly turnBudgetMs: number;
  readonly fallbackBuilders: {
    buildFetchedContentBudgetFallback(
      webMode: ChatWebMode,
      toolRuns: ChatToolRunRecord[],
      userPrompt: string,
    ): string | undefined;
    buildSearchResultBudgetFallback(webMode: ChatWebMode, toolRuns: ChatToolRunRecord[]): string | undefined;
    buildDeterministicToolSynthesisFallback(content: string, toolRuns: ChatToolRunRecord[], reason: string): string;
  };
}): string {
  const fetchedContentFallback = input.fallbackBuilders.buildFetchedContentBudgetFallback(
    input.turnInput.webMode,
    input.toolRuns,
    input.turnInput.content,
  );
  if (fetchedContentFallback) {
    return fetchedContentFallback;
  }
  const searchFallback = input.fallbackBuilders.buildSearchResultBudgetFallback(
    input.turnInput.webMode,
    input.toolRuns,
  );
  if (searchFallback) {
    return searchFallback;
  }
  if (input.toolRuns.length > 0) {
    return input.fallbackBuilders.buildDeterministicToolSynthesisFallback(
      input.turnInput.content,
      input.toolRuns,
      buildTurnBudgetExceededReason(input.turnInput.webMode, input.turnBudgetMs),
    );
  }
  if (input.turnInput.webMode === "deep") {
    return "I ran out of time before I could finish that deep-research pass. Narrow the scope or split it into smaller follow-ups and I can continue.";
  }
  return "I stopped that turn to keep chat responsive. If you want a slower, more exhaustive pass, enable Deep research and resend it.";
}

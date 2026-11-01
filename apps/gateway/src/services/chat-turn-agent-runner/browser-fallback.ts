import { normalizeWebSearchEngineOrder } from "@goatcitadel/contracts";
import { isInternalInfrastructureSearchQuery } from "@goatcitadel/policy-engine";
import type {
  ChatToolRunRecord,
  McpInvokeRequest,
  McpInvokeResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import type { McpBrowserFallbackTarget } from "../mcp-runtime.js";
import type { ChatTurnAgentRunnerInput } from "../chat-turn-agent-runner.js";
import {
  buildBrowserFallbackArguments,
  buildBrowserFallbackChainEntry,
  classifyBrowserToolResult,
  normalizeBrowserToolResult,
  normalizeMcpBrowserToolResult,
  resolveBrowserFallbackToolName,
  withBrowserFallbackChain,
} from "../chat-agent-browser-results.js";
import { isDurableControlError } from "../durable-control-error.js";

export interface BrowserFallbackExecutorDeps {
  invokeTool: (
    request: ToolInvokeRequest,
    options?: { executionFence?: () => Promise<void> },
  ) => Promise<ToolInvokeResult>;
  invokeMcpTool?: (
    request: McpInvokeRequest,
    options?: { executionFence?: () => Promise<void> },
  ) => Promise<McpInvokeResponse>;
  listMcpBrowserFallbackTargets?: () => Promise<McpBrowserFallbackTarget[]>;
  getSearchEngineOrder?: () => readonly string[];
  buildPolicyContext: (input: Partial<ChatTurnAgentRunnerInput>) => ToolPolicyActorContext;
  listPriorToolRuns: (turnId: string) => Promise<ChatToolRunRecord[]>;
  selectRecentBrowserResultUrls: (
    userContent: string,
    toolRuns: ChatToolRunRecord[],
    minimumScore: number,
    limit: number,
  ) => string[];
}

function buildTurnExecutionOptions(
  turnInput: ChatTurnAgentRunnerInput,
): { executionFence: () => Promise<void> } | undefined {
  const canonicalWriteFence = turnInput.canonicalWriteFence;
  return canonicalWriteFence
    ? {
        executionFence: async () => {
          await canonicalWriteFence(() => undefined);
        },
      }
    : undefined;
}

function invokeTurnTool(
  deps: BrowserFallbackExecutorDeps,
  turnInput: ChatTurnAgentRunnerInput,
  request: ToolInvokeRequest,
): Promise<ToolInvokeResult> {
  const options = buildTurnExecutionOptions(turnInput);
  // Already a detached function: the runner copies it out of its own deps.
  const invokeTool = deps.invokeTool;
  return options ? invokeTool(request, options) : invokeTool(request);
}

function invokeTurnMcpTool(
  deps: BrowserFallbackExecutorDeps,
  turnInput: ChatTurnAgentRunnerInput,
  request: McpInvokeRequest,
): Promise<McpInvokeResponse> | undefined {
  const invokeMcpTool = deps.invokeMcpTool;
  if (!invokeMcpTool) {
    return undefined;
  }
  const options = buildTurnExecutionOptions(turnInput);
  return options ? invokeMcpTool(request, options) : invokeMcpTool(request);
}

export interface AlternateBuiltinBrowserFallbackInput {
  created: ChatToolRunRecord;
  turnInput: ChatTurnAgentRunnerInput;
  turnId: string;
  toolName: string;
  args: Record<string, unknown>;
  fallbackChain: Array<Record<string, unknown>>;
  classification: {
    failureClass?: string;
    error?: string;
  };
  normalizedResult?: Record<string, unknown>;
  error?: string;
  turnBudgetDeadline?: number;
  /** Effect-aware Chat invocation bound to the original tool-run fence. */
  invokeTool?: (request: ToolInvokeRequest) => Promise<ToolInvokeResult>;
}

export async function tryAlternateBuiltinBrowserResult(
  input: AlternateBuiltinBrowserFallbackInput,
  deps: BrowserFallbackExecutorDeps,
): Promise<Record<string, unknown> | undefined> {
  if (input.toolName === "browser.search") {
    return tryAlternateBuiltinSearchEngines(input, deps);
  }
  if (input.toolName !== "browser.navigate" && input.toolName !== "browser.extract" && input.toolName !== "http.get") {
    return undefined;
  }
  if (
    input.classification.failureClass !== "remote_blocked" &&
    input.classification.failureClass !== "http_error" &&
    input.classification.failureClass !== "unusable_output" &&
    input.classification.failureClass !== "runtime_error" &&
    input.classification.failureClass !== "rate_limited"
  ) {
    return undefined;
  }

  const syntheticCurrentFailure: ChatToolRunRecord = {
    ...input.created,
    status: "failed",
    args: input.args,
    error: input.classification.error ?? input.error ?? "browser execution failed",
    result: {
      ...(input.normalizedResult ?? {}),
      engineTier: input.normalizedResult?.engineTier ?? "builtin",
      engineLabel: input.normalizedResult?.engineLabel ?? "Built-in browser",
      browserFailureClass: input.classification.failureClass ?? "runtime_error",
    },
    finishedAt: new Date().toISOString(),
  };
  const priorToolRuns = (await deps.listPriorToolRuns(input.turnId)).filter(
    (run) => run.toolRunId !== input.created.toolRunId,
  );
  const alternateUrls = deps
    .selectRecentBrowserResultUrls(input.turnInput.content, [...priorToolRuns, syntheticCurrentFailure], 3, 1)
    .filter((url) => url !== input.args.url);

  for (const url of alternateUrls) {
    if (input.turnInput.signal?.aborted) {
      break;
    }
    if (input.turnBudgetDeadline && Date.now() >= input.turnBudgetDeadline) {
      break;
    }
    const alternateArgs = { ...input.args, url };
    try {
      const request: ToolInvokeRequest = {
        toolName: input.toolName,
        args: alternateArgs,
        agentId: "assistant",
        sessionId: input.turnInput.sessionId,
        taskId: input.turnInput.policyTaskId,
        runId: input.turnInput.policyRunId,
        surface: input.turnInput.mode,
        signal: input.turnInput.signal,
        permissionProfileId: input.turnInput.permissionProfileId,
        localOperatorOverrideId: input.turnInput.localOperatorOverrideId,
        consentContext: {
          operatorId: input.turnInput.operatorId,
          source: "agent",
          reason: `chat mode ${input.turnInput.mode}`,
        },
        policyContext: deps.buildPolicyContext(input.turnInput),
      };
      const result = input.invokeTool
        ? await input.invokeTool(request)
        : await invokeTurnTool(deps, input.turnInput, request);
      if (result.outcome !== "executed") {
        input.fallbackChain.push(
          buildBrowserFallbackChainEntry({
            toolName: input.toolName,
            engineTier: "builtin",
            engineLabel: "Built-in browser",
            result: { url, finalUrl: url },
            error: result.outcome === "blocked" ? result.policyReason : "browser fallback requires approval",
            browserFailureClass: "runtime_error",
            status: "failed",
          }),
        );
        continue;
      }
      const normalized = normalizeBrowserToolResult(input.toolName, result.result ?? {}, {
        engineTier: "builtin",
        engineLabel: "Built-in browser",
      });
      const classification = classifyBrowserToolResult(input.toolName, normalized);
      input.fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: input.toolName,
          engineTier: "builtin",
          engineLabel: "Built-in browser",
          result: normalized,
          error: classification.error,
          browserFailureClass: classification.failureClass,
          status: classification.failureClass ? "failed" : "executed",
        }),
      );
      if (!classification.failureClass) {
        return withBrowserFallbackChain(normalized, input.fallbackChain);
      }
    } catch (error) {
      if (isDurableControlError(error)) throw error;
      input.fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: input.toolName,
          engineTier: "builtin",
          engineLabel: "Built-in browser",
          result: { url, finalUrl: url },
          error: (error as Error).message,
          browserFailureClass: "runtime_error",
          status: "failed",
        }),
      );
    }
  }

  return undefined;
}

const NATIVE_SEARCH_TOTAL_FAILURE_MARKER = "browser.search failed:";
const SEARCH_QUERY_REFUSAL_MARKER = "browser.search refused:";

/**
 * True when native or Firecrawl search refused the query itself (internal infrastructure or a
 * secret). The policy engine may prefix the message with "execution error: ", so it is matched
 * anywhere. A refused query must never be retried on another engine or forwarded to MCP.
 */
export function isSearchQueryRefusal(text: string | undefined): boolean {
  return typeof text === "string" && text.includes(SEARCH_QUERY_REFUSAL_MARKER);
}
const NATIVE_SEARCH_ENGINE_FAILURE_PATTERN = /(?:^|[\s|:])(duckduckgo|bing|google):/g;

/**
 * Engines a search already tried. Prefers the structured `attemptedEngines` list; otherwise parses
 * native search's total-failure error (`browser.search failed: <engine>: <reason> | ...`).
 * The policy engine prefixes execution errors with "execution error: ", so the marker is matched anywhere.
 */
export function readAttemptedSearchEngines(
  result: Record<string, unknown> | undefined,
  error: string | undefined,
): string[] {
  const attempted = result?.attemptedEngines;
  if (Array.isArray(attempted) && attempted.every((entry) => typeof entry === "string")) {
    return (attempted as string[]).map((engine) => engine.toLowerCase());
  }
  const markerIndex = typeof error === "string" ? error.indexOf(NATIVE_SEARCH_TOTAL_FAILURE_MARKER) : -1;
  if (typeof error !== "string" || markerIndex < 0) {
    return [];
  }
  const engines = new Set<string>();
  const failureText = error.slice(markerIndex + NATIVE_SEARCH_TOTAL_FAILURE_MARKER.length);
  for (const match of failureText.matchAll(NATIVE_SEARCH_ENGINE_FAILURE_PATTERN)) {
    engines.add(match[1]!);
  }
  return [...engines];
}

async function tryAlternateBuiltinSearchEngines(
  input: AlternateBuiltinBrowserFallbackInput,
  deps: BrowserFallbackExecutorDeps,
): Promise<Record<string, unknown> | undefined> {
  if (
    input.classification.failureClass !== "no_results" &&
    input.classification.failureClass !== "remote_blocked" &&
    input.classification.failureClass !== "http_error" &&
    input.classification.failureClass !== "rate_limited" &&
    input.classification.failureClass !== "runtime_error"
  ) {
    return undefined;
  }

  // Only operator-enabled engines, in the operator's order. Without an explicit engine the search
  // already tried the configured default first, so retries start after it.
  const configuredEngines = normalizeWebSearchEngineOrder(deps.getSearchEngineOrder?.());
  const failedEngine = typeof input.args.engine === "string" ? input.args.engine : configuredEngines[0];
  // Native search walks every configured engine before it throws, so never repeat an attempted one.
  const attemptedEngines = new Set(
    readAttemptedSearchEngines(input.normalizedResult, input.classification.error ?? input.error),
  );
  const alternateEngines = configuredEngines.filter(
    (engine) => engine !== failedEngine && !attemptedEngines.has(engine.toLowerCase()),
  );
  if (alternateEngines.length === 0) {
    return undefined;
  }
  // Each retry is a native engine search: it must not repeat the same Firecrawl or official request.
  const alternateBackend = { backend: "native" };

  // A failed native retry walks the whole configured order too, so its failure text can exhaust the loop.
  const recordWalkedEngines = (failureText: string | undefined): void => {
    for (const walked of readAttemptedSearchEngines(undefined, failureText)) {
      attemptedEngines.add(walked);
    }
  };
  for (const engine of alternateEngines) {
    if (attemptedEngines.has(engine.toLowerCase())) {
      continue;
    }
    if (input.turnInput.signal?.aborted) {
      break;
    }
    if (input.turnBudgetDeadline && Date.now() >= input.turnBudgetDeadline) {
      break;
    }
    const alternateArgs = { ...input.args, ...alternateBackend, engine };
    try {
      const request: ToolInvokeRequest = {
        toolName: "browser.search",
        args: alternateArgs,
        agentId: "assistant",
        sessionId: input.turnInput.sessionId,
        taskId: input.turnInput.policyTaskId,
        runId: input.turnInput.policyRunId,
        surface: input.turnInput.mode,
        signal: input.turnInput.signal,
        permissionProfileId: input.turnInput.permissionProfileId,
        localOperatorOverrideId: input.turnInput.localOperatorOverrideId,
        consentContext: {
          operatorId: input.turnInput.operatorId,
          source: "agent",
          reason: `search engine fallback (${engine}) after ${input.classification.failureClass}`,
        },
        policyContext: deps.buildPolicyContext(input.turnInput),
      };
      const result = input.invokeTool
        ? await input.invokeTool(request)
        : await invokeTurnTool(deps, input.turnInput, request);
      if (result.outcome !== "executed") {
        if (isSearchQueryRefusal(result.policyReason)) {
          input.fallbackChain.push(
            buildBrowserFallbackChainEntry({
              toolName: "browser.search",
              engineTier: "builtin",
              engineLabel: `Built-in browser (${engine})`,
              error: result.policyReason,
              browserFailureClass: "runtime_error",
              status: "failed",
            }),
          );
          return undefined;
        }
        recordWalkedEngines(result.policyReason);
        input.fallbackChain.push(
          buildBrowserFallbackChainEntry({
            toolName: "browser.search",
            engineTier: "builtin",
            engineLabel: `Built-in browser (${engine})`,
            error: result.outcome === "blocked" ? result.policyReason : "search fallback did not execute",
            browserFailureClass: "runtime_error",
            status: "failed",
          }),
        );
        continue;
      }
      const normalized = normalizeBrowserToolResult("browser.search", result.result ?? {}, {
        engineTier: "builtin",
        engineLabel: `Built-in browser (${engine})`,
      });
      const classification = classifyBrowserToolResult("browser.search", normalized);
      input.fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: "browser.search",
          engineTier: "builtin",
          engineLabel: `Built-in browser (${engine})`,
          result: normalized,
          error: classification.error,
          browserFailureClass: classification.failureClass,
          status: classification.failureClass ? "failed" : "executed",
        }),
      );
      if (!classification.failureClass) {
        // The retry's own result says no fallback; the turn's search did fall back from the first engine.
        return withBrowserFallbackChain(
          {
            ...normalized,
            fallbackUsed: true,
            fallbackReason: input.classification.error ?? input.classification.failureClass,
          },
          input.fallbackChain,
        );
      }
    } catch (error) {
      if (isDurableControlError(error)) throw error;
      recordWalkedEngines((error as Error).message);
      input.fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: "browser.search",
          engineTier: "builtin",
          engineLabel: `Built-in browser (${engine})`,
          error: (error as Error).message,
          browserFailureClass: "runtime_error",
          status: "failed",
        }),
      );
      if (isSearchQueryRefusal((error as Error).message)) {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface McpBrowserFallbackInput {
  turnInput: ChatTurnAgentRunnerInput;
  toolName: string;
  args: Record<string, unknown>;
  fallbackChain: Array<Record<string, unknown>>;
  turnBudgetDeadline?: number;
  /** MCP invocation bound to the original Chat tool-run execution fence. */
  invokeMcpTool?: (request: McpInvokeRequest) => Promise<McpInvokeResponse>;
}

export async function tryBrowserFallbackAcrossMcpTiers(
  input: McpBrowserFallbackInput,
  deps: BrowserFallbackExecutorDeps,
): Promise<{ result: Record<string, unknown> } | undefined> {
  // Defense in depth: a query native search would refuse never leaves the machine through MCP either.
  if (input.toolName === "browser.search" && isInternalInfrastructureSearchQuery(String(input.args.query ?? ""))) {
    return undefined;
  }
  const targets = (await deps.listMcpBrowserFallbackTargets?.()) ?? [];
  for (const target of targets) {
    if (input.turnInput.signal?.aborted) {
      break;
    }
    if (input.turnBudgetDeadline && Date.now() >= input.turnBudgetDeadline) {
      break;
    }
    const resolvedToolName = resolveBrowserFallbackToolName(target, input.toolName);
    if (!resolvedToolName) {
      continue;
    }
    let response: McpInvokeResponse | undefined;
    try {
      const request: McpInvokeRequest = {
        serverId: target.serverId,
        toolName: resolvedToolName,
        arguments: buildBrowserFallbackArguments(input.toolName, input.args),
        agentId: "assistant",
        sessionId: input.turnInput.sessionId,
        signal: input.turnInput.signal,
      };
      response = input.invokeMcpTool
        ? await input.invokeMcpTool(request)
        : await invokeTurnMcpTool(deps, input.turnInput, request);
    } catch (mcpError) {
      if (isDurableControlError(mcpError)) throw mcpError;
      input.fallbackChain.push(
        buildBrowserFallbackChainEntry({
          toolName: resolvedToolName,
          engineTier: target.tier,
          engineLabel: target.label,
          error: (mcpError as Error).message,
          browserFailureClass: "runtime_error",
          status: "failed",
        }),
      );
      continue;
    }
    if (!response) {
      continue;
    }
    const normalized = response.output
      ? normalizeMcpBrowserToolResult(input.toolName, response.output, {
          engineTier: target.tier,
          engineLabel: target.label,
          args: input.args,
        })
      : undefined;
    const classification = classifyBrowserToolResult(input.toolName, normalized, response.error);
    input.fallbackChain.push(
      buildBrowserFallbackChainEntry({
        toolName: resolvedToolName,
        engineTier: target.tier,
        engineLabel: target.label,
        result: normalized,
        error: response.error,
        browserFailureClass: classification.failureClass,
        status: response.ok && !classification.failureClass ? "executed" : "failed",
      }),
    );
    if (!response.ok || !normalized || classification.failureClass) {
      continue;
    }
    return { result: withBrowserFallbackChain(normalized, input.fallbackChain) };
  }
  return undefined;
}

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

export interface BrowserFallbackExecutorDeps {
  invokeTool: (request: ToolInvokeRequest, options?: { executionFence?: () => void }) => Promise<ToolInvokeResult>;
  invokeMcpTool?: (request: McpInvokeRequest, options?: { executionFence?: () => void }) => Promise<McpInvokeResponse>;
  listMcpBrowserFallbackTargets?: () => McpBrowserFallbackTarget[];
  buildPolicyContext: (input: Partial<ChatTurnAgentRunnerInput>) => ToolPolicyActorContext;
  listPriorToolRuns: (turnId: string) => ChatToolRunRecord[];
  selectRecentBrowserResultUrls: (
    userContent: string,
    toolRuns: ChatToolRunRecord[],
    minimumScore: number,
    limit: number,
  ) => string[];
}

function buildTurnExecutionOptions(turnInput: ChatTurnAgentRunnerInput): { executionFence: () => void } | undefined {
  const canonicalWriteFence = turnInput.canonicalWriteFence;
  return canonicalWriteFence
    ? {
        executionFence: () => canonicalWriteFence(() => undefined),
      }
    : undefined;
}

function invokeTurnTool(
  deps: BrowserFallbackExecutorDeps,
  turnInput: ChatTurnAgentRunnerInput,
  request: ToolInvokeRequest,
): Promise<ToolInvokeResult> {
  const options = buildTurnExecutionOptions(turnInput);
  return options ? deps.invokeTool(request, options) : deps.invokeTool(request);
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
  const priorToolRuns = deps.listPriorToolRuns(input.turnId).filter((run) => run.toolRunId !== input.created.toolRunId);
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
      const result = await invokeTurnTool(deps, input.turnInput, {
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
      });
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

  const failedEngine = typeof input.args.engine === "string" ? input.args.engine : undefined;
  const alternateEngines = ["bing", "duckduckgo", "google"].filter((engine) => engine !== failedEngine);

  for (const engine of alternateEngines) {
    if (input.turnInput.signal?.aborted) {
      break;
    }
    if (input.turnBudgetDeadline && Date.now() >= input.turnBudgetDeadline) {
      break;
    }
    const alternateArgs = { ...input.args, engine };
    try {
      const result = await invokeTurnTool(deps, input.turnInput, {
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
      });
      if (result.outcome !== "executed") {
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
        return withBrowserFallbackChain(normalized, input.fallbackChain);
      }
    } catch (error) {
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
}

export async function tryBrowserFallbackAcrossMcpTiers(
  input: McpBrowserFallbackInput,
  deps: BrowserFallbackExecutorDeps,
): Promise<{ result: Record<string, unknown> } | undefined> {
  const targets = deps.listMcpBrowserFallbackTargets?.() ?? [];
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
      response = await invokeTurnMcpTool(deps, input.turnInput, {
        serverId: target.serverId,
        toolName: resolvedToolName,
        arguments: buildBrowserFallbackArguments(input.toolName, input.args),
        agentId: "assistant",
        sessionId: input.turnInput.sessionId,
        signal: input.turnInput.signal,
      });
    } catch (mcpError) {
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

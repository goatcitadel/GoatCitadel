import { describe, expect, it, vi } from "vitest";
import type {
  ChatToolRunRecord,
  McpInvokeRequest,
  McpInvokeResponse,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "../chat-turn-agent-runner.js";
import {
  isSearchQueryRefusal,
  readAttemptedSearchEngines,
  tryAlternateBuiltinBrowserResult,
  tryBrowserFallbackAcrossMcpTiers,
  type AlternateBuiltinBrowserFallbackInput,
  type BrowserFallbackExecutorDeps,
} from "./browser-fallback.js";

const SEARCH_REFUSAL =
  "browser.search refused: the query names internal infrastructure or a secret; remove it and search again.";

const NATIVE_TOTAL_FAILURE =
  "execution error: browser.search failed: duckduckgo: no usable results from browser page | bing: fallback returned no usable results | google: timed out";

function buildDeps(invokeTool: BrowserFallbackExecutorDeps["invokeTool"]): BrowserFallbackExecutorDeps {
  return {
    invokeTool,
    getSearchEngineOrder: () => ["duckduckgo", "bing", "google"],
    buildPolicyContext: () => ({}) as ReturnType<BrowserFallbackExecutorDeps["buildPolicyContext"]>,
    listPriorToolRuns: async () => [],
    selectRecentBrowserResultUrls: () => [],
  };
}

function buildInput(overrides: Partial<AlternateBuiltinBrowserFallbackInput>): AlternateBuiltinBrowserFallbackInput {
  return {
    created: { toolRunId: "run-1" } as ChatToolRunRecord,
    turnInput: { sessionId: "session-1", mode: "chat", content: "find things" } as ChatTurnAgentRunnerInput,
    turnId: "turn-1",
    toolName: "browser.search",
    args: { query: "goat citadel" },
    fallbackChain: [],
    classification: { failureClass: "runtime_error" },
    ...overrides,
  };
}

describe("readAttemptedSearchEngines", () => {
  it("reads engine names from a native total-failure error", () => {
    expect(readAttemptedSearchEngines(undefined, NATIVE_TOTAL_FAILURE)).toEqual(["duckduckgo", "bing", "google"]);
    expect(
      readAttemptedSearchEngines(
        undefined,
        "execution error: browser.search failed: duckduckgo: x | bing: y | google: z",
      ),
    ).toEqual(["duckduckgo", "bing", "google"]);
  });

  it("also reads a total-failure error without the execution-error prefix", () => {
    expect(readAttemptedSearchEngines(undefined, "browser.search failed: duckduckgo: x | bing: y | google: z")).toEqual(
      ["duckduckgo", "bing", "google"],
    );
  });

  it("lowercases structured engine names", () => {
    expect(readAttemptedSearchEngines({ attemptedEngines: ["DuckDuckGo"] }, undefined)).toEqual(["duckduckgo"]);
  });

  it("prefers the structured attemptedEngines list", () => {
    expect(readAttemptedSearchEngines({ attemptedEngines: ["firecrawl"] }, undefined)).toEqual(["firecrawl"]);
  });

  it("returns nothing for unrelated errors", () => {
    expect(readAttemptedSearchEngines(undefined, "network down")).toEqual([]);
    expect(readAttemptedSearchEngines(undefined, undefined)).toEqual([]);
    expect(readAttemptedSearchEngines({ attemptedEngines: "bing" }, undefined)).toEqual([]);
  });
});

describe("tryAlternateBuiltinBrowserResult for browser.search", () => {
  it("does not retry engines native search already attempted", async () => {
    const invokeTool = vi.fn<BrowserFallbackExecutorDeps["invokeTool"]>();
    const result = await tryAlternateBuiltinBrowserResult(
      buildInput({
        classification: { failureClass: "runtime_error", error: NATIVE_TOTAL_FAILURE },
        error: NATIVE_TOTAL_FAILURE,
      }),
      buildDeps(invokeTool),
    );
    expect(invokeTool).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("filters a differently cased attempted engine against the operator order", async () => {
    const invokeTool = vi.fn(
      async (_request: ToolInvokeRequest): Promise<ToolInvokeResult> =>
        ({ outcome: "blocked", policyReason: "test" }) as ToolInvokeResult,
    );
    await tryAlternateBuiltinBrowserResult(
      buildInput({
        classification: { failureClass: "no_results" },
        normalizedResult: { attemptedEngines: ["DuckDuckGo", "BING"], results: [] },
      }),
      buildDeps(invokeTool),
    );
    expect(invokeTool.mock.calls.map((call) => call[0].args.engine)).toEqual(["google"]);
  });

  it("still tries native engines after a Firecrawl-only empty result", async () => {
    const invokeTool = vi.fn(
      async (_request: ToolInvokeRequest): Promise<ToolInvokeResult> =>
        ({ outcome: "blocked", policyReason: "test" }) as ToolInvokeResult,
    );
    await tryAlternateBuiltinBrowserResult(
      buildInput({
        classification: { failureClass: "no_results" },
        normalizedResult: { attemptedEngines: ["firecrawl"], results: [] },
      }),
      buildDeps(invokeTool),
    );
    expect(invokeTool).toHaveBeenCalled();
    expect(invokeTool.mock.calls[0]?.[0].args.backend).toBe("native");
  });

  it("stops retrying once a failed native retry reports every engine it walked", async () => {
    const invokeTool = vi.fn(
      async (_request: ToolInvokeRequest): Promise<ToolInvokeResult> =>
        ({
          outcome: "blocked",
          policyReason: "execution error: browser.search failed: bing: x | duckduckgo: y | google: z",
        }) as ToolInvokeResult,
    );
    const fallbackChain: Array<Record<string, unknown>> = [];
    const result = await tryAlternateBuiltinBrowserResult(
      buildInput({
        classification: { failureClass: "no_results" },
        normalizedResult: { attemptedEngines: ["firecrawl"], results: [] },
        fallbackChain,
      }),
      buildDeps(invokeTool),
    );
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    expect(fallbackChain).toHaveLength(1);
  });

  it("stops retrying once a thrown native retry reports every engine it walked", async () => {
    const invokeTool = vi.fn(async (_request: ToolInvokeRequest): Promise<ToolInvokeResult> => {
      throw new Error(NATIVE_TOTAL_FAILURE);
    });
    const result = await tryAlternateBuiltinBrowserResult(
      buildInput({
        classification: { failureClass: "no_results" },
        normalizedResult: { attemptedEngines: ["firecrawl"], results: [] },
      }),
      buildDeps(invokeTool),
    );
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });
});

describe("search refusals", () => {
  it("recognizes a refusal with or without the execution-error prefix", () => {
    expect(isSearchQueryRefusal(SEARCH_REFUSAL)).toBe(true);
    expect(isSearchQueryRefusal(`execution error: ${SEARCH_REFUSAL}`)).toBe(true);
    expect(isSearchQueryRefusal(NATIVE_TOTAL_FAILURE)).toBe(false);
    expect(isSearchQueryRefusal(undefined)).toBe(false);
  });

  it("stops retrying engines once a native retry is refused", async () => {
    const invokeTool = vi.fn(
      async (_request: ToolInvokeRequest): Promise<ToolInvokeResult> =>
        ({ outcome: "blocked", policyReason: `execution error: ${SEARCH_REFUSAL}` }) as ToolInvokeResult,
    );
    const result = await tryAlternateBuiltinBrowserResult(
      buildInput({
        classification: { failureClass: "no_results" },
        normalizedResult: { attemptedEngines: ["brave"], results: [] },
      }),
      buildDeps(invokeTool),
    );
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  it("never sends an internal-infrastructure search to an MCP server", async () => {
    const invokeMcpTool = vi.fn(
      async (_request: McpInvokeRequest): Promise<McpInvokeResponse> =>
        ({ ok: true, output: { contentText: "results" } }) as McpInvokeResponse,
    );
    const deps: BrowserFallbackExecutorDeps = {
      ...buildDeps(vi.fn()),
      invokeMcpTool,
      listMcpBrowserFallbackTargets: async () => [
        { serverId: "srv-search", label: "Search MCP", tier: "browser_mcp", searchToolName: "mcp_search" },
      ],
    };
    const result = await tryBrowserFallbackAcrossMcpTiers(
      {
        turnInput: { sessionId: "session-1", mode: "chat", content: "find things" } as ChatTurnAgentRunnerInput,
        toolName: "browser.search",
        args: { query: "db01.corp outage" },
        fallbackChain: [],
      },
      deps,
    );
    expect(result).toBeUndefined();
    expect(invokeMcpTool).not.toHaveBeenCalled();
  });
});

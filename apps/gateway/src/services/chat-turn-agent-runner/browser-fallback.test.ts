import { describe, expect, it, vi } from "vitest";
import type { ChatToolRunRecord, ToolInvokeRequest, ToolInvokeResult } from "@goatcitadel/contracts";
import type { ChatTurnAgentRunnerInput } from "../chat-turn-agent-runner.js";
import {
  readAttemptedSearchEngines,
  tryAlternateBuiltinBrowserResult,
  type AlternateBuiltinBrowserFallbackInput,
  type BrowserFallbackExecutorDeps,
} from "./browser-fallback.js";

const NATIVE_TOTAL_FAILURE =
  "browser.search failed: duckduckgo: no usable results from browser page | bing: fallback returned no usable results | google: timed out";

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
    expect(readAttemptedSearchEngines(undefined, "browser.search failed: duckduckgo: x | bing: y | google: z")).toEqual(
      ["duckduckgo", "bing", "google"],
    );
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
});
